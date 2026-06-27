import Anthropic from '@anthropic-ai/sdk';
import { settings } from '@/stores/settings';
import type { Mode } from '@/types';
import { recordUsage, newPage, type Role } from '@/stores/usage';
import { modelInfo } from '@/models';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

// Structured reply for solution-caching modes: a learner-facing one-line `verdict`
// plus the worked `solution` (internal, cached) and a `problem` label so the cache
// knows which problem it belongs to.
const SOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'solution', 'verdict'],
  properties: {
    problem: { type: 'string' },
    solution: { type: 'string' },
    verdict: { type: 'string' },
  },
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Missing VITE_ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.');
    }
    // Bound each request so a stalled call can't freeze the feedback loop
    // (the default SDK timeout is 10 minutes).
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 30000, maxRetries: 1 });
  }
  return client;
}

let audioCtx: AudioContext | null = null;
const missingChimes = new Set<string>();

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Sends the current page to Claude and delivers the verdict.
 *
 * Cohesion is held across the many scans of one page by a session memory of the
 * distinct verdicts given so far; each request carries them as context so Claude
 * stays consistent (never re-flags a confirmed line, keeps reporting the same
 * first unresolved error until it is fixed). Audio is de-duplicated: a verdict is
 * only spoken/chimed when it differs from the last one delivered, so the same
 * correction is never replayed while you are still working on the fix.
 *
 * `resetSession()` starts a fresh page (call it when moving to a new problem).
 */
