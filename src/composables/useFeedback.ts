import { cleanText, createCompletion } from '@/api';
import { settings } from '@/stores/settings';
import { mathToSpeech } from '@/mathSpeech';
import type { Mode } from '@/types';
import { recordUsage, newPage, type Role } from '@/stores/usage';
import { addLesson, deckSummary } from '@/stores/lessons';
import { modelInfo } from '@/models';
import {
  applySkillPacket,
  noteSolved,
  type SkillPacket,
  type KCObservation,
} from '@/stores/skills';
import { logEvent } from '@/stores/obslog';
import { KC_IDS, SKILL_ASSESSOR } from '@/kc';
import { generateAskCard, generateLessonCard } from '@/lessonCard';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

// A note attached to an ask request: already-transcribed text plus where it lives.
// Deliberately structural (no import from the notes store): the feedback layer only
// needs the text.
export interface AskNoteBlock {
  title: string;
  path: string;
  text: string;
  // The learner's own context dump for the note (assignment background, source),
  // written by hand and never machine-edited; rendered beside the transcript.
  context?: string;
}

// Structured reply for every button request: a learner-facing one-line `verdict`
// (or hint sentence) plus the worked `solution` (internal, cached) and a `problem`
// label so the cache knows which problem it belongs to. `final` reports completeness —
// every sub-question the statement asks has a settled answer on the page — informational
// since the FINISH button, not ink marks, declares a page done. `parts` is the model's
// own sub-question accounting (how many the statement asks versus how many carry a
// settled answer): forcing the count keeps multi-question pages honest, and the panel
// surfaces it as a progress line. `display` is the verdict's screen version, rendered in the side
// panel: the same message typeset with room (up to four short lines, $-LaTeX inline,
// $$-LaTeX for a standalone expression), never MORE content than the spoken sentence's
// hint-ladder rung carries. The spoken form fed both the ear and the screen once, and
// a sum decomposition read as "Summe von k gleich 1 bis n plus 1 von 2k minus 1 ..."
// is unreadable as text; MathText renders the panel version, TTS keeps the words.
// `correction` is filled only when a problem
// turns CORRECT after a flagged mistake: a clean, LaTeX-formatted statement of what
// was wrong and the right version, stored on the lesson for later review (never
// spoken). It is required by the schema but left empty ("") when not applicable,
// the same way `solution` is empty on a check request.
// `statement` echoes the problem exactly as the capture pass read it (empty on other
// requests): the panel shows it as an EDITABLE read-back — the learner corrects a
// misread given by hand, or by doing nothing accepts it, and the accepted text becomes
// the statement of record every later grading trusts over the ink. `cleared` lists the
// sub-question labels a grading request confirmed correct — the session locks them so
// later cheap checks cannot re-flag approved work.
const SOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'statement', 'solution', 'verdict', 'display', 'final', 'parts', 'cleared', 'correction'],
  properties: {
    problem: { type: 'string' },
    statement: { type: 'string' },
    solution: { type: 'string' },
    verdict: { type: 'string' },
    display: { type: 'string' },
    final: { type: 'boolean' },
    parts: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'answered'],
      properties: {
        total: { type: 'integer' },
        answered: { type: 'integer' },
      },
    },
    cleared: { type: 'array', items: { type: 'string' } },
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
// strong-model calls that already fire once per problem (solve + confirm/resolution), so
// the skill map costs zero extra requests. The cheap check uses SOLUTION_SCHEMA
// instead, so the 125-id enum is never sent on the repeated mid-work checks. `signal`
// carries a 'none' sentinel for membership-only (in-progress) emissions; `difficulty`
// is always present (the model gives its best estimate even when skills is empty).
const SKILL_SOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'statement', 'solution', 'verdict', 'display', 'final', 'parts', 'cleared', 'correction', 'difficulty', 'skills'],
  properties: {
    ...SOLUTION_SCHEMA.properties,
    difficulty: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] },
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

// A typed question is answered in its own, smaller shape: the spoken answer plus its
// screen twin. No verdict, no solution, no skill fields — asking is conversation about
// the route, not a grading pass, and nothing from it may latch into the page's caches.
// `reveals` is the learning signal the question itself carries: the asking is where a
// gap (a rule not firmly held) or an expansion (an adjacent technique worth practicing)
// shows itself, and a capture-worthy one becomes a review card in the lesson deck —
// never rating signal, so asking stays safe.
const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'display', 'reveals'],
  properties: {
    answer: { type: 'string' },
    display: { type: 'string' },
    reveals: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'what'],
      properties: {
        kind: { type: 'string', enum: ['none', 'gap', 'expansion'] },
        what: { type: 'string' },
      },
    },
  },
};

