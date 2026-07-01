import OpenAI from 'openai';
import { settings } from '@/stores/settings';
import { mathToSpeech } from '@/mathSpeech';
import type { Mode } from '@/types';
import { recordUsage, newPage, type Role } from '@/stores/usage';
import { addLesson } from '@/stores/lessons';
import { modelInfo } from '@/models';
import { applySkillPacket, type SkillPacket, type KCObservation } from '@/stores/skills';
import { KC_IDS, SKILL_ASSESSOR } from '@/kc';
import { generateLessonCard } from '@/lessonCard';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

// Structured reply for solution-caching modes: a learner-facing one-line `verdict`
// plus the worked `solution` (internal, cached) and a `problem` label so the cache
// knows which problem it belongs to. `correction` is filled only when a problem
// turns CORRECT after a flagged mistake: a clean, LaTeX-formatted statement of what
// was wrong and the right version, stored on the lesson for later review (never
// spoken). It is required by the schema but left empty ("") when not applicable,
// the same way `solution` is empty on a verify scan.
const SOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'solution', 'verdict', 'correction'],
  properties: {
    problem: { type: 'string' },
    solution: { type: 'string' },
    verdict: { type: 'string' },
    correction: {
      type: 'object',
      additionalProperties: false,
      required: ['wrong', 'right'],
      properties: {
        wrong: { type: 'string' },
        right: { type: 'string' },
      },
    },
  },
};