export function useFeedback() {
  // Distinct verdicts on the current page, oldest first.
  const history: string[] = [];
  let lastDelivered = '';
  // Session-scoped worked solution for the current problem. The solve model works
  // it out once; later scans verify against it on the cheap model. Cleared on
  // resetSession. `haikuUnreliable` flips on if the confirm model overturns the
  // cheap model's CORRECT — then the rest of THIS problem verifies on the confirm
  // model. Reset per problem.
  let cachedProblem = '';
  let cachedSolution = '';
  let haikuUnreliable = false;

  function buildContext(mode: Mode): string {
    if (history.length === 0) {
      return 'This is the first scan of this page of handwritten work. Assess it per your instructions.';
    }
    const list = history.map((h, i) => `${i + 1}. ${h}`).join('\n');
    const lines = [
      'Earlier feedback you gave on this same page (oldest first):',
      list,
      '',
      'The image below now shows that same work plus anything newly added beneath it.',
    ];
    if (mode.errorChecking === false) {
      // Summarising / non-grading mode: don't inject error-detector framing.
      lines.push('Continue per your instructions, staying consistent with what you already said.');
    } else {
      lines.push(
        'Stay consistent with what you already said: do not re-flag a line you previously confirmed as correct, and keep reporting the same first unresolved error until it has been fixed, then move on to the work that follows.',
        'If everything, including the new work, is valid, respond with exactly: CORRECT',
      );
    }
    return lines.join('\n');
  }

  function logUsage(resp: any, mode: Mode, model: string, role: Role): void {
    const u = resp?.usage ?? {};
    recordUsage({
      mode: mode.id,
      model,
      role,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
    });
  }

  async function getFeedback(imageDataUrl: string, mode: Mode): Promise<string> {
    const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(imageDataUrl);
    const mediaType = (match?.[1] ?? 'image/jpeg') as ImageMediaType;
    const data = match?.[2] ?? imageDataUrl.replace(/^data:[^,]*,/, '');
    return mode.cacheSolution
      ? getFeedbackCached(data, mediaType, mode)
      : getFeedbackSimple(data, mediaType, mode);
  }

  // Original one-shot path: solve and judge every scan. Used by modes that don't
  // cache a solution (chemistry, German, freeform).
  async function getFeedbackSimple(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    const effort = settings.api.solveEffort;
    const resp = await getClient().messages.create({
      model: settings.api.model,
      max_tokens: settings.api.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort } as any,
      system: mode.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: buildContext(mode) },
          ],
        },
      ],
    });
    logUsage(resp, mode, settings.api.model, 'verify');
    return (resp.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text as string)
      .join(' ')
      .trim();
  }

  // Per-request context for the solve-once-then-verify path. When a solution is
  // already cached we attach it and ask the model to verify against it (cheap);
  // otherwise we ask it to solve the problem and hand back the worked solution.
  function buildCachedContext(hasCache: boolean): string {
    const lines: string[] = [];
    if (history.length > 0) {
      lines.push('Earlier feedback you gave on this same page (oldest first):');
      lines.push(history.map((h, i) => `${i + 1}. ${h}`).join('\n'));
      lines.push('');
    }
    if (hasCache) {
      lines.push(
        `You already worked out the current problem ("${cachedProblem}"). Its correct solution is:`,
        cachedSolution,
        '',
        'The image shows the learner\'s current work plus anything newly added beneath it. Verify it against this known solution and keep reporting the same first unresolved step that diverges until it is fixed — do not re-derive the solution, and leave "solution" empty. Only if the learner has clearly moved to a DIFFERENT problem, solve that one yourself and return it in "solution" with its label in "problem".',
      );
    } else {
      lines.push(
        'No solution has been worked out for the current problem yet. Identify the problem the learner is working on, solve it completely yourself, and return the full worked solution in "solution" with a short label in "problem". If the problem statement is still incomplete or you cannot determine it, leave "solution" empty and answer OK in "verdict".',
      );
    }
    return lines.join('\n');
  }

  // One structured call to a given model. Cheap models (e.g. Haiku) don't take the
  // effort parameter or adaptive thinking, so those are omitted for them.
  async function callModel(
    model: string,
    effort: string | null,
    role: Role,
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
    text: string,
  ): Promise<{ problem: string; solution: string; verdict: string }> {
    const info = modelInfo(model);
    const useEffort = info.effort && !!effort;
    const output_config: any = { format: { type: 'json_schema', schema: SOLUTION_SCHEMA } };
    if (useEffort) output_config.effort = effort;
    const params: any = {
      model,
      max_tokens: settings.api.maxTokens,
      system: mode.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text },
          ],
        },
      ],
      output_config,
    };
    if (useEffort) params.thinking = { type: 'adaptive' };

    const resp = await getClient().messages.create(params);
    logUsage(resp, mode, model, role);
    const out = (resp.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text as string)
      .join('')
      .trim();
    try {
      const p = JSON.parse(out) as { problem?: string; solution?: string; verdict?: string };
      return {
        problem: (p.problem ?? '').trim(),
        solution: (p.solution ?? '').trim(),
        verdict: (p.verdict ?? '').trim(),
      };
    } catch {
      return { problem: '', solution: '', verdict: out };
    }
  }

  // Learner moved to a different problem than the cached one → drop the cache so
  // the next scan re-solves on the solve model, and trust the cheap verifier again
  // for the new problem. Returns true if a switch was detected.
  function handleProblemSwitch(prob: string): boolean {
    if (prob && cachedProblem && prob !== cachedProblem) {
      cachedProblem = '';
      cachedSolution = '';
      haikuUnreliable = false;
      return true;
    }
    return false;
  }

  // Tiered solve-then-verify path:
  //   solve   — first solvable scan: the solve model works it out once and caches it.
  //   verify  — every later scan: a cheap model checks progress against the cache.
  //   confirm — when the cheap model says CORRECT, the confirm model re-checks the
  //             final answer before it chimes; if it disagrees, the cheap model is
  //             marked unreliable and the rest of THIS problem verifies on the
  //             confirm model.
  async function getFeedbackCached(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    // SOLVE — no cached solution yet.
    if (cachedSolution === '') {
      const r = await callModel(
        settings.api.solveModel,
        settings.api.solveEffort,
        'solve',
        data,
        mediaType,
        mode,
        buildCachedContext(false),
      );
      if (r.solution) {
        cachedProblem = r.problem || cachedProblem;
        cachedSolution = r.solution;
      }
      return r.verdict;
    }

    // DEMOTED — the cheap verifier was caught wrong on this problem → use confirm model.
    if (haikuUnreliable) {
      const r = await callModel(
        settings.api.confirmModel,
        settings.api.confirmEffort,
        'confirm',
        data,
        mediaType,
        mode,
        buildCachedContext(true),
      );
      return handleProblemSwitch(r.problem) ? 'OK' : r.verdict;
    }

    // VERIFY — cheap model checks progress against the cached solution.
    const r = await callModel(
      settings.api.verifyModel,
      null,
      'verify',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    if (handleProblemSwitch(r.problem)) return 'OK';
    if (!isCorrect(r.verdict)) return r.verdict;

    // The cheap model thinks it's done — re-check the final answer on the confirm
    // model before chiming CORRECT.
    const c = await callModel(
      settings.api.confirmModel,
      settings.api.confirmEffort,
      'confirm',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    if (handleProblemSwitch(c.problem)) return 'OK';
    if (isCorrect(c.verdict)) return c.verdict; // confirmed
    // The confirm model disagrees — the cheap one was wrong. Stop trusting it on
    // this problem and deliver the confirm model's hint instead.
    haikuUnreliable = true;
    return c.verdict;
  }

  /** Commit a verdict to the page's session memory (kept distinct). */
  function recordVerdict(text: string): void {
    if (!text || isQuiet(text)) return;
    const key = normalize(text);
    if (!history.some((h) => normalize(h) === key)) {
      history.push(text);
      // Keep only the last few verdicts as context — enough for consistency,
      // small enough to keep re-sent input down on every scan.
      if (history.length > 4) history.shift();
    }
  }

  function isCorrect(text: string): boolean {
    return /^\s*correct\b/i.test(text);
  }

  // "OK" = correct so far / nothing to report yet. Produces no audio and is not
  // recorded — keeps the tool silent while the learner is progressing correctly.
  function isQuiet(text: string): boolean {
    return /^\s*ok[.!]?\s*$/i.test(text);
  }

  // Identity used to suppress replayed audio. A "Step N: ..." correction keys on
  // the step, so a reworded hint for the same unfixed step is not replayed.
  function deliveryKey(text: string): string {
    const step = /^\s*(step\s+\d+)\b/i.exec(text);
    return step ? step[1].toLowerCase().replace(/\s+/g, ' ') : normalize(text);
  }

  function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.audio.voiceLang;
    utterance.rate = settings.audio.rate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function synthTone(correct: boolean): void {
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      const now = audioCtx.currentTime;
      const notes = correct ? [660, 880] : [220];
      notes.forEach((freq, i) => {
        const osc = audioCtx!.createOscillator();
        const gain = audioCtx!.createGain();
        osc.type = correct ? 'sine' : 'square';
        osc.frequency.value = freq;
        const t = now + i * 0.12;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain).connect(audioCtx!.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    } catch {
      /* ignore audio errors */
    }
  }

  function playChime(correct: boolean): void {
    const file = correct ? settings.audio.chimeCorrect : settings.audio.chimeError;
    if (file && !missingChimes.has(file)) {
      const audio = new Audio(import.meta.env.BASE_URL + file);
      audio.play().catch(() => {
        missingChimes.add(file);
        synthTone(correct);
      });
      return;
    }
    synthTone(correct);
  }

  /**
   * Deliver a verdict as audio, unless it is identical to the last delivered one
   * (prevents the same correction being replayed while you keep writing).
   * Returns true if it actually played.
   */
  function deliver(text: string, mode: Mode): boolean {
    if (!text || isQuiet(text)) return false;
    if (lastDelivered && deliveryKey(text) === deliveryKey(lastDelivered)) return false;
    lastDelivered = text;
    if (mode.feedbackStyle === 'chime' || mode.feedbackStyle === 'both') {
      playChime(isCorrect(text));
    }
    if (mode.feedbackStyle === 'spoken' || mode.feedbackStyle === 'both') {
      speak(text);
    }
    return true;
  }

  /** Start a fresh page: forget prior verdicts and stop any in-flight speech. */
  function resetSession(): void {
    history.length = 0;
    lastDelivered = '';
    cachedProblem = '';
    cachedSolution = '';
    haikuUnreliable = false;
    newPage();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  return { getFeedback, recordVerdict, deliver, resetSession, speak, playChime, isCorrect, isQuiet };
}
