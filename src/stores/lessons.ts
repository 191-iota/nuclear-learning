import { reactive, ref } from 'vue';
import { generateAskCard, generateLessonCard } from '@/lessonCard';
import { logEvent } from '@/stores/obslog';

/**
 * Lessons = your own corrected mistakes, captured for free.
 *
 * When the grader flags an error ("Step 3: check your sign") and you then fix it
 * so the problem turns CORRECT, that error is logged here, no extra API call, the
 * data is already in hand from the scan that judged you (see useFeedback). The
 * Lessons tab reviews them with active recall + spaced repetition, which is where
 * the retention comes from: re-testing your own corrected error right after the
 * feedback is the "hypercorrection effect", the most memorable kind of correction.
 *
 * Console access:  __nlLessons.all() · __nlLessons.due() · __nlLessons.clear()
 */
export interface Lesson {
  id: string;
  ts: number; // created (ms epoch)
  mode: string;
  modeLabel: string;
  problem: string; // short label of the problem (may be '')
  mistake: string; // the corrected error hint, verbatim (the live nudge)
  solution: string; // worked solution, for the reveal (may be '')
  // Learner-facing correction captured when the problem turned CORRECT: what was
  // actually wrong and the right version, with math in LaTeX so the review card can
  // render it. Optional, older persisted lessons (v1) predate these and fall back to
  // `mistake`.
  wrong?: string;
  right?: string;
  // Tailored review card written by a dedicated gpt-5.4-mini call (see lessonCard.ts):
  // `front` is a specific recall question, `back` the answer, both with math in LaTeX.
  // Optional; cards captured before this, or when the call failed, fall back to the
  // correction / hint. `regenerateCards()` backfills them.
  front?: string;
  back?: string;
  // Where the card came from. Error cards (the original kind) omit this. Ask-derived
  // cards carry it: 'ask-gap' = a typed question revealed a rule or connection not
  // firmly held (recall front), 'ask-expansion' = the question reached for an adjacent
  // technique worth practicing (small do-it task on a fresh instance as the front).
  // For these, `mistake` holds the question verbatim and `note` the one-line naming of
  // what it revealed (the rebuild path regenerates the card from both).
  kind?: 'ask-gap' | 'ask-expansion';
  note?: string;
  // Ask-card writer generation. 2 = the theory-first pipeline (card written on the
  // underlying rule, deck checked for coverage before writing). Ask cards below it
  // predate that pipeline and are counted by needsRewrite() until Rebuild re-writes
  // them. Error cards never carry it.
  gen?: number;
  // Spaced-repetition state (Leitner box system).
  box: number; // 0..MAX_BOX, higher = longer interval
  due: number; // next review time (ms epoch)
  reps: number; // total reviews
  lapses: number; // times forgotten on review
  lastReviewed: number; // 0 if never
  seen: number; // times this same mistake was captured (recurrence signal)
}

const KEY = 'nl.lessons.v1';
const MAX_LESSONS = 500;
const MAX_SOLUTION = 1200; // cap stored solution length to keep localStorage small

const DAY = 86_400_000;
// Interval per box. Box 0 is due immediately (this session); each "Got it" moves up a box for a
// longer rest, each "Again" drops down two boxes (a partial demote, not a full reset). Extended
// past the old 21-day ceiling toward an exam horizon so a well-known card can rest for months
// instead of being pinned at 21 days forever.
const INTERVALS_MS = [0, DAY, 3 * DAY, 7 * DAY, 21 * DAY, 45 * DAY, 90 * DAY];
export const MAX_BOX = INTERVALS_MS.length - 1;

// A coarse reactive clock (one tick per minute) that due-ness reads through, so a card
// falling due while the app just sits open actually appears — computeds over the store
// alone never re-evaluate as time passes.
const clock = ref(Date.now());
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    clock.value = Date.now();
  }, 60_000);
}
export function nowTick(): number {
  return clock.value;
}

interface Persisted {
  lessons: Lesson[];
}

function load(): Persisted {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Persisted;
      if (Array.isArray(parsed.lessons)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return { lessons: [] };
}

export const lessonStore = reactive(load());

// One-time cleanup on load: purge illegibility-nudge cards that should never have been captured
// (e.g. "Can't read step 1, rewrite it."), and persist so they do not come back.
{
  const before = lessonStore.lessons.length;
  lessonStore.lessons = lessonStore.lessons.filter(
    (l) => !isReadNudge(l.mistake) && !isReadNudge(l.front ?? ''),
  );
  if (lessonStore.lessons.length !== before) persist();
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lessonStore));
  } catch {
    /* storage full / unavailable, non-fatal */
  }
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Illegibility nudges ("Can't read step N, rewrite it.") are not learnable mistakes and must not
// live in the deck; drop any that slipped in before capture filtered them out.
function isReadNudge(s: string): boolean {
  // Mirrors useFeedback's contract; no bare "rewrite it" branch, which a level-4 hint
  // can legitimately contain.
  return /can.?t read|illegible|unleserlich|nicht lesen/i.test(s);
}