// Tagging schema: SOLUTION_SCHEMA plus the skill-mastery fields. Used only on the
// Opus calls that already fire once per problem (solve + confirm/resolution), so the
// skill map costs zero extra requests. The cheap per-scan verify uses SOLUTION_SCHEMA
// instead, so the 125-id enum is never sent on the repetitive middle scans. `signal`
// carries a 'none' sentinel for membership-only (in-progress) emissions; `difficulty`
// is always present (the model gives its best estimate even when skills is empty).
const SKILL_SOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'solution', 'verdict', 'correction', 'difficulty', 'skills'],
  properties: {
    ...SOLUTION_SCHEMA.properties,
    difficulty: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'signal'],
        properties: {
          id: { type: 'string', enum: KC_IDS },
          role: { type: 'string', enum: ['core', 'support'] },
          signal: { type: 'string', enum: ['none', 'clean', 'shaky', 'wrong'] },
        },
      },
    },
  },
};

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing VITE_OPENAI_API_KEY. Copy .env.example to .env and add your key.');
    }
    // Bound each request so a stalled call can't freeze the feedback loop.
    // Reasoning models legitimately take 30-90s at medium/high effort, so the timeout is generous.
    client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 90000, maxRetries: 1 });
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
  // Every distinct verdict already spoken this problem, so a correction is heard once and the
  // graders re-flagging the same step on later scans (the corner mark stays on the page) never
  // replays it.
  const spokenKeys = new Set<string>();
  // Session-scoped worked solution for the current problem. The solve model works
  // it out once and this LATCHES, later scans verify against it on the cheap model
  // and it is never re-solved until resetSession (Clear).
  let cachedSolution = '';
  let cachedProblem = '';
  // One lesson per problem: set once a corrected mistake is logged this session.
  let lessonCaptured = false;
  // Latest learner-facing correction emitted on this page (what was wrong + the
  // right version, LaTeX). Set by the resolving Opus call, read by the lesson
  // capture so the review card shows a real, rendered correction, not the cryptic
  // live hint. Cleared on resetSession.
  let lastCorrection: { wrong: string; right: string } | null = null;
  // Skill-map capture state for the page. `skillMembership` is the id+role set the
  // SOLVE call tagged (no signal yet); `skillApplied` latches once real per-skill
  // signal has been deposited; `pageReachedCorrect` and `lastSteps` feed the resolve
  // and abandon paths. None of this is sent back to the model.
  let skillMembership: SkillPacket | null = null;
  let skillApplied = false;
  let pageReachedCorrect = false;
  let lastSteps = 0;

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
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0, // includes reasoning tokens
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0, // OpenAI has no separate cache-write charge
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
  // An illegibility prompt ("Can't read step N, rewrite it.") is not a learnable mistake, so it must
  // never seed a lesson; lastError skips it and finds the last REAL flagged error instead.
  function isReadNudge(text: string): boolean {
    return /can.?t read|rewrite it|illegible|unleserlich|nicht lesen/i.test(text);
  }

  function lastError(): string {
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!isQuiet(h) && !isCorrect(h) && !isReadNudge(h)) return h;
    }
    return '';
  }

  // Lesson capture: the moment a problem turns CORRECT after an error, the error and
  // the worked solution are already in hand from this scan. One per problem; nothing
  // is captured when the work was right the first time. The card itself is written by
  // a dedicated gpt-5.4-mini call (a specific recall question, not the cryptic live nudge);
  // that runs fire-and-forget so the chime is never delayed, and the inputs are snap-
  // shotted now because the session state may move on before it resolves.
  function maybeCaptureLesson(verdict: string, mode: Mode): void {
    if (lessonCaptured || mode.errorChecking === false) return;
    if (!isCorrect(verdict)) return;
    const mistake = lastError();
    if (!mistake) return;
    lessonCaptured = true;
    void buildAndAddLesson({
      modeId: mode.id,
      modeLabel: mode.label,
      problem: cachedProblem,
      mistake,
      solution: cachedSolution,
      wrong: lastCorrection?.wrong ?? '',
      right: lastCorrection?.right ?? '',
    });
  }

  async function buildAndAddLesson(input: {
    modeId: string;
    modeLabel: string;
    problem: string;
    mistake: string;
    solution: string;
    wrong: string;
    right: string;
  }): Promise<void> {
    const card = await generateLessonCard({
      problem: input.problem,
      mistake: input.mistake,
      solution: input.solution,
      wrong: input.wrong,
      right: input.right,
      mode: input.modeId,
    });
    addLesson({
      mode: input.modeId,
      modeLabel: input.modeLabel,
      problem: input.problem,
      mistake: input.mistake,
      solution: input.solution,
      wrong: input.wrong,
      right: input.right,
      front: card?.front ?? '',
      back: card?.back ?? '',
    });
  }

  // ---- skill-map capture helpers ----
  type Reply = Awaited<ReturnType<typeof callModel>>;

  // Number of checklist lines in the cached solution, an objective difficulty signal.
  function solutionSteps(): number {
    return cachedSolution.split('\n').filter((s) => s.trim()).length;
  }

  // The SOLVE call's tags become the page's sticky membership (id + role, no signal).
  // It is the fallback the abandon hook deposits against if the page never resolves.
  function recordMembership(r: Reply): void {
    if (!settings.api.trackSkills || skillMembership || !r.skills?.length) return;
    skillMembership = {
      difficulty: r.difficulty,
      skills: r.skills.map((o) => ({ id: o.id, role: o.role })),
    };
  }

  // A resolving CORRECT carries real per-skill signal; fold it into the estimator once.
  function captureSkills(r: Reply): void {
    pageReachedCorrect = true;
    if (settings.api.trackSkills && !skillApplied && r.skills?.length) {
      applySkillPacket({ difficulty: r.difficulty, skills: r.skills }, lastSteps, Date.now());
      skillApplied = true;
    }
  }

  // Original one-shot path: solve and judge every scan. Used by modes that don't
  // cache a solution (chemistry, German, freeform).
  async function getFeedbackSimple(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    const resp = await getClient().chat.completions.create({
      model: settings.api.model,
      max_completion_tokens: settings.api.maxTokens,
      reasoning_effort: settings.api.verifyEffort,
      messages: [
        { role: 'system', content: mode.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildContext(mode) },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
          ],
        },
      ],
    } as any);
    logUsage(resp, mode, settings.api.model, 'verify');
    return (resp.choices?.[0]?.message?.content ?? '').trim();
  }

  // Per-request context for the solve-once-then-verify path. When a solution is
  // already cached we attach it and ask the model to verify against it (cheap);
  // otherwise we ask it to solve the problem and hand back the worked solution.
  function buildCachedContext(hasCache: boolean): string {
    const lines: string[] = [];
    if (history.length > 0) {
      lines.push(
        'Feedback you gave EARLIER on this same page (oldest first). The learner may have since fixed some of these, so check each one against the CURRENT work: if a step you flagged now follows correctly, it is FIXED — do NOT report it again and do NOT let it keep you from OK/CORRECT. Only re-report an error that is STILL wrong in what is written now.',
      );
      lines.push(history.map((h, i) => `${i + 1}. ${h}`).join('\n'));
      lines.push('');
    }
    if (hasCache) {
      lines.push(
        'The correct solution to the current problem is:',
        cachedSolution,
        '',
        'Judge the work RESULT-FIRST against the known solution: check every line the learner has fully written, and the moment a completed line or equality does not follow correctly from the line before it (a wrong manipulation, a sign error, a bad step), name that first diverging step in one short sentence, reading what the learner actually wrote rather than guessing a formula. The learner may simplify or rearrange by a DIFFERENT valid route than the solution above, so judge each line by whether it follows algebraically from the learner\'s OWN previous line, not by whether it matches the route above. Do NOT wait for a final answer to flag a clear mistake. A final result MATCHES the known solution when it is algebraically EQUAL, not identical in form (equal after expanding, factoring, a common denominator, cancelling, or flipping the overall sign, so a(2w-v)/(-2w-kv) = a(v-2w)/(kv+2w)); check equality by normalising both or substituting test numbers, and do NOT drop to OK over a sign or form difference you have not actually checked. Respond CORRECT ONLY when every sub-part label on the page (a, b, c, ...) has an answer, each answered sub-part carries its own clearly-marked result, and every error flagged earlier has been fixed; otherwise, when the work so far is correct, respond OK. Give no advice or encouragement of any kind. Do not re-derive; leave "solution" empty.',
        'Respond OK only while the NEWEST line is still visibly being written (a partial, unfinished expression); once a line is fully written down, judge it. A line the learner marked "falsch" or struck through and redirected with an arrow to a redo is finished business: NEVER report that mistake again, follow the arrow, and stay OK while the redo is in progress. Report any one correction only once, then stay OK while the learner works on the fix.',
        'CORRECTION (stored for the learner\'s later review, never spoken): if your verdict is CORRECT and the earlier feedback above had flagged a mistake the learner has since fixed, fill `correction.wrong` with the specific error they made and `correction.right` with the corrected version, each ONE short line, writing every mathematical expression in LaTeX between single $ delimiters (for example $\\overline{a\\cdot b}=\\bar a+\\bar b$). This field is for review only, so naming the right answer here is fine and does not change your verdict. If there was no earlier mistake, leave both empty.',
      );
    } else {
      lines.push(
        'No solution has been worked out for the current problem yet. The PROBLEM is the ORIGINAL expression or task the learner started from: the first, topmost line, before any "=" sign and before any reworking. A task like "Vereinfachen" (simplify) or "nach b auflösen" (solve for b) applies to THAT original expression. Everything the learner wrote after it (later lines, equalities, crossed-out reworkings) is their ATTEMPT to be graded, never part of the problem, so NEVER take a later or reworked line as the given. Solve that original problem completely yourself from scratch, and return the full worked solution in "solution" with a short label in "problem" (keep it ready even on a scan where you stay silent). If the original statement is still incomplete or you cannot determine it, leave "solution" empty.',
        'Then grade the current work against the solution you just derived: check every fully-written line, and the moment a completed line or equality does not follow correctly from the one before it, name that first diverging step; do not wait for a final answer to flag a clear mistake. Respond CORRECT ONLY when every sub-part is answered with its own clearly-marked result and every earlier error is fixed; otherwise, when the work so far is correct, OK. Give no advice.',
        'Respond OK only while the newest line is still visibly being written. A line the learner marked "falsch" or struck through and redirected with an arrow to a redo is finished: do not report that mistake again, and stay OK while the redo is in progress.',
      );
    }
    lines.push(
      '',
      'Phrase any correction you speak as one short sentence in plain words a voice can read: no LaTeX, no dollar signs, no backslash commands, saying fractions as "a over b" and powers as "squared". Keep LaTeX only in the stored `correction` field, never in the spoken `verdict`.',
    );
    if (settings.api.feedbackLang === 'German') lines.push('', GERMAN_GRADING);
    return lines.join('\n');
  }

  // One structured call to a given model. Cheap models (e.g. Haiku) don't take the
  // effort parameter or adaptive thinking, so those are omitted for them. When
  // `tagSkills` is set the call also carries the constant skill-assessor block (cached)
  // and the wider tagging schema, so the reply includes difficulty + per-skill tags;
  // the routine cheap-verify scans pass `tagSkills` false to stay lean.
  async function callModel(
    model: string,
    effort: string | null,
    role: Role,
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
    text: string,
    tagSkills = false,
  ): Promise<{
    problem: string;
    solution: string;
    verdict: string;
    correction: { wrong: string; right: string };
    difficulty?: number;
    skills?: KCObservation[];
  }> {
    const info = modelInfo(model);
    const useEffort = info.effort && !!effort;
    const tag = tagSkills && settings.api.trackSkills;
    const schema = tag ? SKILL_SOLUTION_SCHEMA : SOLUTION_SCHEMA;
    // The skill-assessor block is byte-identical across every call, so it leads the system prompt as
    // a stable prefix that OpenAI's automatic prompt caching can reuse after the first call.
    const system = tag ? `${SKILL_ASSESSOR}\n\n${mode.systemPrompt}` : mode.systemPrompt;
    const params: any = {
      model,
      max_completion_tokens: settings.api.maxTokens,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'feedback', strict: true, schema } },
    };
    if (useEffort) params.reasoning_effort = effort;

    const resp = await getClient().chat.completions.create(params);
    logUsage(resp, mode, model, role);
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(out);
    } catch {
      // A non-JSON / refused / truncated reply carries no verdict, so treat it as OK (stay silent).
      // finish_reason 'length' means max_completion_tokens was too small for the reasoning + output.
      console.warn(
        `[nuclear-learning] ${role} reply unusable (finish_reason=${resp.choices?.[0]?.finish_reason}, ${out.length} chars); staying silent. If 'length', raise Max tokens.`,
      );
      return { problem: '', solution: '', verdict: 'OK', correction: { wrong: '', right: '' } };
    }
    const correction = {
      wrong: (parsed?.correction?.wrong ?? '').trim(),
      right: (parsed?.correction?.right ?? '').trim(),
    };
    // Latch the latest non-empty correction for the page. The resolving Opus call is the
    // one instructed to fill it, so by the time a problem turns CORRECT this holds that
    // call's correction; an empty one never clobbers a real one.
    if (correction.wrong || correction.right) lastCorrection = correction;
    // Tag read is decoupled and best-effort, so a malformed skills array can never block
    // the verdict / chime.
    let difficulty: number | undefined;
    let skills: KCObservation[] | undefined;
    try {
      if (typeof parsed.difficulty === 'number') difficulty = parsed.difficulty;
      if (Array.isArray(parsed.skills)) {
        skills = parsed.skills
          .filter((s: any) => s && typeof s.id === 'string' && (s.role === 'core' || s.role === 'support'))
          .map((s: any) => ({ id: s.id, role: s.role, signal: s.signal }));
      }
    } catch {
      /* tagging is best-effort */
    }
    return {
      problem: (parsed.problem ?? '').trim(),
      solution: (parsed.solution ?? '').trim(),
      verdict: (parsed.verdict ?? '').trim(),
      correction,
      difficulty,
      skills,
    };
  }

  // The grading path, no corner mark, no readiness gate. While no solution is cached, gpt-5.4 attempts the
  // solve each scan: if the question is fully written it solves it at MEDIUM effort and caches the
  // worked checklist; if the statement is not yet complete it returns an empty solution and we quietly
  // retry next scan. So gpt-5.4 itself is the gatekeeper, not a flaky cheap readiness check. From then on
  // gpt-5.4-mini verifies every scan against the cache and corrects continuously (staying OK while a
  // line is mid-working and only flagging a settled result), and gpt-5.4 confirms a finished answer at LOW
  // effort before we acknowledge. Clear moves on to a new problem.
  async function getFeedbackCached(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    const wantSkills = settings.api.trackSkills;

    // No solution yet: gpt-5.4 attempts the solve. It caches only a complete question and leaves the cache
    // empty (a silent OK) while the statement is still going in, so it self-gates.
    if (cachedSolution === '') {
      const r = await callModel(
        settings.api.solveModel,
        'medium',
        'solve',
        data,
        mediaType,
        mode,
        buildCachedContext(false),
        wantSkills,
      );
      if (r.solution) cachedSolution = r.solution;
      if (r.problem) cachedProblem = r.problem;
      lastSteps = solutionSteps();
      recordMembership(r);
      if (isCorrect(r.verdict)) captureSkills(r);
      if (import.meta.env.DEV) {
        console.debug(
          `[nuclear-learning] solve: cached=${cachedSolution !== ''} (solution ${r.solution.length} chars), problem=${JSON.stringify(r.problem)}, verdict=${JSON.stringify(r.verdict)}`,
        );
      }
      return r.verdict;
    }

    // VERIFY every scan on Sonnet against the cache, correcting continuously. It stays OK while a
    // line or a redo is still being written, and flags the first diverging settled result.
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

    // The verify judged the answer finished and right: gpt-5.4 confirms at low effort before we say so.
    const c = await callModel(
      settings.api.confirmModel,
      'low',
      'confirm',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
      wantSkills,
    );
    if (isCorrect(c.verdict)) captureSkills(c);
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
    // Speak the math as words, not the raw notation. Without this the engine reads "$x^2$"
    // as "dollar x caret two dollar" and drops symbols like √ ≤ ∫; mathToSpeech turns them
    // into spoken maths in the feedback language, leaving the surrounding prose untouched.
    const lang = settings.api.feedbackLang === 'German' ? 'de' : 'en';
    const spoken = mathToSpeech(text, lang);
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = lang === 'de' ? 'de-DE' : settings.audio.voiceLang;
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
  // What a verdict says out loud / on screen. A corner-gated mode "says it is correct"
  // without marking it: a CORRECT verdict becomes a plain spoken confirmation, never the
  // literal token. Every other verdict (errors, other modes) is delivered as written.
  function describe(text: string, mode: Mode): string {
    if (mode.cornerGated && isCorrect(text)) {
      return settings.api.feedbackLang === 'German' ? 'Das stimmt.' : 'Correct.';
    }
    return text;
  }

  function deliver(text: string, mode: Mode): boolean {
    if (!text || isQuiet(text)) return false;
    const key = deliveryKey(text);
    if (spokenKeys.has(key)) return false; // already said this one this problem
    spokenKeys.add(key);
    // Corner-gated correct answers are spoken, not chimed ("say it is correct, don't mark it").
    const markSilently = mode.cornerGated === true && isCorrect(text);
    if ((mode.feedbackStyle === 'chime' || mode.feedbackStyle === 'both') && !markSilently) {
      playChime(isCorrect(text));
    }
    if (mode.feedbackStyle === 'spoken' || mode.feedbackStyle === 'both') {
      speak(describe(text, mode));
    }
    return true;
  }

  /** Start a fresh page: forget prior verdicts and stop any in-flight speech. */
  function resetSession(): void {
    // Abandon hook (runs before state is cleared): if a page never resolved CORRECT but
    // kept showing an error, deposit a 'wrong' on the solve-time membership's core skills
    // so the estimator sees losses, not only wins. Reuses the solve-time membership, so
    // there is no extra Opus call. A hedged-but-correct page deposits a clean instead.
    if (settings.api.trackSkills && !skillApplied && skillMembership) {
      const errors = history.filter((h) => h && !isQuiet(h) && !isCorrect(h));
      const hadError = errors.length >= 1 && history.length >= 2;
      const sig: 'clean' | 'wrong' | null = pageReachedCorrect ? 'clean' : hadError ? 'wrong' : null;
      if (sig) {
        const all = skillMembership.skills ?? [];
        const core = all.filter((o) => o.role === 'core');
        const tagged = (core.length ? core : all).map((o) => ({ ...o, signal: sig }));
        applySkillPacket({ difficulty: skillMembership.difficulty, skills: tagged }, lastSteps, Date.now());
      }
    }
    history.length = 0;
    spokenKeys.clear();
    cachedSolution = '';
    cachedProblem = '';
    lessonCaptured = false;
    lastCorrection = null;
    skillMembership = null;
    skillApplied = false;
    pageReachedCorrect = false;
    lastSteps = 0;
    newPage();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  // Whether the strong model has worked out and cached a solution for the current problem. Lets the
  // UI tell "still solving (no reference yet)" apart from "solved, and the work so far looks fine".
  function hasSolution(): boolean {
    return cachedSolution !== '';
  }

  // Console probe: type __nlState() in DevTools to see whether the current problem has a cached
  // solution and what it is, so a non-caching solve is provable rather than guessed at.
  if (typeof window !== 'undefined') {
    (window as unknown as { __nlState: unknown }).__nlState = () => ({
      hasSolution: cachedSolution !== '',
      problem: cachedProblem,
      solutionChars: cachedSolution.length,
      solution: cachedSolution,
    });
  }

  return {
    getFeedback,
    recordVerdict,
    deliver,
    describe,
    resetSession,
    speak,
    playChime,
    isCorrect,
    isQuiet,
    hasSolution,
  };
}
