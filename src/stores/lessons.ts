import { reactive } from 'vue';
import { generateLessonCard } from '@/lessonCard';

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
  // Tailored review card written by a dedicated Sonnet call (see lessonCard.ts):
  // `front` is a specific recall question, `back` the answer, both with math in LaTeX.
  // Optional; cards captured before this, or when the call failed, fall back to the
  // correction / hint. `regenerateCards()` backfills them.
  front?: string;
  back?: string;
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
// Interval per box. Box 0 is due immediately (this session); each "Got it" moves
// up a box for a longer rest, each "Again" drops back to box 0.
const INTERVALS_MS = [0, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
const MAX_BOX = INTERVALS_MS.length - 1;

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
}): void {
  const mistake = input.mistake.trim();
  if (!mistake) return;
  const problem = input.problem.trim();
  const wrong = (input.wrong ?? '').slice(0, MAX_SOLUTION);
  const right = (input.right ?? '').slice(0, MAX_SOLUTION);
  const front = (input.front ?? '').slice(0, MAX_SOLUTION);
  const back = (input.back ?? '').slice(0, MAX_SOLUTION);

  const dup = lessonStore.lessons.find(
    (l) => l.mode === input.mode && norm(l.mistake) === norm(mistake) && norm(l.problem) === norm(problem),
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
  l.lastReviewed = now;
  l.reps += 1;
  if (remembered) {
    l.box = Math.min(l.box + 1, MAX_BOX);
  } else {
    l.box = 0;
    l.lapses += 1;
  }
  l.due = now + INTERVALS_MS[l.box];
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
export function dueLessons(now = Date.now()): Lesson[] {
  return lessonStore.lessons
    .filter((l) => l.due <= now)
    .sort((a, b) => a.box - b.box || a.due - b.due);
}

/**
 * Backfill tailored cards onto stored lessons by calling the Sonnet card writer for
 * each one. By default it only touches lessons without a `front` (the old cards), so
 * it is cheap and safe to run repeatedly; pass `force` to rewrite every card. Runs
 * sequentially and persists after each so progress is never lost. Returns how many it
 * filled. Exposed as `__nlLessons.rebuild()`.
 */
export async function regenerateCards(force = false): Promise<number> {
  const targets = lessonStore.lessons.filter((l) => force || !l.front);
  let done = 0;
  for (const l of targets) {
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
  console.info(`[nuclear-learning] rebuilt ${done}/${targets.length} lesson card(s)`);
  return done;
}

export function lessonStats(now = Date.now()) {
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