// A card front is "bad" if empty, or a bare expression (the answer copied onto the front with no
// natural-language prose) — the exact regression the weak card writer produced. Used to flag cards
// for Rebuild (mirrors the generator's own reject guard in lessonCard.ts).
export function isBadFront(l: Lesson): boolean {
  const f = (l.front ?? '').trim();
  if (!f) return true;
  const prose = /[a-zA-ZäöüÄÖÜ]{2,}/.test(f.replace(/\$[^$]*\$/g, ' '));
  return !f.includes('?') && !prose;
}

// A card Rebuild should re-write: a bad front, or an ask card from before the
// theory-first writer (those anchored on the question's wording and never checked
// the deck for existing coverage).
export function needsRewrite(l: Lesson): boolean {
  return isBadFront(l) || (!!l.kind && (l.gen ?? 1) < 2);
}

// Compact one-line-per-card view of the deck for the ask writer's coverage check.
// Newest first, capped; the card being rewritten passes its own id to be excluded,
// or everything reads as already covered by itself.
export function deckSummary(excludeId?: string, cap = 40): string[] {
  const line = (l: Lesson) =>
    l.kind ? l.front || l.note || l.mistake : l.front || l.wrong || l.mistake;
  return [...lessonStore.lessons]
    .filter((l) => l.id !== excludeId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, cap)
    .map((l) => line(l).replace(/\s+/g, ' ').trim().slice(0, 140))
    .filter(Boolean);
}

let counter = 0;

/**
 * Record a corrected mistake. Called from the feedback loop the moment a problem
 * turns CORRECT after an error, the inputs are already in hand, so this costs
 * nothing. If the same mistake on the same problem was logged most recently, it is
 * resurfaced (re-due now, box reset) and its `seen` count bumped rather than
 * duplicated, repeating a mistake should bring it back, not clutter the deck.
 */
export function addLesson(input: {
  mode: string;
  modeLabel: string;
  problem: string;
  mistake: string;
  solution: string;
  wrong?: string;
  right?: string;
  front?: string;
  back?: string;
  kind?: 'ask-gap' | 'ask-expansion';
  note?: string;
  gen?: number;
}): void {
  const mistake = input.mistake.trim();
  if (!mistake) return;
  const problem = input.problem.trim();
  const wrong = (input.wrong ?? '').slice(0, MAX_SOLUTION);
  const right = (input.right ?? '').slice(0, MAX_SOLUTION);
  const front = (input.front ?? '').slice(0, MAX_SOLUTION);
  const back = (input.back ?? '').slice(0, MAX_SOLUTION);

  // Ask cards carry theory, so their identity IS the card front (the same gap asked
  // in different words writes the same card); error cards keep the mistake+problem
  // key. A front-match resurfaces the existing card instead of cluttering the deck.
  const dup = lessonStore.lessons.find((l) =>
    input.kind
      ? !!l.kind && !!front && norm(l.front ?? '') === norm(front)
      : l.mode === input.mode && norm(l.mistake) === norm(mistake) && norm(l.problem) === norm(problem),
  );
  if (dup) {
    dup.seen += 1;
    dup.box = 0;
    dup.due = Date.now();
    if (input.solution) dup.solution = input.solution.slice(0, MAX_SOLUTION);
    if (wrong) dup.wrong = wrong;
    if (right) dup.right = right;
    if (front) dup.front = front;
    if (back) dup.back = back;
    if (input.kind) dup.kind = input.kind;
    if (input.note) dup.note = input.note.slice(0, 300);
    if (input.gen) dup.gen = input.gen;
    persist();
    return;
  }

  counter += 1;
  lessonStore.lessons.push({
    id: `${Date.now()}-${counter}`,
    ts: Date.now(),
    mode: input.mode,
    modeLabel: input.modeLabel,
    problem,
    mistake,
    solution: input.solution.slice(0, MAX_SOLUTION),
    wrong,
    right,
    front,
    back,
    kind: input.kind,
    note: input.note?.slice(0, 300),
    gen: input.gen,
    box: 0,
    due: Date.now(), // due immediately for the first review
    reps: 0,
    lapses: 0,
    lastReviewed: 0,
    seen: 1,
  });
  if (lessonStore.lessons.length > MAX_LESSONS) {
    lessonStore.lessons.splice(0, lessonStore.lessons.length - MAX_LESSONS);
  }
  persist();
}

