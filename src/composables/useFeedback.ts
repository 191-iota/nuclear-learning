import Anthropic from '@anthropic-ai/sdk';
import { settings } from '@/stores/settings';
import type { Mode } from '@/types';
import { recordUsage, newPage, type Role } from '@/stores/usage';
import { addLesson } from '@/stores/lessons';
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

// Feedback language. `settings.api.feedbackLang` selects the language of the
// learner-facing verdict. The control tokens OK and CORRECT stay literal so the
// chime/silence logic keeps working; only the spoken hint is translated.
const GERMAN_GRADING =
  'Write the learner-facing verdict in German (Swiss Hochdeutsch, use "ss" not "ß"). Start an error hint with "Schritt [N]:" rather than "Step [N]:". Keep the control words OK and CORRECT exactly as written; never translate them.';
const GERMAN_PLAIN = 'Write your reply to the learner in German (Swiss Hochdeutsch, use "ss" not "ß").';

function langLine(mode: Mode): string {
  if (settings.api.feedbackLang !== 'German') return '';
  return mode.errorChecking === false ? GERMAN_PLAIN : GERMAN_GRADING;
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
  // it out once and this LATCHES, later scans verify against it on the cheap model
  // and it is never re-solved until resetSession (Clear). `haikuUnreliable` flips on
  // if the confirm model overturns the cheap model's CORRECT, then the rest of THIS
  // problem verifies on the confirm model.
  let cachedSolution = '';
  let cachedProblem = '';
  let haikuUnreliable = false;
  // One lesson per problem: set once a corrected mistake is logged this session.
  let lessonCaptured = false;
  // Automatic-routing only: cached difficulty class for the current problem.
  let complexity = '';

  function buildContext(mode: Mode): string {
    const lang = langLine(mode);
    if (history.length === 0) {
      const first =
        'This is the first scan of this page of handwritten work. Assess it per your instructions.';
      return lang ? `${first}\n\n${lang}` : first;
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
    if (lang) lines.push('', lang);
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
    const verdict = await (mode.cacheSolution
      ? getFeedbackCached(data, mediaType, mode)
      : getFeedbackSimple(data, mediaType, mode));
    maybeCaptureLesson(verdict, mode);
    return verdict;
  }

  // The most recent flagged error still in session memory, the mistake the
  // learner just had to fix. Skips OK / CORRECT lines.
  function lastError(): string {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!isQuiet(h) && !isCorrect(h)) return h;
    }
    return '';
  }

  // Zero-cost lesson capture: the moment a problem turns CORRECT after an error,
  // the error verdict (and, for caching modes, the problem label + worked
  // solution) is already in hand from this very scan, log it for review. One per
  // problem; nothing is captured when the work was right the first time.
  function maybeCaptureLesson(verdict: string, mode: Mode): void {
    if (lessonCaptured || mode.errorChecking === false) return;
    if (!isCorrect(verdict)) return;
    const mistake = lastError();
    if (!mistake) return;
    lessonCaptured = true;
    addLesson({
      mode: mode.id,
      modeLabel: mode.label,
      problem: cachedProblem,
      mistake,
      solution: cachedSolution,
    });
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
        'The correct solution to the current problem is:',
        cachedSolution,
        '',
        'The image shows the learner\'s current work. Verify RESULT-FIRST: if their final answer matches the known solution, respond CORRECT even if an earlier line looks off; only flag a step when one of their results actually disagrees with the known solution, and read what they actually wrote rather than guessing a formula. Do not re-derive; leave "solution" empty.',
      );
    } else {
      lines.push(
        'No solution has been worked out for the current problem yet. Identify the problem the learner is working on, solve it completely yourself, and return the full worked solution in "solution" with a short label in "problem". If the problem statement is still incomplete or you cannot determine it, leave "solution" empty and answer OK in "verdict".',
      );
    }
    if (settings.api.feedbackLang === 'German') lines.push('', GERMAN_GRADING);
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

  // Automatic routing: a cheap model judges whether the posed problem is simple or
  // multi-step (once), which selects the solve effort. Biased toward "complex" when
  // unsure, since a complex problem solved at low effort poisons every later check.
  async function classify(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    const model = settings.api.classifyModel;
    const info = modelInfo(model);
    // Plain one-word reply (no structured output, keeps it robust on cheap models).
    const params: any = {
      model,
      max_tokens: 16,
      system:
        'You classify a handwritten math problem by difficulty. Judge the PROBLEM being posed, not the learner\'s working. Reply with EXACTLY ONE word and nothing else: "simple" for a one- or two-step problem, "complex" for a multi-step problem, or "unready" if the problem statement is not yet fully written or you cannot tell. If unsure between simple and complex, reply complex.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: 'One word: simple, complex, or unready.' },
          ],
        },
      ],
    };
    if (info.effort) params.thinking = { type: 'adaptive' };
    try {
      const resp = await getClient().messages.create(params, { timeout: 12000 });
      logUsage(resp, mode, model, 'classify');
      const out = (resp.content as any[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join(' ')
        .toLowerCase();
      if (out.includes('complex')) return 'complex';
      if (out.includes('simple')) return 'simple';
      if (out.includes('unready')) return 'unready';
      return 'complex';
    } catch (err) {
      // Never let a classify failure stall the scan, fall through to a complex
      // (medium) solve, which is the safe default.
      console.warn('[nuclear-learning] classify failed, defaulting to complex:', err);
      return 'complex';
    }
  }

  // Automatic routing path: classify once → solve on the strong model at the
  // complexity-gated effort (low for simple, solveEffort for complex) → check every
  // later scan on the strong model at confirmEffort. All on the solve model; no
  // cheap-verify tier and no separate confirm gate.
  async function getFeedbackAuto(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    if (complexity === '') {
      const cls = await classify(data, mediaType, mode);
      if (cls !== 'simple' && cls !== 'complex') return 'OK'; // problem not complete yet
      complexity = cls;
    }
    if (cachedSolution === '') {
      const effort = complexity === 'complex' ? settings.api.solveEffort : 'low';
      const r = await callModel(
        settings.api.solveModel,
        effort,
        'solve',
        data,
        mediaType,
        mode,
        buildCachedContext(false),
      );
      if (r.solution) cachedSolution = r.solution;
      if (r.problem) cachedProblem = r.problem;
      return r.verdict;
    }
    const r = await callModel(
      settings.api.solveModel,
      settings.api.confirmEffort,
      'verify',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    return r.verdict;
  }

  // Tiered solve-then-verify path. The solve step runs only until a solution is
  // cached. Once solved it LATCHES: the problem is never solved again for the rest
  // of the session (Clear moves to a new problem). The verify step runs every later
  // scan, where a cheap model checks progress against the cache. The confirm step
  // runs when the cheap model says CORRECT: the confirm model re-checks the final
  // answer before it chimes. If it disagrees, the cheap model is marked unreliable
  // and the rest of THIS problem verifies on the confirm model.
  async function getFeedbackCached(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    if (settings.api.routing === 'auto') return getFeedbackAuto(data, mediaType, mode);

    // SOLVE, only while there is no cached solution. Latches once solved.
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
      if (r.solution) cachedSolution = r.solution;
      if (r.problem) cachedProblem = r.problem;
      return r.verdict;
    }

    // DEMOTED, the cheap verifier was caught wrong on this problem → use confirm model.
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
      return r.verdict;
    }

    // VERIFY, cheap model checks progress against the cached solution. The effort
    // is applied only if the verify model supports it (ignored for e.g. Haiku).
    const r = await callModel(
      settings.api.verifyModel,
      settings.api.verifyEffort,
      'verify',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    if (!isCorrect(r.verdict)) return r.verdict;

    // The cheap model thinks it's done, re-check the final answer on the confirm
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
    if (isCorrect(c.verdict)) return c.verdict; // confirmed
    // The confirm model disagrees, the cheap one was wrong. Stop trusting it on
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
      // Keep only the last few verdicts as context, enough for consistency,
      // small enough to keep re-sent input down on every scan.
      if (history.length > 4) history.shift();
    }
  }

  function isCorrect(text: string): boolean {
    return /^\s*correct\b/i.test(text);
  }

  // "OK" = correct so far / nothing to report yet. Produces no audio and is not
  // recorded, keeps the tool silent while the learner is progressing correctly.
  function isQuiet(text: string): boolean {
    return /^\s*ok[.!]?\s*$/i.test(text);
  }

  // Identity used to suppress replayed audio. A "Step N: ..." correction keys on
  // the step, so a reworded hint for the same unfixed step is not replayed.
  function deliveryKey(text: string): string {
    const step = /^\s*((?:step|schritt)\s+\d+)\b/i.exec(text);
    return step ? step[1].toLowerCase().replace(/\s+/g, ' ') : normalize(text);
  }

  function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.api.feedbackLang === 'German' ? 'de-DE' : settings.audio.voiceLang;
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
    cachedSolution = '';
    cachedProblem = '';
    haikuUnreliable = false;
    lessonCaptured = false;
    complexity = '';
    newPage();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  return { getFeedback, recordVerdict, deliver, resetSession, speak, playChime, isCorrect, isQuiet };
}