let audioCtx: AudioContext | null = null;
const missingChimes = new Set<string>();

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Feedback language: German, always. Problems may be stated in another language (the
// Teschl mega/bridge sheets are English), but the spoken verdict, its display twin, and
// the voice stay German: the grading line below coerces the model regardless of the
// problem's language, and speak() pins the de-DE voice. The control tokens OK and
// CORRECT stay literal so the chime/silence logic keeps working.
// No label prefix: the old 'Start an error hint with "Schritt [N]:"' rule conflicted with
// the never-say-step-N rule in the math prompt and produced mangled double-location
// sentences. The word-for-word repeat rule is what keeps the audio dedup working now.
// "unleserlich"/"nicht lesen" are mandated because isReadNudge() keys on them.
const GERMAN_GRADING =
  'Write the learner-facing verdict in German (Swiss Hochdeutsch, use "ss" not "ß") as ONE natural spoken sentence, the way a teacher would say it aloud. This holds whatever language the problem or the ink is in: an English problem statement still gets its verdict in German — describe the mathematics in German, and only a short quoted ink fragment may stay in its original language. Never put a label or prefix before it — no "Schritt N:", no phrase ending in a colon — and state the location exactly once, inside the sentence, by the SHORTEST pointer that finds it — the operation or spot ("bei der Zerlegung der Summe") or a short fragment of the ink, never a recited long expression (for example "Bei x hoch drei mal x hoch zwei wurden die Exponenten multipliziert — bei gleicher Basis werden die Exponenten addiert."). When you re-report still-applicable feedback at the SAME hint level — or a still-needed rewrite request or simplification remark — repeat your earlier sentence word for word; a deeper hint level is a new sentence. For an illegibility nudge, say you cannot read the spot and ask for a rewrite, naming the nearest readable expression and using the words "unleserlich" or "nicht lesen" (for example "Ich kann den Exponenten im unterstrichenen Ergebnis nicht lesen, bitte neu schreiben."). Keep the control words OK and CORRECT exactly as written; never translate them. Write "display" in German too: the same message typeset for the side panel, its mathematics as $-LaTeX.';

/**
 * The four button-driven operations on the current page, sharing one per-page session:
 *
 *   solveProblem  "problem written":  read the statement, derive and cache the reference.
 *   checkWork     "check":            grade the settled work so far; never a completion.
 *   getHint       "hint":             one stuck-hint sentence, one ladder level per press.
 *   finishCheck   "finish":           the learner declares the page done; CORRECT or the
 *                                     first blocker.
 *
 * Beside the buttons, askQuestion answers a typed free-form question about the page
 * with the same grounding, in its own reply shape; it records nothing a grading
 * request would ever see.
 *
 * Cohesion across the presses of one page is a session memory of the distinct verdicts
 * (and, separately, hints) given so far; each request carries them as context so the
 * model stays consistent (never re-flags a fixed line, repeats a still-unresolved error
 * verbatim, escalates one ladder level at a time). Delivery is manual: the caller
 * decides what is spoken, and a button press may force a repeat.
 *
 * `resetSession()` starts a fresh page (call it when moving to a new problem).
 */
export function useFeedback() {
  // Session epoch. MainView's generation counter already discards a stale request's
  // VERDICT, but the request itself still ran to completion and used to write its
  // solution/label/membership into whatever session was current by then — Clear
  // during an in-flight solve meant the NEXT problem got graded against the OLD
  // problem's cached solution. Every await re-checks this before touching state.
  let session = 0;
  // Distinct check/finish verdicts on the current page, oldest first. Hints live in
  // their own list: they are not errors, must never seed a lesson via lastError(),
  // and carry their own ladder position.
  const history: string[] = [];
  const hints: string[] = [];
  // Typed questions with their answers, oldest first: context for follow-up asks
  // only, never fed to grading requests — a question is not a verdict.
  const asks: { q: string; a: string }[] = [];
  // The statement as the capture pass read it (shown to the learner for misread
  // catching), and the sub-questions already confirmed correct by a grading request —
  // keyed by a normalized label so "a)" and "a" collide, valued with the raw label the
  // context echoes back. Only multi-part pages lock parts: on a single-question page a
  // premature lock could suppress legitimate flags on later work.
  let capturedStatement = '';
  const confirmedParts = new Map<string, string>();

  function normLabel(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9äöü]/g, '');
  }
  // Every distinct verdict already spoken this problem, so a correction is heard once and the
  // repeat presses on an unchanged page (which re-produce the same verdict) never replay it unforced.
  const spokenKeys = new Set<string>();
  // Session-scoped worked solution for the current problem. The solve model works
  // it out once and this LATCHES, later checks verify against it on the cheap model
  // and it is never re-solved until resetSession (Clear).
  let cachedSolution = '';
  let cachedProblem = '';
  // One lesson per problem: set once a corrected mistake is logged this session.
  let lessonCaptured = false;
  // Latest learner-facing correction emitted on this page (what was wrong + the
  // right version, LaTeX). Set by the resolving confirm call, read by the lesson
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

  function logUsage(resp: any, mode: Mode, model: string, role: Role): void {
    const u = resp?.usage ?? {};
    recordUsage({
      mode: mode.id,
      model,
      role,
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0, // includes reasoning tokens
    });
  }

  function decodeImage(imageDataUrl: string): { data: string; mediaType: ImageMediaType } {
    const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(imageDataUrl);
    return {
      mediaType: (match?.[1] ?? 'image/jpeg') as ImageMediaType,
      data: match?.[2] ?? imageDataUrl.replace(/^data:[^,]*,/, ''),
    };
  }

  // The most recent flagged error still in session memory, the mistake the
  // learner just had to fix. Skips OK / CORRECT lines.
  // An illegibility prompt ("Can't read step N, rewrite it.") is not a learnable mistake, so it must
  // never seed a lesson; lastError skips it and finds the last REAL flagged error instead.
  // No bare "rewrite it" branch: a level-3 ladder sentence can legitimately ask the
  // learner to rewrite a step in their own words, and must not be filtered as a nudge.
  function isReadNudge(text: string): boolean {
    return /can.?t read|illegible|unleserlich|nicht lesen/i.test(text);
  }

  // A finish nudge ("... can still be simplified") reports unfinished work, not a mistake:
  // it must never seed a lesson nor count as an error in the abandon hook. The systemPrompt
  // mandates these exact words, mirroring the isReadNudge contract.
  function isFinishNudge(text: string): boolean {
    return /can still be simplified|noch vereinfach/i.test(text);
  }

  // The resolving error's ladder rungs sit as a trailing run of consecutive error
  // entries; the EARLIEST rung of that run (level 1) is the diagnosis that names the
  // located flaw and its violated constraint, so it seeds the lesson — the later rungs
  // already hand the corrected step over. Read/finish nudges are TRANSPARENT while walking
  // (an illegibility request interleaved between two rungs of the same error must not
  // truncate the run at the later, thinner rung); only a CORRECT separates problems.
  function lastError(): string {
    const run: string[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (isReadNudge(h) || isFinishNudge(h)) continue; // transparent, never part of a run
      if (isQuiet(h) || isCorrect(h)) {
        if (run.length) break; // the trailing error run ended
        continue; // skip non-errors recorded after the resolve
      }
      run.unshift(h); // rebuild oldest-first
    }
    // The run's first rung is the diagnosis (wrong move + violated constraint), the
    // densest sentence for the card; later rungs hand more of the step over and teach
    // less. The correction fields carry the exact wrong/right pair either way.
    return run[0] ?? '';
  }

  // How many hint sentences for the resolving error the learner actually HEARD (P06:
  // scaffold depth). Same trailing-run walk as lastError, then filtered to delivered
  // entries: a held [unheard] sentence assisted nothing and must not discount the win.
  function deliveredRungs(): number {
    const run: string[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (isReadNudge(h) || isFinishNudge(h)) continue;
      if (isQuiet(h) || isCorrect(h)) {
        if (run.length) break;
        continue;
      }
      run.unshift(h);
    }
    return run.filter((h) => spokenKeys.has(deliveryKey(h))).length;
  }

  // Lesson capture: the moment a problem turns CORRECT after an error, the error and
  // the worked solution are already in hand from this request. One per problem; nothing
  // is captured when the work was right the first time. The card itself is written by
  // a dedicated background call (a specific recall question, not the cryptic live nudge);
  // that runs fire-and-forget so the chime is never delayed, and the inputs are snap-
  // shotted now because the session state may move on before it resolves.
  function maybeCaptureLesson(verdict: string, mode: Mode): void {
    if (lessonCaptured) return;
    if (!isCorrect(verdict)) return;
    const mistake = lastError();
    if (!mistake) return;
    lessonCaptured = true;
    logEvent('capture', { label: cachedProblem, rungs: deliveredRungs() });
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

  // Ask-derived capture: when the ask reply judged the question capture-worthy, one
  // background call curates it into the deck. The writer distills the THEORY behind
  // the question, checks the existing cards for coverage, and only genuinely new
  // knowledge lands — as a card written on the rule itself, never on the question's
  // wording. Fire-and-forget like the mistake cards (the spoken answer never waits
  // on it), inputs snapshotted by the caller. No fallback card on a failed or
  // covered write: a verbatim question is not a card.
  async function buildAskLesson(input: {
    modeId: string;
    modeLabel: string;
    problem: string;
    question: string;
    answer: string;
    what: string;
    kind: 'gap' | 'expansion';
    solution: string;
  }): Promise<void> {
    const card = await generateAskCard({
      problem: input.problem,
      question: input.question,
      answer: input.answer,
      what: input.what,
      kind: input.kind,
      solution: input.solution,
      mode: input.modeId,
      deck: deckSummary(),
    });
    if (!card || card.covered || !card.front) {
      logEvent('capture', {
        label: input.problem,
        ask: true,
        kind: input.kind,
        outcome: card ? 'covered' : 'failed',
      });
      return;
    }
    addLesson({
      mode: input.modeId,
      modeLabel: input.modeLabel,
      problem: input.problem,
      mistake: input.question,
      solution: input.solution,
      wrong: '',
      right: '',
      front: card.front,
      back: card.back,
      kind: input.kind === 'gap' ? 'ask-gap' : 'ask-expansion',
      note: input.what,
      gen: 2,
    });
    logEvent('capture', { label: input.problem, ask: true, kind: input.kind });
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

  // A resolving CORRECT (from solve or confirm) carries real per-skill signal; fold it
  // into the estimator once.
  function captureSkills(r: Reply): void {
    pageReachedCorrect = true;
    if (settings.api.trackSkills && !skillApplied && r.skills?.length) {
      applySkillPacket(
        { difficulty: r.difficulty, skills: r.skills, rungs: deliveredRungs() },
        lastSteps,
        Date.now(),
        { source: 'resolve', label: cachedProblem },
      );
      skillApplied = true;
    }
  }

  // Per-request context blocks. Triage, voice, the school conventions, and the hint
  // ladder live ONLY in the mode systemPrompt (shared by all four requests); these
  // blocks carry just what is unique to a request, so nothing here can drift against
  // the stable rules.

  // The "final"/"parts"/"display" contracts ride in every request, so a user-edited
  // preset whose system prompt predates the fields (or dropped them) still fills them
  // deliberately instead of guessing at names the strict schema forces it to emit.
  const RESPONSE_CONTRACT =
    'In "final", report true exactly when every sub-question the problem statement asks has a settled answer on the page — completeness, decided fresh on every request, whatever the verdict; ink marks (underlines, boxes) play no role in it. In "parts", count fresh on every request: "total" = how many separate sub-questions the problem statement asks — labeled parts, or several questions or task verbs inside one prose statement; 1 when it asks one thing, 0 while the statement cannot be determined yet — and "answered" = how many of them have a settled answer on the page. In "display", write the verdict\'s SCREEN version for a side panel with real typesetting room: the same message as "verdict", set properly. Every mathematical expression in LaTeX ($...$ inline; $$...$$ on its own line for the one expression the message centers on), line breaks between statements, at most four short lines. The panel elaborates the TYPESETTING, never the content: "display" must not contain any fact, value, step, or hint the spoken "verdict" does not already carry at the current hint-ladder rung — a corrected value appears exactly when the spoken sentence\'s rung already carries it. When the rung names the violated constraint, the constraint may stand as its own cleanly typeset line. Empty for OK and CORRECT. In "statement", restate the problem exactly as read on a CAPTURE request; empty on every other request. In "cleared", list the labels of sub-questions whose settled final answer THIS request confirmed correct against the reference (empty when none or when not grading).';

  // Fed to the capture pass only: read the statement, never grade the attempt. The
  // "partly solved page" case is explicitly normal — the statement is still on the
  // page, so a late capture press must behave exactly like an early one.
  const SOLVE_STATEMENT =
    'No reference solution is cached for this page yet. The PROBLEM is the ORIGINAL statement the learner copied down before their own working: it starts at the top, may span several written lines, and may ask several sub-questions — labeled parts like a), b), c), or several questions or task verbs inside one prose statement; every one of them is part of the problem, so never cut the statement off at its first line or first question. An "=" that is part of a given equation or formula belongs to the problem itself; an "=" the learner added while reworking does not. A task verb like "Vereinfachen" (simplify) or "nach b auflösen" (solve for b) applies to THAT original statement; everything written after the statement is the learner\'s ATTEMPT, never part of the problem, so NEVER take a later or reworked line as the given. The attempt may already be underway or even complete: that changes nothing about what the statement is.';
  const SOLVE_DERIVE =
    'Solve EVERY sub-question of that original problem completely yourself from scratch and return the worked solution in "solution" — when there are several, grouped by sub-question in the statement\'s order, each group opening with its label (a), b), or Q1, Q2 when unlabeled) and ending with that sub-question\'s final answer — with one short label in "problem" covering all of it. Write it as a Swiss BM textbook would print it, per the SCHOOL CONVENTIONS in your instructions: no absolute values, case distinctions, or domain notes the task does not ask for, and the complete solution set when solving an equation. If the original statement is still incomplete or you cannot determine it, leave "solution" empty.';
  const SOLVE_NO_GRADE =
    'This is the CAPTURE request ("problem written"): do NOT grade the learner\'s attempt on this pass, whatever work is already on the page. Reply with verdict OK, an empty "display", and an empty "correction" — your only job here is the reference solution, the label, the counts, and the read-back. In "statement", restate the problem statement exactly as you read it from the ink — compact, every formula in $-LaTeX between single $ delimiters, every given value visible: the learner checks this read-back for misread digits before working against it.';

  const CHECK_REQUEST =
    'This is a CHECK request: the learner asks whether the settled work so far is correct. Reply OK when every settled line is correct — even when the page looks complete, since completion is decided only by a FINISH request: never reply CORRECT to a check. Otherwise reply the ONE error sentence for the first diverging settled step, per the HINT LADDER and VOICE in your instructions.';
  const HINT_REQUEST =
    'This is a HINT request: the learner pressed the stuck button and asks what comes next. Answer per the STUCK HINTS rules in your instructions: if a settled error blocks them, the hint is that error\'s ladder sentence at its next unused level — the press itself is the stuck signal, so never repeat a sentence already given for that error; otherwise the hint names the NEXT CONSTRAINT of the route from the frontier, at the level the hint history below dictates — the condition the next step must satisfy, bound to this problem\'s objects, never a definition and never a re-grading of the work so far. The hint is ONE sentence per VOICE — never OK, never CORRECT, never a bare "keep going". If the work is already complete and correct, say in German that the work looks complete and only the finish check remains.';
  const FINISH_REQUEST =
    'This is a FINISH request: the learner declares the page done. Reply CORRECT exactly when every sub-question the statement asks has a settled answer matching the reference (ink marks are NOT required, and extra unasked work does not block) and every earlier flagged error is fixed or superseded. Otherwise reply ONE sentence naming the first blocker: the first unanswered sub-question (by its label or its asked-for quantity), or the first diverging settled step (per HINT LADDER, at the next unused level for that error), or an ILLEGIBILITY rewrite request when a symbol you need stays unreadable. Never reply a bare OK to a finish request — the learner is waiting for a decision.';

  const ASK_REQUEST =
    'This is an ASK request: the learner typed a question about the page in hand — it is quoted at the end of this message, and it may be hypothetical ("what if I ..."), clarifying, or exploratory. Before answering, READ THE INK: locate the learner\'s frontier (their last settled line) and the specific written work the question points at, and anchor the answer THERE — name or quote the short fragment of their ink it applies to, so the answer is visibly about THIS page and THIS attempt, never a generic explanation that would fit any textbook. Answer THAT question, grounded in the ink, the statement of record, the feedback already given, and the reference solution. For a hypothetical, state where the move leads and the constraint it satisfies or violates — the outcome plus the governing law, so the learner runs the rule themselves. No definitions or theorem recitals they could look up, no repeating what their ink already shows, no praise, no filler. Declarative statements per VOICE, up to SIX short sentences when the question needs them. The reference is yours to reveal: give exactly as much of it as the question asks for — a value, a step, or, when the question plainly asks for the remaining route or the final answer, that route compactly from THEIR frontier onward, final answer included when asked for. Never point the learner to printed solutions, a textbook, or any material outside this app: whatever resolution the question earns, it gets here, in the answer. A verdict on the work so far stays the check and finish buttons\' business: asked whether it is right, say that the check decides that, and answer what remains of the question. Whatever language the question is in, reply in German (Swiss Hochdeutsch, use "ss" not "ß"). Alongside the answer, judge in "reveals" what the QUESTION ITSELF says about the learner: kind "gap" when it shows a rule, constraint, or connection they do not firmly hold — they asked because their model of it is incomplete; kind "expansion" when it reaches for an adjacent technique, shortcut, or concept they would concretely benefit from practicing next; kind "none" otherwise — reading clarifications, logistics, tool questions, or a point the answer settles for good. Capture only what a review card or a small practice task would genuinely serve tomorrow; when both fit, gap wins. In "what", ONE short German line naming the underlying rule or technique itself, in textbook terms — never an echo or paraphrase of the question (empty for none); it seeds a later review card. Reply ONLY in this request\'s own JSON shape: "answer" = the spoken answer in plain speakable words (no LaTeX, and never the tokens OK or CORRECT); "display" = the same answer typeset for the side panel, every mathematical expression as $-LaTeX between single $ delimiters, at most eight short lines, one statement per line; "reveals" = the judgment above.';

  const CORRECTION_RULE =
    'CORRECTION (stored for the learner\'s later review, never spoken): if the earlier feedback below had flagged a mistake the learner has since FIXED, fill `correction.wrong` with the specific error they made and `correction.right` with the corrected version, each ONE short line, writing every mathematical expression in LaTeX between single $ delimiters (for example $\\overline{a\\cdot b}=\\bar a+\\bar b$) — whatever your verdict is. Naming the right answer here is fine and does not change your verdict. If there was no earlier mistake, or it is still unfixed, leave both empty.';

  function referenceLines(): string[] {
    // The statement of record: the capture's read-back, which the learner saw and
    // could correct by hand. Its givens are settled — a grading request never
    // re-derives different givens from the statement ink, so one misread digit
    // cannot turn into an endless stream of bogus flags; the learner's edit fixes
    // the record instead.
    const record = capturedStatement
      ? [
          `The problem statement of record is: ${capturedStatement}`,
          'The learner saw this read-back and could correct it, so its given values are settled: grade against them and never re-read different givens out of the statement ink. If the learner\'s work uses other values, that is a copying slip on their side.',
          '',
        ]
      : [];
    return [
      ...record,
      'The correct solution to the current problem is:',
      cachedSolution,
      '',
      `The problem label used so far is "${cachedProblem}".`,
      'Judge the learner\'s work against this reference using the rules in your instructions. Do not re-derive the solution for parts it already covers; if the page now shows a sub-part or problem it does NOT cover, work that part out yourself — but only once its statement is completely written — and return ONLY that part\'s checklist lines in "solution" (never repeat lines the reference above already contains); otherwise leave "solution" empty. Keep the label above in "problem" while judging work the reference covers; when you solve a NEW sub-part, set "problem" to that new sub-part\'s label instead.',
      'This reference is internal scaffolding and may be more general than the textbook answer: where it carries qualifications the textbook form drops (absolute-value bars, domain notes), the learner\'s textbook-form answer still MATCHES (y for |y|). A dropped SOLUTION of an equation is never such a qualification — x = 3 against a reference x = ±3 is a lost root, a real error — and nothing is droppable on a task explicitly about domains, cases, or absolute value. Before flagging any error, check that it survives the SCHOOL CONVENTIONS.',
    ];
  }

  function historyLines(): string[] {
    if (history.length === 0) return [];
    // History goes last among the check/finish blocks: it grows over the page's life,
    // so keeping it behind the stable reference and instructions leaves that prefix
    // intact for the server's prompt cache. Every entry here WAS delivered (buttons speak
    // immediately), so the old [unheard] bookkeeping is gone with the scan loop.
    return [
      '',
      'Feedback you gave EARLIER on this same page (oldest first); consecutive sentences about the same spot are your HINT LADDER position for it. Check each against the CURRENT work: if a step you flagged now follows correctly, it is FIXED — do NOT report it again and do NOT let it keep you from OK or CORRECT. For an error that is STILL wrong, continue per the HINT LADDER: repeat your last sentence for it VERBATIM from this list, or go exactly one level deeper if the learner re-attempted the spot and failed, or wrote a question mark near it.',
      history.map((h, i) => `${i + 1}. ${h}`).join('\n'),
    ];
  }

  // The confirmed-parts lock. Checks treat these as settled truth (no re-deriving, no
  // re-flagging, no flip-flop when a later scan misreads approved ink); the finish is
  // the higher court and may still override the cheap checker.
  function confirmedLines(finish: boolean): string[] {
    if (confirmedParts.size === 0) return [];
    const list = [...confirmedParts.values()].join(', ');
    return [
      '',
      finish
        ? `Sub-questions an earlier check confirmed correct: ${list}. That was the cheap checker's word, not yours — the finish check re-judges everything, and if one of those answers is actually wrong against the reference, flag it.`
        : `Sub-questions already confirmed correct in earlier checks: ${list}. Their settled answers count as correct: do NOT re-derive, re-judge, or flag them, and never spend the error sentence on them — unless the learner visibly reworked that part since (struck through, overwritten, or redone below), in which case judge the redo. Focus on the work not yet confirmed.`,
    ];
  }

  function hintLines(unchanged: boolean): string[] {
    const lines: string[] = [
      '',
      hints.length === 0
        ? 'No hint has been given on this page yet: this one starts at level 1.'
        : unchanged
          ? 'The page is UNCHANGED since the last hint: the learner is still stuck at the same state, so go exactly one level deeper than your last hint below.'
          : 'New ink arrived since the last hint: judge the current state fresh; if the learner moved past the hinted spot, the new spot starts again at level 1.',
    ];
    if (hints.length > 0) {
      lines.push('', 'Hints you already gave on this page (oldest first):', hints.map((h, i) => `${i + 1}. ${h}`).join('\n'));
    }
    return lines;
  }

  // A learner-corrected statement replaces the ink as the source of truth: the solve
  // derives the reference from exactly that text (the image still shows layout and
  // attempt, but its statement region no longer decides the givens).
  function solveContext(statementOverride?: string): string {
    const opening = statementOverride
      ? [
          `The learner has corrected the statement read-back by hand. The problem statement is EXACTLY this text, authoritative over anything the statement ink seems to say: ${statementOverride}`,
          SOLVE_DERIVE,
          'This is a CAPTURE request with a learner-confirmed statement: do NOT grade the attempt, reply verdict OK with empty "display" and "correction", and set "statement" to the confirmed statement (typeset, mathematics in $-LaTeX).',
        ]
      : [SOLVE_STATEMENT, SOLVE_DERIVE, SOLVE_NO_GRADE];
    return [...opening, '', RESPONSE_CONTRACT, '', GERMAN_GRADING].join('\n');
  }

  function checkContext(): string {
    return [...referenceLines(), CHECK_REQUEST, CORRECTION_RULE, '', RESPONSE_CONTRACT, '', GERMAN_GRADING, ...confirmedLines(false), ...historyLines()].join('\n');
  }

  function hintContext(unchanged: boolean): string {
    return [...referenceLines(), HINT_REQUEST, '', RESPONSE_CONTRACT, '', GERMAN_GRADING, ...confirmedLines(false), ...historyLines(), ...hintLines(unchanged)].join('\n');
  }

  // The finish judge also rates the page as one performance; the stuck-hints given
  // are part of that evidence (help needed lowers the demonstrated level) and are
  // otherwise invisible to finish requests, so they ride along here.
  function hintEvidence(): string[] {
    if (hints.length === 0) return [];
    return [
      '',
      'Stuck-hints you gave on this page (oldest first), evidence for the performance judgment:',
      hints.map((h, i) => `${i + 1}. ${h}`).join('\n'),
    ];
  }

  function finishContext(): string {
    return [...referenceLines(), FINISH_REQUEST, CORRECTION_RULE, '', RESPONSE_CONTRACT, '', GERMAN_GRADING, ...confirmedLines(true), ...historyLines(), ...hintEvidence()].join('\n');
  }

  // The ask context reuses the page's grounding (statement of record, reference,
  // feedback and hints already given) but none of the grading scaffolding: the reply
  // shape has no verdict and no solution, so nothing can latch. Earlier asks ride
  // along so follow-up questions compose. Attached notes arrive as TEXT (the notes
  // store transcribes handwriting once, in the background), so referring to a whole
  // folder costs a few hundred tokens, never a pile of images. (An ask with an EMPTY
  // pad never lands here at all: MainView routes it to the general study assistant
  // in ask.ts — the math persona owns pages, not the notebook.)
  function askContext(question: string, notes?: AskNoteBlock[]): string {
    const lines: string[] = [];
    if (capturedStatement) {
      lines.push(`The problem statement of record is: ${capturedStatement}`, '');
    }
    if (cachedSolution) {
      lines.push(
        'The correct solution to the current problem, your grounding, unseen by the learner:',
        cachedSolution,
        '',
      );
    }
    lines.push(ASK_REQUEST);
    if (notes?.length) {
      lines.push(
        '',
        "The learner attached these notes of their own as context — transcripts of their handwritten or typed notes, chosen by them for this question. Treat them as the learner's material: draw on and reference them where they bear on the question, ignore what does not, and never grade them.",
      );
      notes.forEach((n, i) => {
        lines.push('', `[Note ${i + 1}: "${n.title}" — folder: ${n.path}]`);
        if (n.context) lines.push(`Learner's own context for this note: ${n.context}`);
        if (n.text) lines.push(n.text);
        else lines.push('[This note has NO transcript — only the context above exists.]');
      });
      lines.push('', '[End of attached notes]');
    }
    if (history.length) {
      lines.push('', 'Feedback you already gave on this page (oldest first):', history.map((h, i) => `${i + 1}. ${h}`).join('\n'));
    }
    if (hints.length) {
      lines.push('', 'Hints you already gave on this page (oldest first):', hints.map((h, i) => `${i + 1}. ${h}`).join('\n'));
    }
    if (asks.length) {
      lines.push('', 'Questions the learner already asked on this page, with your answers (oldest first):', asks.map((x, i) => `${i + 1}. Q: ${x.q} A: ${x.a}`).join('\n'));
    }
    lines.push('', `The learner's question: ${question}`);
    return lines.join('\n');
  }

  // One structured call to a given model. An effort of 'none' is a real answer here and is
  // sent as one; only a model whose entry says it takes no effort at all has it left off,
  // and api.ts fills 'none' in behind that (see models.ts). When
  // `tagSkills` is set the call also carries the constant skill-assessor block (cached)
  // and the wider tagging schema, so the reply includes difficulty + per-skill tags;
  // the routine cheap checks pass `tagSkills` false to stay lean.
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
    statement: string;
    solution: string;
    verdict: string;
    display: string;
    final: boolean;
    parts?: { total: number; answered: number };
    cleared: string[];
    correction: { wrong: string; right: string };
    difficulty?: number;
    skills?: KCObservation[];
    ungraded?: boolean;
  }> {
    const info = modelInfo(model);
    const useEffort = info.effort && !!effort;
    const tag = tagSkills && settings.api.trackSkills;
    const schema = tag ? SKILL_SOLUTION_SCHEMA : SOLUTION_SCHEMA;
    // The skill-assessor block is byte-identical across every call, so it leads the system prompt as
    // a stable prefix. Ollama keeps the last prompt's key/value cache and starts a request at the
    // first token that differs, so an unchanged prefix is read once and skipped on every call after.
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

    const resp = await createCompletion(params);
    logUsage(resp, mode, model, role);
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(out);
    } catch {
      // A non-JSON / refused / truncated reply carries no verdict, so treat it as OK (stay silent).
      // `ungraded` marks it as such: this OK says nothing about the page, so the caller's
      // grace hold must not read it as "the slip got fixed" and rescind a held correction.
      // finish_reason 'length' means max_completion_tokens was too small for the reasoning + output.
      console.warn(
        `[nuclear-learning] ${role} reply unusable (finish_reason=${resp.choices?.[0]?.finish_reason}, ${out.length} chars); staying silent. If 'length', raise Max tokens.`,
      );
      return {
        problem: '',
        statement: '',
        solution: '',
        verdict: 'OK',
        display: '',
        final: false,
        cleared: [],
        correction: { wrong: '', right: '' },
        ungraded: true,
      };
    }
    const correction = {
      wrong: cleanText(parsed?.correction?.wrong).trim(),
      right: cleanText(parsed?.correction?.right).trim(),
    };
    // Sub-question accounting, best-effort like the tags: a malformed count can never
    // block the verdict, it only costs the panel its progress line for this request.
    let parts: { total: number; answered: number } | undefined;
    const rawParts = parsed?.parts;
    if (rawParts && Number.isFinite(rawParts.total) && Number.isFinite(rawParts.answered)) {
      parts = {
        total: Math.max(0, Math.trunc(rawParts.total)),
        answered: Math.max(0, Math.trunc(rawParts.answered)),
      };
    }
    const cleared: string[] = Array.isArray(parsed?.cleared)
      ? parsed.cleared.filter((c: unknown) => typeof c === 'string').map((c: string) => cleanText(c).trim()).filter(Boolean)
      : [];
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
      problem: cleanText(parsed.problem).trim(),
      statement: cleanText(parsed.statement).trim(),
      solution: cleanText(parsed.solution).trim(),
      // The [unheard] history tag is metadata the model is told never to echo; strip a
      // trailing one defensively anyway, or it would defeat the verbatim-repeat match
      // (and the audio dedup) and end up spoken aloud.
      verdict: cleanText(parsed.verdict).trim().replace(/\s*\[unheard\]$/i, ''),
      display: cleanText(parsed.display).trim(),
      final: parsed.final === true,
      parts,
      cleared,
      correction,
      difficulty,
      skills,
    };
  }

  // ---- the four button operations ----

  type Parts = { total: number; answered: number };

  // Reply latches shared by check and finish: the correction pair for the lesson card,
  // and the ADDITIVE reference growth for a sub-part the cache does not cover yet
  // (line-deduped — a new "x = 2" must latch even though it occurs inside an older
  // "3x = 21" — and size-bounded; the label still moves past the bound, or a full
  // cache would swallow every later sub-part's spoken confirmation). A genuinely new
  // part re-opens the one-lesson budget.
  function applyLatches(r: Reply): void {
    if (r.correction.wrong || r.correction.right) lastCorrection = r.correction;
    if (!r.solution) return;
    const seen = new Set(cachedSolution.split('\n').map((l) => l.trim()));
    const fresh = r.solution.split('\n').filter((l) => l.trim() && !seen.has(l.trim()));
    if (!fresh.length) return;
    if (cachedSolution.length < 4000) {
      cachedSolution += `\n${fresh.join('\n')}`;
      lastSteps = solutionSteps();
    }
    if (r.problem && r.problem !== cachedProblem) {
      cachedProblem = r.problem;
      lessonCaptured = false;
    }
  }

  /**
   * "Problem written": read the statement, derive and cache the reference solution.
   *
   * Invariants: a partly (or fully) solved page is NOT a failure — the model reads
   * only the original statement and grades nothing on this pass. A statement it
   * cannot determine leaves the cache untouched and reports captured=false, so the
   * UI says so explicitly and the learner presses again (no silent retry loop). A
   * re-press re-reads the whole statement and REPLACES the reference on success —
   * that is how "I added part c)" is handled — while a failed re-solve keeps the old
   * reference alive. With `statementOverride` (the learner edited the read-back) the
   * given TEXT is the problem, authoritative over the ink, and the read-back shown
   * afterwards is the confirmed text.
   */
  async function solveProblem(
    imageDataUrl: string,
    mode: Mode,
    statementOverride?: string,
  ): Promise<{ captured: boolean; problem: string; statement?: string; parts?: Parts; ungraded?: boolean }> {
    const { data, mediaType } = decodeImage(imageDataUrl);
    const s = session;
    const r = await callModel(
      settings.api.solveModel,
      'medium',
      'solve',
      data,
      mediaType,
      mode,
      solveContext(statementOverride),
      settings.api.trackSkills,
    );
    if (s !== session) return { captured: false, problem: '' };
    if (r.ungraded) return { captured: false, problem: '', ungraded: true };
    if (!r.solution) return { captured: false, problem: '', parts: r.parts };
    cachedSolution = r.solution;
    if (r.problem) cachedProblem = r.problem;
    capturedStatement = r.statement || statementOverride || '';
    // A replaced reference invalidates the old reading's confirmations.
    confirmedParts.clear();
    lastSteps = solutionSteps();
    recordMembership(r);
    if (import.meta.env.DEV) {
      console.debug(
        `[nuclear-learning] capture: solution ${r.solution.length} chars, problem=${JSON.stringify(r.problem)}, parts=${JSON.stringify(r.parts)}, statement=${JSON.stringify(capturedStatement)}`,
      );
    }
    return { captured: true, problem: cachedProblem, statement: capturedStatement, parts: r.parts };
  }

  // check/hint/finish run the capture pass themselves when no reference exists yet,
  // so a forgotten "problem written" press costs one extra call instead of a refusal.
  async function ensureSolution(
    imageDataUrl: string,
    mode: Mode,
  ): Promise<{ ok: boolean; ungraded?: boolean }> {
    if (cachedSolution !== '') return { ok: true };
    const r = await solveProblem(imageDataUrl, mode);
    return { ok: r.captured, ungraded: r.ungraded };
  }

  // Lock in the sub-questions a grading reply confirmed. Multi-part pages only: on a
  // single-question page an early "confirmed" would suppress legitimate flags on the
  // work that follows.
  function recordCleared(r: Reply): void {
    if ((r.parts?.total ?? 0) <= 1) return;
    for (const label of r.cleared) {
      const key = normLabel(label);
      if (key) confirmedParts.set(key, label);
    }
  }

  /**
   * "Check": grade the settled work so far.
   *
   * Invariants: OK means every settled line is right — the caller turns that into a
   * spoken positive, because a pressed button must answer; silence was the scan
   * loop's idiom, not this one's. Mid-written lines never produce errors (the prompt
   * judges settled ink only), so checking too early is safe. Never returns CORRECT:
   * completion belongs to the finish button, and a stray CORRECT from the model is
   * coerced to OK here so the solved counter and auto-clear can never fire from a
   * check. An unusable reply comes back `ungraded` instead of posing as a clean OK.
   */
  async function checkWork(
    imageDataUrl: string,
    mode: Mode,
  ): Promise<{
    verdict: string;
    display: string;
    parts?: Parts;
    ungraded?: boolean;
    noProblem?: boolean;
    statement?: string;
  }> {
    const s = session;
    const hadReference = cachedSolution !== '';
    const ready = await ensureSolution(imageDataUrl, mode);
    if (s !== session) return { verdict: 'OK', display: '' };
    if (!ready.ok) return { verdict: 'OK', display: '', ungraded: ready.ungraded, noProblem: !ready.ungraded };
    const { data, mediaType } = decodeImage(imageDataUrl);
    const r = await callModel(
      settings.api.verifyModel,
      settings.api.verifyEffort,
      'verify',
      data,
      mediaType,
      mode,
      checkContext(),
    );
    if (s !== session) return { verdict: 'OK', display: '' };
    if (r.ungraded) return { verdict: 'OK', display: '', ungraded: true };
    applyLatches(r);
    recordCleared(r);
    const verdict = isCorrect(r.verdict) ? 'OK' : r.verdict;
    recordVerdict(verdict);
    return {
      verdict,
      display: isCorrect(r.verdict) ? '' : r.display,
      parts: r.parts,
      // The auto-capture ran inside this press: surface its read-back for the panel.
      statement: hadReference ? undefined : capturedStatement,
    };
  }

  /**
   * "Hint": the stuck signal.
   *
   * Invariants: always a sentence, never a verdict — a blocking settled error gets
   * its diagnosis, otherwise the next step's theory, one ladder level deeper per
   * press while the page is unchanged (the caller measures that in strokes, not
   * time, so thinking long never escalates by itself). A model that answers OK or
   * CORRECT against the contract yields hint='' and the UI reports a failed hint
   * rather than speaking a bogus confirmation.
   */
  async function getHint(
    imageDataUrl: string,
    mode: Mode,
    unchangedSinceLastHint: boolean,
  ): Promise<{
    hint: string;
    display: string;
    ungraded?: boolean;
    noProblem?: boolean;
    statement?: string;
  }> {
    const s = session;
    const hadReference = cachedSolution !== '';
    const ready = await ensureSolution(imageDataUrl, mode);
    if (s !== session) return { hint: '', display: '' };
    if (!ready.ok) return { hint: '', display: '', ungraded: ready.ungraded, noProblem: !ready.ungraded };
    const { data, mediaType } = decodeImage(imageDataUrl);
    const r = await callModel(
      settings.api.solveModel,
      'medium',
      'hint',
      data,
      mediaType,
      mode,
      hintContext(unchangedSinceLastHint),
    );
    if (s !== session) return { hint: '', display: '' };
    if (r.ungraded) return { hint: '', display: '', ungraded: true };
    if (isQuiet(r.verdict) || isCorrect(r.verdict)) return { hint: '', display: '' };
    hints.push(r.verdict);
    if (hints.length > 4) hints.shift(); // enough for the full ladder, bounded re-send
    return {
      hint: r.verdict,
      display: r.display,
      statement: hadReference ? undefined : capturedStatement,
    };
  }

  /**
   * "Ask": a typed question about the page in hand.
   *
   * Invariants: the answer is conversation, never a verdict — nothing latches into
   * the solution cache, the verdict history, or the hint ladder, and no skill signal
   * is deposited. Grounded like a grading request (page image, statement of record,
   * reference, prior feedback), plus the page's own Q&A trail so follow-ups compose.
   * Auto-captures like check/hint when no reference exists yet, so asking first
   * costs one extra call instead of a refusal. Attached notes ride along as compact
   * transcript text. The question itself is learning signal: when the reply judges
   * it capture-worthy (a gap, or an expansion worth practicing), a background card
   * call folds it into the lesson deck — the deck is the only thing an ask ever
   * writes, so asking stays safe. `revealed` reports the captured line so the panel
   * can say so.
   */
  async function askQuestion(
    imageDataUrl: string,
    mode: Mode,
    question: string,
    attachedNotes?: AskNoteBlock[],
  ): Promise<{
    answer: string;
    display: string;
    revealed?: string;
    ungraded?: boolean;
    noProblem?: boolean;
    statement?: string;
  }> {
    const s = session;
    const hadReference = cachedSolution !== '';
    const ready = await ensureSolution(imageDataUrl, mode);
    if (s !== session) return { answer: '', display: '' };
    if (!ready.ok) return { answer: '', display: '', ungraded: ready.ungraded, noProblem: !ready.ungraded };
    const { data, mediaType } = decodeImage(imageDataUrl);
    const content: unknown[] = [
      { type: 'text', text: askContext(question, attachedNotes) },
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
    ];
    const model = settings.api.solveModel;
    const params: any = {
      model,
      max_completion_tokens: settings.api.maxTokens,
      messages: [
        { role: 'system', content: mode.systemPrompt },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'ask', strict: true, schema: ASK_SCHEMA } },
    };
    if (modelInfo(model).effort) params.reasoning_effort = 'medium';
    const resp = await createCompletion(params);
    logUsage(resp, mode, model, 'ask');
    if (s !== session) return { answer: '', display: '' };
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    let answer = '';
    let display = '';
    let revealKind: 'gap' | 'expansion' | null = null;
    let revealWhat = '';
    try {
      const parsed = JSON.parse(out);
      answer = cleanText(parsed.answer).trim();
      display = cleanText(parsed.display).trim();
      // Best-effort like the skill tags: a malformed judgment can never block the answer.
      const rv = parsed?.reveals;
      if (rv && (rv.kind === 'gap' || rv.kind === 'expansion')) {
        revealKind = rv.kind;
        revealWhat = cleanText(rv.what).trim();
      }
    } catch {
      console.warn(
        `[nuclear-learning] ask reply unusable (finish_reason=${resp.choices?.[0]?.finish_reason}, ${out.length} chars); nothing to show. If 'length', raise Max tokens.`,
      );
      return { answer: '', display: '', ungraded: true };
    }
    if (!answer) return { answer: '', display: '', ungraded: true };
    asks.push({ q: question, a: answer });
    if (asks.length > 4) asks.shift(); // enough context for follow-ups, bounded re-send
    if (revealKind && revealWhat) {
      void buildAskLesson({
        modeId: mode.id,
        modeLabel: mode.label,
        problem: cachedProblem,
        question,
        answer,
        what: revealWhat,
        kind: revealKind,
        solution: cachedSolution,
      });
    }
    return {
      answer,
      display,
      revealed: revealKind ? revealWhat : undefined,
      statement: hadReference ? undefined : capturedStatement,
    };
  }

  /**
   * "Finish": the learner declares the page done.
   *
   * Invariants: CORRECT requires every sub-question answered and right — ink marks
   * play no role — and only a finish CORRECT counts a solve, captures the lesson,
   * and deposits skill signal. Anything else is one sentence naming the FIRST
   * blocker (unanswered sub-question, diverging step, or an illegibility rewrite),
   * so an early finish press is a status report, not a failure. A bare OK from the
   * model breaks the finish contract and is reported `ungraded` instead of being
   * read as approval. Pressing finish again after CORRECT re-confirms audibly but
   * can never double-count the solve.
   */
  async function finishCheck(
    imageDataUrl: string,
    mode: Mode,
  ): Promise<{
    verdict: string;
    display: string;
    parts?: Parts;
    ungraded?: boolean;
    noProblem?: boolean;
    statement?: string;
  }> {
    const s = session;
    const hadReference = cachedSolution !== '';
    const ready = await ensureSolution(imageDataUrl, mode);
    if (s !== session) return { verdict: 'OK', display: '' };
    if (!ready.ok) return { verdict: 'OK', display: '', ungraded: ready.ungraded, noProblem: !ready.ungraded };
    const { data, mediaType } = decodeImage(imageDataUrl);
    const r = await callModel(
      settings.api.confirmModel,
      'medium',
      'confirm',
      data,
      mediaType,
      mode,
      finishContext(),
      settings.api.trackSkills,
    );
    if (s !== session) return { verdict: 'OK', display: '' };
    if (r.ungraded || isQuiet(r.verdict)) {
      return { verdict: 'OK', display: '', ungraded: true, parts: r.parts };
    }
    applyLatches(r);
    recordCleared(r);
    recordVerdict(r.verdict);
    if (isCorrect(r.verdict)) {
      captureSkills(r);
      maybeCaptureLesson(r.verdict, mode);
    }
    return {
      verdict: r.verdict,
      display: r.display,
      parts: r.parts,
      statement: hadReference ? undefined : capturedStatement,
    };
  }

  /** Commit a verdict to the page's session memory (kept distinct). */
  function recordVerdict(text: string): void {
    if (!text || isQuiet(text)) return;
    const key = normalize(text);
    if (!history.some((h) => normalize(h) === key)) {
      history.push(text);
      // Keep only the last few verdicts as context, enough for consistency and a full
      // 3-level hint ladder, small enough to keep re-sent input down on every request.
      // Evict in safety order — oldest CORRECT first, then nudges, then the oldest entry —
      // and never the newest entry: unresolved error sentences are the ladder position and
      // the verbatim source the repeat rule and the audio dedup key on.
      if (history.length > 6) {
        const evictable = history.slice(0, -1);
        let i = evictable.findIndex((h) => isCorrect(h));
        if (i < 0) i = evictable.findIndex((h) => isReadNudge(h) || isFinishNudge(h));
        history.splice(i >= 0 ? i : 0, 1);
      }
    }
  }

  function isCorrect(text: string): boolean {
    // The whole verdict must BE the token: a prefix match turned an imperative English
    // hint ("Correct the sign in ...") into a false CORRECT with chime and auto-clear.
    return /^\s*correct[.!]?\s*$/i.test(text);
  }

  // "OK" = correct so far / nothing to report yet. Produces no audio and is not
  // recorded, keeps the tool silent while the learner is progressing correctly.
  function isQuiet(text: string): boolean {
    return /^\s*ok[.!]?\s*$/i.test(text);
  }

  // Identity used to suppress replayed audio. The grader is instructed to repeat a
  // still-unresolved error word for word (there is no step-number prefix to key on), so
  // plain normalized text is the key. CORRECT keys on the problem label: two problems
  // finished on the same page must each earn their own spoken confirmation.
  function deliveryKey(text: string): string {
    if (isCorrect(text)) return `correct::${normalize(cachedProblem)}`;
    return normalize(text);
  }

  let speakTimer: number | undefined;

  function speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    // Speak the math as words, not the raw notation. Without this the engine reads "$x^2$"
    // as "dollar x caret two dollar" and drops symbols like √ ≤ ∫; mathToSpeech turns them
    // into spoken German maths, leaving the surrounding prose untouched. The voice is
    // pinned to de-DE whatever the problem's language: feedback is German by contract.
    const spoken = mathToSpeech(text, 'de');
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = 'de-DE';
    utterance.rate = settings.audio.rate;
    if (speakTimer) window.clearTimeout(speakTimer);
    window.speechSynthesis.cancel();
    // Chrome intermittently swallows an utterance queued synchronously after cancel();
    // a tick of separation makes delivery reliable. resetSession clears the timer so a
    // pending sentence can never speak onto the next page.
    speakTimer = window.setTimeout(() => {
      speakTimer = undefined;
      window.speechSynthesis.speak(utterance);
    }, 60);
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

  // What a verdict says out loud / on screen. A CORRECT verdict becomes a plain spoken
  // confirmation, never the literal token; every other verdict is delivered as written.
  function describe(text: string, _mode: Mode): string {
    if (isCorrect(text)) {
      return 'Das stimmt.';
    }
    return text;
  }

  /**
   * Deliver a verdict or hint as audio. Repeats are suppressed unless `force`: a
   * button press is an explicit ask, so the caller forces and the same sentence may
   * play again. The solved counter still counts once per problem (only the FIRST
   * CORRECT delivery), so re-pressing finish can never double-count. `chime` false
   * keeps hints from sounding like flagged errors.
   */
  function deliver(text: string, mode: Mode, force = false, chime = true): boolean {
    if (!text || isQuiet(text)) return false;
    const key = deliveryKey(text);
    const fresh = !spokenKeys.has(key);
    if (!fresh && !force) return false;
    spokenKeys.add(key);
    if (isCorrect(text) && fresh) noteSolved();
    // A correct answer is spoken, not chimed ("say it is correct, don't mark it").
    const markSilently = isCorrect(text);
    if (chime && (mode.feedbackStyle === 'chime' || mode.feedbackStyle === 'both') && !markSilently) {
      playChime(isCorrect(text));
    }
    if (mode.feedbackStyle === 'spoken' || mode.feedbackStyle === 'both') {
      speak(describe(text, mode));
    }
    return true;
  }

  /** Start a fresh page: forget prior verdicts and stop any in-flight speech. */
  function resetSession(): void {
    session += 1; // in-flight requests of the old page may no longer write anything back
    // Abandon hook (runs before state is cleared): if a page never resolved CORRECT but
    // kept showing an error, deposit a 'wrong' on the solve-time membership's core skills
    // so the estimator sees losses, not only wins. Reuses the solve-time membership, so
    // there is no extra solve-model call. A hedged-but-correct page deposits a clean instead.
    // Illegibility nudges are not mathematical errors, so they can never turn a page 'wrong'.
    if (settings.api.trackSkills && !skillApplied && skillMembership) {
      const errors = history.filter(
        (h) => h && !isQuiet(h) && !isCorrect(h) && !isReadNudge(h) && !isFinishNudge(h),
      );
      const hadError = errors.length >= 1;
      const sig: 'clean' | 'wrong' | null = pageReachedCorrect ? 'clean' : hadError ? 'wrong' : null;
      if (sig) {
        const all = skillMembership.skills ?? [];
        const core = all.filter((o) => o.role === 'core');
        const tagged = (core.length ? core : all).map((o) => ({ ...o, signal: sig }));
        applySkillPacket(
          { difficulty: skillMembership.difficulty, skills: tagged, rungs: deliveredRungs() },
          lastSteps,
          Date.now(),
          { source: 'abandon', label: cachedProblem },
        );
      }
    }
    history.length = 0;
    hints.length = 0;
    asks.length = 0;
    spokenKeys.clear();
    cachedSolution = '';
    cachedProblem = '';
    capturedStatement = '';
    confirmedParts.clear();
    lessonCaptured = false;
    lastCorrection = null;
    skillMembership = null;
    skillApplied = false;
    pageReachedCorrect = false;
    lastSteps = 0;
    newPage();
    if (speakTimer) {
      window.clearTimeout(speakTimer);
      speakTimer = undefined;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  // Whether the strong model has worked out and cached a solution for the current problem. Lets the
  // UI tell "still solving (no reference yet)" apart from "solved, and the work so far looks fine".
  function hasSolution(): boolean {
    return cachedSolution !== '';
  }

  // What the archive stores about the current page: the label, the statement of
  // record, and the reference. Read-only snapshot; archiving must never mutate the
  // session (and a Clear right after archiving must not reach into the snapshot).
  function pageSnapshot(): { problem: string; statement: string; solution: string } {
    return { problem: cachedProblem, statement: capturedStatement, solution: cachedSolution };
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
    solveProblem,
    checkWork,
    getHint,
    askQuestion,
    finishCheck,
    deliver,
    describe,
    resetSession,
    speak,
    playChime,
    isCorrect,
    isQuiet,
    hasSolution,
    pageSnapshot,
  };
}