/** Grade a review. `remembered` advances a box (longer rest); otherwise reset. */
export function reviewLesson(id: string, remembered: boolean): void {
  const l = lessonStore.lessons.find((x) => x.id === id);
  if (!l) return;
  const now = Date.now();
  const boxBefore = l.box;
  const elapsedSinceDue = now - l.due; // snapshot before `due` is reassigned below
  l.lastReviewed = now;
  l.reps += 1;
  if (remembered) {
    l.box = Math.min(l.box + 1, MAX_BOX);
  } else {
    // Partial demote, not a full reset: a slip on a well-spaced card drops it two boxes rather than
    // nuking months of earned spacing back to zero and forcing a full re-climb of the ladder.
    l.box = Math.max(0, l.box - 2);
    l.lapses += 1;
  }
  l.due = now + INTERVALS_MS[l.box];
  // The review log: without it no scheduler is ever fittable and grade honesty is
  // unauditable. elapsedSinceDue is the adherence signal (how late the review ran).
  logEvent('review', {
    id: l.id,
    grade: remembered,
    boxBefore,
    boxAfter: l.box,
    elapsedSinceDue,
    reps: l.reps,
    lapses: l.lapses,
  });
  persist();
}

export function removeLesson(id: string): void {
  const i = lessonStore.lessons.findIndex((x) => x.id === id);
  if (i >= 0) {
    lessonStore.lessons.splice(i, 1);
    persist();
  }
}

export function clearLessons(): void {
  lessonStore.lessons.splice(0, lessonStore.lessons.length);
  persist();
}

/** Lessons due now, soonest-overdue and lowest-box first (weakest items lead). */
export function dueLessons(now = nowTick()): Lesson[] {
  return lessonStore.lessons
    .filter((l) => l.due <= now)
    .sort((a, b) => a.box - b.box || a.due - b.due);
}

/**
 * Backfill tailored cards onto stored lessons by calling the gpt-5.4-mini card writer for
 * each one. By default it only touches lessons without a `front` (the old cards), so
 * it is cheap and safe to run repeatedly; pass `force` to rewrite every card. Runs
 * sequentially and persists after each so progress is never lost. Returns how many it
 * filled. Exposed as `__nlLessons.rebuild()`.
 */
// The in-flight guard lives HERE, not in the view: LessonsView unmounts on tab switch,
// so a component-local flag forgot a loop that was still running and a second click
// started a second loop over the same targets (double spend, racing writes).
let rebuildP: Promise<number> | null = null;
export const rebuildState = reactive({ running: false });

export function regenerateCards(force = false): Promise<number> {
  if (rebuildP) return rebuildP;
  rebuildState.running = true;
  rebuildP = (async () => {
    const targets = lessonStore.lessons.filter((l) => force || needsRewrite(l));
    let done = 0;
    let folded = 0;
    for (const l of targets) {
      if (l.kind) {
        // Ask-derived cards rebuild through the theory-first ask writer: their
        // `mistake` is the typed question, no flagged error, so the mistake writer
        // would invent a wrong-flavored card out of it. The writer sees the rest of
        // the deck; a card whose knowledge another card already tests comes back
        // `covered` and is folded out of the deck instead of rewritten.
        const card = await generateAskCard({
          problem: l.problem,
          question: l.mistake,
          answer: '',
          what: l.note ?? '',
          kind: l.kind === 'ask-gap' ? 'gap' : 'expansion',
          solution: l.solution,
          mode: l.mode,
          deck: deckSummary(l.id),
        });
        if (!card) continue;
        if (card.covered) {
          const i = lessonStore.lessons.findIndex((x) => x.id === l.id);
          if (i >= 0) {
            lessonStore.lessons.splice(i, 1);
            folded += 1;
            persist();
          }
          continue;
        }
        l.front = card.front.slice(0, MAX_SOLUTION);
        l.back = card.back.slice(0, MAX_SOLUTION);
        l.gen = 2;
        done += 1;
        persist();
        continue;
      }
      const card = await generateLessonCard({
        problem: l.problem,
        mistake: l.mistake,
        solution: l.solution,
        wrong: l.wrong,
        right: l.right,
        mode: l.mode,
      });
      if (card && (card.front || card.back)) {
        l.front = card.front.slice(0, MAX_SOLUTION);
        l.back = card.back.slice(0, MAX_SOLUTION);
        done += 1;
        persist();
      }
    }
    console.info(
      `[nuclear-math] rebuilt ${done}/${targets.length} lesson card(s)${folded ? `, folded ${folded} duplicate(s)` : ''}`,
    );
    return done;
  })().finally(() => {
    rebuildP = null;
    rebuildState.running = false;
  });
  return rebuildP;
}

export function lessonStats(now = nowTick()) {
  let due = 0;
  let mastered = 0;
  for (const l of lessonStore.lessons) {
    if (l.due <= now) due += 1;
    if (l.box >= MAX_BOX) mastered += 1;
  }
  const total = lessonStore.lessons.length;
  return { total, due, mastered, learning: total - mastered };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlLessons: unknown }).__nlLessons = {
    all: () => lessonStore.lessons.slice(),
    due: () => dueLessons(),
    stats: () => lessonStats(),
    rebuild: (force = false) => regenerateCards(force),
    clear: clearLessons,
  };
}
