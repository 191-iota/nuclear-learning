import Anthropic from '@anthropic-ai/sdk';
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
  required: ['problem', 'solution', 'cornerMark', 'verdict', 'correction'],
  properties: {
    problem: { type: 'string' },
    solution: { type: 'string' },
    // Whether the learner has drawn a corner mark on the page. The app forces the verdict
    // to OK whenever this is false in a corner-gated mode, so nothing is surfaced unasked.
    cornerMark: { type: 'boolean' },
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
  required: ['problem', 'solution', 'cornerMark', 'verdict', 'correction', 'difficulty', 'skills'],
  properties: {
    ...SOLUTION_SCHEMA.properties,
    difficulty: { enum: [1, 2, 3, 4, 5] },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'signal'],
        properties: {
          id: { enum: KC_IDS },
          role: { enum: ['core', 'support'] },
          signal: { enum: ['none', 'clean', 'shaky', 'wrong'] },
        },
      },
    },
  },
};

// The gatekeeper schema: the cheap watcher reports these two booleans, never a grade. One says the
// full question is written and ready to solve; the other says a corner mark asks for feedback.
const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questionReady', 'cornerMark'],
  properties: {
    questionReady: { type: 'boolean' },
    cornerMark: { type: 'boolean' },
  },
};

const GATE_PROMPT =
  'You look at a photo of handwritten work and report TWO things as JSON, without solving or grading anything: (1) questionReady: whether the full problem statement the learner is working on is written out completely enough to be solved (the whole question, not just a label, a heading, or a half-written line); (2) cornerMark: whether the learner has drawn a CORNER MARK, a small hand-drawn right-angle hook (an L, a corner bracket, two short strokes meeting at a right angle) placed beside a line as a deliberate annotation, separate from the mathematics, and NOT a right angle that belongs to the work or an arrow used to redo a line. If you are unsure about either, report false for it. Reply with a JSON object {"questionReady": boolean, "cornerMark": boolean} and nothing else.';

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

  // Lesson capture: the moment a problem turns CORRECT after an error, the error and
  // the worked solution are already in hand from this scan. One per problem; nothing
  // is captured when the work was right the first time. The card itself is written by
  // a dedicated Sonnet call (a specific recall question, not the cryptic live nudge);
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
        'Set `cornerMark` true ONLY if the learner has clearly drawn a corner mark on this page: a small hand-drawn right-angle hook (an L, a corner bracket, two short strokes at a right angle) placed beside or beneath a line as a deliberate annotation, separate from the mathematics, not a right angle that belongs to the work (a geometry figure, a bracket or fraction-bar corner, an L variable). If you are unsure, set it false.',
        'If `cornerMark` is false, your verdict is OK and nothing else, whatever the work shows. Never correct, acknowledge, or comment without a corner mark. When `cornerMark` is true, judge RESULT-FIRST against the known solution: if a result the learner has settled on diverges, name the first diverging step, reading what the learner wrote rather than guessing a formula. Respond CORRECT ONLY when every sub-part label on the page (a, b, c, ...) has an answer, each answered sub-part carries its OWN double-underlined result tied to it, and every error flagged earlier has been fixed; otherwise, with no diverging settled result, respond OK. Give no advice or encouragement of any kind. Do not re-derive; leave "solution" empty.',
        'While a line, a calculation, or a redo is still being written, respond OK rather than flagging it; only judge a result the learner has settled on. A line the learner marked "falsch" or struck through and redirected with an arrow to a redo is finished business: NEVER report that mistake again, follow the arrow, and stay OK while the redo is in progress, judging it only once it reaches a settled result. Report any one correction only once, then stay OK while the learner works on the fix.',
        'CORRECTION (stored for the learner\'s later review, never spoken): if your verdict is CORRECT and the earlier feedback above had flagged a mistake the learner has since fixed, fill `correction.wrong` with the specific error they made and `correction.right` with the corrected version, each ONE short line, writing every mathematical expression in LaTeX between single $ delimiters (for example $\\overline{a\\cdot b}=\\bar a+\\bar b$). This field is for review only, so naming the right answer here is fine and does not change your verdict. If there was no earlier mistake, leave both empty.',
      );
    } else {
      lines.push(
        'No solution has been worked out for the current problem yet. Identify the problem the learner is working on, solve it completely yourself, and return the full worked solution in "solution" with a short label in "problem" (work it out and keep it ready even on a scan where you stay silent). If the problem statement is still incomplete or you cannot determine it, leave "solution" empty.',
        'Set `cornerMark` true only if a corner mark is clearly present (a hand-drawn right-angle hook beside a line, separate from the mathematics; if unsure, false). If `cornerMark` is false, your verdict is OK. When it is true, grade against the solution you just derived: name the first diverging step only for a result the learner has settled on; respond CORRECT ONLY when every sub-part is answered with its own double-underlined result and every earlier error is fixed; otherwise OK. Give no advice.',
        'While a line or a redo is still being written, respond OK. A line the learner marked "falsch" or struck through and redirected with an arrow to a redo is finished: do not report that mistake again, and stay OK until the redo reaches a settled result.',
      );
    }
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
    cornerMark: boolean;
    verdict: string;
    correction: { wrong: string; right: string };
    difficulty?: number;
    skills?: KCObservation[];
  }> {
    const info = modelInfo(model);
    const useEffort = info.effort && !!effort;
    const tag = tagSkills && settings.api.trackSkills;
    const output_config: any = {
      format: { type: 'json_schema', schema: tag ? SKILL_SOLUTION_SCHEMA : SOLUTION_SCHEMA },
    };
    if (useEffort) output_config.effort = effort;
    // The skill-assessor block is byte-identical across every call and mode, so it sits
    // first with cache_control and is a cache-prefix read after the first call.
    const system: any = tag
      ? [
          { type: 'text', text: SKILL_ASSESSOR, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: mode.systemPrompt },
        ]
      : mode.systemPrompt;
    const params: any = {
      model,
      max_tokens: settings.api.maxTokens,
      system,
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
    let parsed: any;
    try {
      parsed = JSON.parse(out);
    } catch {
      // A non-JSON reply carries no corner-mark signal, so a gated mode treats it as OK.
      return { problem: '', solution: '', cornerMark: false, verdict: out, correction: { wrong: '', right: '' } };
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
      cornerMark: parsed.cornerMark === true,
      verdict: (parsed.verdict ?? '').trim(),
      correction,
      difficulty,
      skills,
    };
  }

  // Corner-gated modes only surface a verdict when the model reports a corner mark on the
  // page; otherwise the app forces OK, so nothing interrupts work you did not flag. This
  // enforces the gate in code, so a stray correction or a premature CORRECT can never leak
  // through when there is no mark, even if the model tries to comment anyway.
  function gateVerdict(reply: { verdict: string; cornerMark?: boolean }, mode: Mode): string {
    return mode.cornerGated && reply.cornerMark !== true ? 'OK' : reply.verdict;
  }

  // The gatekeeper. The cheapest model looks at the page and reports two things without grading:
  // whether the full question is written out (ready to solve) and whether a corner mark is there
  // (the learner's request for feedback). It is a tiny constant call run on every scan. A missing
  // or malformed reply is read as "not ready, no mark", so the safe default is to spend nothing.
  async function checkGate(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<{ questionReady: boolean; cornerMark: boolean }> {
    const model = settings.api.gateModel;
    try {
      const resp = await getClient().messages.create(
        {
          model,
          max_tokens: 80,
          system: GATE_PROMPT,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
                { type: 'text', text: 'Report questionReady and cornerMark as JSON.' },
              ],
            },
          ],
          output_config: { format: { type: 'json_schema', schema: GATE_SCHEMA } },
        } as any,
        { timeout: 12000 },
      );
      logUsage(resp, mode, model, 'gate');
      const out = (resp.content as any[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('')
        .trim();
      const parsed = JSON.parse(out);
      return { questionReady: parsed?.questionReady === true, cornerMark: parsed?.cornerMark === true };
    } catch (err) {
      console.warn('[nuclear-learning] gate check failed, staying silent:', err);
      return { questionReady: false, cornerMark: false };
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

  // Automatic routing path: classify the problem once (cheap) only to gate the SOLVE
  // effort (low for simple, solveEffort for complex), then run the same tiered flow as
  // manual. The strong model is used ONLY to solve and to confirm; verification is
  // always the cheap model. So auto differs from manual only in that the classifier
  // picks the solve effort, which saves on simple problems.
  async function getFeedbackAuto(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    const wantSkills = settings.api.trackSkills;
    if (complexity === '') {
      const cls = await classify(data, mediaType, mode);
      if (cls !== 'simple' && cls !== 'complex') return 'OK'; // problem not complete yet
      complexity = cls;
    }

    // SOLVE once on the strong model, at the classifier-gated effort.
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
        wantSkills,
      );
      if (r.solution) cachedSolution = r.solution;
      if (r.problem) cachedProblem = r.problem;
      lastSteps = solutionSteps();
      recordMembership(r);
      const v = gateVerdict(r, mode);
      if (isCorrect(v)) captureSkills(r); // first-try-correct, only with a corner mark
      return v;
    }

    // VERIFY every later scan on the cheap model. No skill tagging here, so the
    // repetitive middle stays lean.
    const r = await callModel(
      settings.api.verifyModel,
      settings.api.verifyEffort,
      'verify',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    const rv = gateVerdict(r, mode);
    if (!isCorrect(rv)) return rv;

    // CONFIRM on the strong model before the chime; this Opus call carries the skill
    // tagger. If it disagrees, deliver its hint and keep verifying cheaply.
    const c = await callModel(
      settings.api.confirmModel,
      settings.api.confirmEffort,
      'confirm',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
      wantSkills,
    );
    const cv = gateVerdict(c, mode);
    if (isCorrect(cv)) captureSkills(c);
    return cv;
  }

  // Tiered solve-then-verify path. The solve step runs only until a solution is
  // cached. Once solved it LATCHES: the problem is never solved again for the rest
  // of the session (Clear moves to a new problem). The verify step runs every later
  // scan, where a cheap model checks progress against the cache. The confirm step
  // runs ONLY when the cheap model says CORRECT: the confirm (strong) model re-checks
  // the final answer before it chimes. While the work is still unresolved the cheap
  // model carries every scan — the strong model is never spent on an unfinished page.
  async function getFeedbackCached(
    data: string,
    mediaType: ImageMediaType,
    mode: Mode,
  ): Promise<string> {
    if (settings.api.routing === 'auto') return getFeedbackAuto(data, mediaType, mode);
    const wantSkills = settings.api.trackSkills;

    // Cheap gatekeeper, every scan: a Haiku pass that reports whether the full question is written
    // out (ready to solve) and whether a corner mark is present. It never grades the mathematics.
    const gate = mode.cornerGated
      ? await checkGate(data, mediaType, mode)
      : { questionReady: true, cornerMark: true };

    // PRE-SOLVE. The moment the whole question is on the page, solve it once on the strong model and
    // cache the checklist, so the first corner check is instant. The solve re-checks completeness
    // itself (buildCachedContext(false) tells it to leave the solution empty if the statement is not
    // fully there), so a Haiku false start just leaves the cache empty and we try again. This also
    // grades the current work, but the corner gate keeps it silent unless a mark is present.
    if (cachedSolution === '' && gate.questionReady) {
      const r = await callModel(
        settings.api.solveModel,
        settings.api.solveEffort,
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
      const v = gateVerdict(r, mode);
      if (isCorrect(v)) captureSkills(r); // graded here, but silent without a corner mark
      return v;
    }
    // The question is still going in (nothing complete to solve yet): stay silent and cheap.
    if (cachedSolution === '') return 'OK';

    // Solution cached. From here it is the normal corner-gated flow: a verdict only when you ask.
    if (mode.cornerGated && !gate.cornerMark) return 'OK';

    // VERIFY on Sonnet against the cached solution, escalating a claimed completion to Opus to
    // confirm before we acknowledge. The Haiku gatekeeper above already ensured a corner mark is
    // present, so these run only on scans the learner asked to have checked.
    const r = await callModel(
      settings.api.verifyModel,
      settings.api.verifyEffort,
      'verify',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
    );
    const rv = gateVerdict(r, mode);
    if (!isCorrect(rv)) return rv;

    const c = await callModel(
      settings.api.confirmModel,
      settings.api.confirmEffort,
      'confirm',
      data,
      mediaType,
      mode,
      buildCachedContext(true),
      wantSkills,
    );
    const cv = gateVerdict(c, mode);
    if (isCorrect(cv)) captureSkills(c);
    return cv;
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
    if (lastDelivered && deliveryKey(text) === deliveryKey(lastDelivered)) return false;
    lastDelivered = text;
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
    lastDelivered = '';
    cachedSolution = '';
    cachedProblem = '';
    lessonCaptured = false;
    lastCorrection = null;
    skillMembership = null;
    skillApplied = false;
    pageReachedCorrect = false;
    lastSteps = 0;
    complexity = '';
    newPage();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  return { getFeedback, recordVerdict, deliver, describe, resetSession, speak, playChime, isCorrect, isQuiet };
}
