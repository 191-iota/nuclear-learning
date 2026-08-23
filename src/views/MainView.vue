<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { modes } from '@/stores/modes';
import { usePen, type PenDot } from '@/composables/usePen';
import { useCanvas } from '@/composables/useCanvas';
import { useTablet } from '@/composables/useTablet';
import { holdDue } from '@/composables/holdRepeat';
import { useFeedback } from '@/composables/useFeedback';
import MathText from '@/components/MathText.vue';
import { settings } from '@/stores/settings';
import { recommendPractice, solvedToday } from '@/stores/skills';
import { dueLessons, lessonStats, lessonStore, nowTick, type Lesson } from '@/stores/lessons';
import { generateDrill } from '@/drill';
import { makeThumb, practiceText, saveAufgabe } from '@/stores/archive';
import {
  folderPath,
  folderTree,
  notesInFolder,
  notesStore,
  resolveAskNotes,
  saveNoteFromPad,
} from '@/stores/notes';
import type { Mode } from '@/types';

const DOT_MOVE = 1;
const DOT_UP = 2;
const DOT_HOVER = 3;

const selectedModeId = ref(modes.value[0]?.id ?? '');
const activeMode = computed<Mode>(
  () => modes.value.find((m) => m.id === selectedModeId.value) ?? modes.value[0],
);

// If the selected preset is deleted/renamed in the Presets view, fall back.
watch(
  modes,
  () => {
    if (!modes.value.some((m) => m.id === selectedModeId.value)) {
      selectedModeId.value = modes.value[0]?.id ?? '';
    }
  },
  { deep: true },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const tabletCanvasRef = ref<HTMLCanvasElement | null>(null);
const padwrapRef = ref<HTMLDivElement | null>(null);
const canvas = useCanvas(canvasRef);
const tablet = useTablet(tabletCanvasRef, { onInk: onTabletInk });
const feedback = useFeedback();

// Which surface feeds the grader: the Neo pen's dot canvas or the tablet's stroke
// engine. Both expose the same contract (exportImage / hasContent / strokeCount /
// clear / resize), so every button below is source-agnostic.
const isTablet = computed(() => settings.input.source === 'tablet');
interface InkSurface {
  clear(): void;
  resize(): void;
  exportImage(): string;
  hasContent(): boolean;
  strokeCount(): number;
}
const surface = computed<InkSurface>(() => (isTablet.value ? tablet : canvas));

function onTabletInk(): void {
  // Writing again means you want to keep this page, call off any pending clear.
  if (autoClearLeft.value > 0) cancelAutoClear();
  inkPresent.value = true;
}

const lastFeedback = ref('');
const status = ref('');
// The statement as the capture pass read it, rendered in the panel as an editable
// read-back: a misread given is caught by a glance right after "Problem written" and
// fixed by hand — confirming the edit re-solves against the corrected text, which
// then outranks the ink. Doing nothing accepts the read-back as the statement of
// record. No edit, no dialog, nothing blocks: the optional correction is the whole
// safety net against a misread digit.
const readStatement = ref('');
const editingStatement = ref(false);
const statementDraft = ref('');

function onEditStatement(): void {
  statementDraft.value = readStatement.value;
  editingStatement.value = true;
}

function onCancelStatement(): void {
  editingStatement.value = false;
}

// Re-solve against the corrected text. The old reference survives a failed re-solve
// (empty or unusable reply), so a bad edit cannot destroy a working page.
function onConfirmStatement(): void {
  const text = statementDraft.value.trim();
  if (!text) return;
  editingStatement.value = false;
  void runButton('Solving the corrected statement…', async (img, stale) => {
    const r = await feedback.solveProblem(img, activeMode.value, text);
    if (stale()) return;
    if (r.captured) {
      readStatement.value = r.statement ?? text;
      lastFeedback.value = `Problem captured from your correction: ${r.problem || '(unlabeled)'}${partsSuffix(r.parts)}`;
    } else {
      lastFeedback.value = r.ungraded
        ? UNUSABLE_MSG
        : 'Could not solve the corrected statement. Is it complete?';
    }
  });
}

// Auto-clear after a correct answer: once a problem is marked CORRECT, a short
// countdown clears the pad for the next problem unless you keep it (or write more).
const autoClearLeft = ref(0); // seconds remaining; 0 = inactive
let autoClearTimer: number | undefined;
// The seam controller (P02): ONE next-up item drawn from a shuffled merge of the first
// due card and the estimator's weak/fading targets, refreshed at the solved moment and
// on Clear, the two points where the learner decides what to write next. It lives in
// the panel's session section as one declarative row, never a card, never a queue:
// ignoring it costs nothing. Tapping it materializes the work (a drill call for a
// skill, the card front for a due lesson), pinned in its own panel section until Clear.
type NextUp =
  | { kind: 'drill'; id: string; label: string; masteryPct: number }
  | { kind: 'due'; lesson: Lesson };
const nextUp = ref<NextUp | null>(null);
const pinned = ref('');
const drillBusy = ref(false);
let drillRequest = 0;
// Panel dismissals: the pinned problem card closes via its own x, and the session
// card can be hidden for the rest of this app session (it returns on reload; nothing
// persisted, a dismissal is a mood, not a setting).
const sessionHidden = ref(false);
const DAY_MS = 86_400_000;

function pickNextUp() {
  const pool: NextUp[] = [];
  const due = dueLessons()[0];
  if (due) pool.push({ kind: 'due', lesson: due });
  const rec = recommendPractice();
  if (rec.drill) pool.push({ kind: 'drill', id: rec.drill.id, label: rec.drill.label, masteryPct: rec.drill.masteryPct });
  if (rec.review) pool.push({ kind: 'drill', id: rec.review.id, label: rec.review.label, masteryPct: rec.review.masteryPct });
  nextUp.value = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

const nextUpLabel = computed(() => {
  const n = nextUp.value;
  if (!n) return '';
  return n.kind === 'due'
    ? `next, review: ${n.lesson.problem || n.lesson.modeLabel}`
    : `next, drill: ${n.label}`;
});

// The session rows: what the day answers back, one declarative row each in the panel.
// Counts come from delivered CORRECTs and the lesson captures, never usage buckets.
const dayLine = computed(() => {
  const now = nowTick();
  const solved = solvedToday(now);
  if (solved === 0) return '';
  const capturedToday = lessonStore.lessons.filter(
    (l) => Math.floor(l.ts / DAY_MS) === Math.floor(now / DAY_MS),
  ).length;
  let s = `today: ${solved} solved`;
  if (capturedToday > 0) s += ` · ${capturedToday} captured`;
  return s;
});

const dueLine = computed(() => {
  const due = lessonStats(nowTick()).due;
  return due > 0 ? `${due} ${due === 1 ? 'card' : 'cards'} due` : '';
});

async function onNextUpTap() {
  if (drillBusy.value) return;
  const n = nextUp.value;
  if (!n) return;
  if (n.kind === 'due') {
    // Display-only v1: the card front comes to the pad's edge; grading the re-test in
    // ink is the P03 step and stays in the Lessons tab until then.
    pinned.value = n.lesson.front || n.lesson.mistake || '';
    nextUp.value = null;
    return;
  }
  const request = ++drillRequest;
  drillBusy.value = true;
  if (status.value === 'Drill generation failed.') status.value = '';
  try {
    const d = await generateDrill(n.id, n.masteryPct);
    if (request !== drillRequest) return;
    if (d) {
      pinned.value = `${d.task} ${d.problem}`.trim();
      nextUp.value = null;
    }
    else status.value = 'Drill generation failed.';
  } finally {
    drillBusy.value = false;
  }
}

function cancelAutoClear() {
  if (autoClearTimer) {
    window.clearInterval(autoClearTimer);
    autoClearTimer = undefined;
  }
  autoClearLeft.value = 0;
}

function startAutoClear() {
  const secs = settings.scan.autoClearSec ?? 0;
  if (secs <= 0 || autoClearLeft.value > 0) return; // disabled, or already counting
  pickNextUp();
  autoClearLeft.value = secs;
  autoClearTimer = window.setInterval(() => {
    autoClearLeft.value -= 1;
    if (autoClearLeft.value <= 0) {
      cancelAutoClear();
      startFreshPage(); // same as pressing Clear
    }
  }, 1000);
}

// Button-driven orchestration: nothing scans automatically anymore. One request in
// flight at a time (busy gates every button), a generation counter discards results
// that land after a Clear or preset switch, and inkPresent keeps the buttons off an
// empty pad.
const busy = ref(false);
const inkPresent = ref(false);
let generation = 0; // bumped on clear / mode change to discard stale in-flight requests
// Ink revision at the last successful hint: an unchanged revision at the next press
// means "still stuck at the same state", which is what advances the hint ladder one
// level. Ink, not time — thinking long never escalates by itself.
let strokesAtLastHint = -1;

// Physical-page identity from the pen's ncode dots. Flipping to a new paper page is a
// new problem: without this the new page's ink lands ON TOP of the old page's on the
// canvas and the model is sent the superimposed mess. Confirmed over several ink dots
// so one glitched pageInfo can never wipe a page the learner is still working on.
let pageKey: string | null = null;
let pendingPage: { key: string; count: number } | null = null;
const PAGE_FLIP_DOTS = 8;

function detectPageFlip(dot: PenDot): void {
  const pi = (dot as { pageInfo?: { section: number; owner: number; book: number; page: number } })
    .pageInfo;
  // Only real ink dots vote: hover streams while the pen floats over a NEIGHBOURING
  // page, and pen-down sentinels carry placeholder data.
  if (!pi || (dot.dotType !== DOT_MOVE && dot.dotType !== DOT_UP) || dot.x < 0 || dot.y < 0) return;
  const key = `${pi.section}/${pi.owner}/${pi.book}/${pi.page}`;
  if (pageKey === null || key === pageKey) {
    pageKey = key;
    pendingPage = null;
    return;
  }
  if (pendingPage?.key === key) pendingPage.count += 1;
  else pendingPage = { key, count: 1 };
  if (pendingPage.count >= PAGE_FLIP_DOTS) {
    pageKey = key;
    pendingPage = null;
    startFreshPage(); // the first few dots of the new page are a fraction of one stroke
  }
}

function onDot(dot: PenDot) {
  detectPageFlip(dot);
  canvas.addDot(dot);
  if (dot.dotType === DOT_HOVER) return;
  // Writing again means you want to keep this page, call off any pending clear.
  if (autoClearLeft.value > 0) cancelAutoClear();
  inkPresent.value = true;
}

const pen = usePen({ onDot });

// The tablet engine's ink state is authoritative in tablet mode: undoing the last
// stroke of a page disables the buttons again, exactly like a never-written pad.
watch(
  () => tablet.state.hasInk,
  (v) => {
    if (isTablet.value) inkPresent.value = v;
  },
);

watch(isTablet, () => {
  inkPresent.value = surface.value.hasContent();
  scheduleCanvasResize(); // the freshly shown canvas may carry a stale bitmap
});

const NO_PROBLEM_MSG =
  'Could not determine the problem statement. Is it fully on the page? Press again once it is.';
const UNUSABLE_MSG = 'The model reply was unusable. Press the button again.';
// check/hint/finish auto-capture when no reference exists yet; when that happened
// their result carries the read-back, and the panel must show it like a normal capture.
function absorbStatement(r: { statement?: string }): void {
  if (r.statement) readStatement.value = r.statement;
}

function partsSuffix(parts?: { total: number; answered: number }): string {
  return parts && parts.total > 1
    ? ` · ${Math.min(parts.answered, parts.total)} of ${parts.total} answered`
    : '';
}

// Every button shares one skeleton: refuse while a request is in flight or the pad is
// empty, snapshot the image, run, and drop the outcome if the page was cleared or the
// preset switched meanwhile (stale()). Errors surface in the status line and the same
// press is simply pressed again — no automatic retry loop to reason about.
async function runButton(
  label: string,
  op: (img: string, stale: () => boolean) => Promise<void>,
): Promise<void> {
  if (busy.value || !surface.value.hasContent()) return;
  busy.value = true;
  const gen = generation;
  const stale = () => gen !== generation;
  status.value = label;
  try {
    await op(surface.value.exportImage(), stale);
    status.value = '';
  } catch (err: any) {
    status.value = stale() ? '' : (err?.message ?? 'Error contacting OpenAI.');
  } finally {
    busy.value = false;
  }
}

// "Problem written": build the reference. A partly solved page is fine (the model
// reads only the statement); an undeterminable statement reports itself and keeps any
// earlier reference; a re-press re-reads the whole statement (that is how "I added
// part c)" is handled).
function onProblemWritten(): void {
  void runButton('Reading the problem…', async (img, stale) => {
    const r = await feedback.solveProblem(img, activeMode.value);
    if (stale()) return;
    if (r.captured) {
      readStatement.value = r.statement ?? '';
      lastFeedback.value = `Problem captured: ${r.problem || '(unlabeled)'}${partsSuffix(r.parts)}. Check the read-back on the right; the pencil fixes a misread.`;
    } else {
      lastFeedback.value = r.ungraded ? UNUSABLE_MSG : NO_PROBLEM_MSG;
    }
  });
}

// "Check": a pressed check always answers out loud — correct-so-far is spoken, not
// implied by silence — and a still-standing error repeats verbatim (forced through
// the audio dedup) because the press is an explicit ask.
function onCheck(): void {
  void runButton('Checking…', async (img, stale) => {
    const r = await feedback.checkWork(img, activeMode.value);
    if (stale()) return;
    absorbStatement(r);
    if (r.noProblem) {
      lastFeedback.value = NO_PROBLEM_MSG;
      return;
    }
    if (r.ungraded) {
      lastFeedback.value = UNUSABLE_MSG;
      return;
    }
    if (feedback.isQuiet(r.verdict)) {
      const line = 'Bis hier stimmt alles.';
      const style = activeMode.value.feedbackStyle;
      if (style === 'spoken' || style === 'both') feedback.speak(line);
      else feedback.playChime(true);
      lastFeedback.value = line + partsSuffix(r.parts);
      return;
    }
    feedback.deliver(r.verdict, activeMode.value, true);
    lastFeedback.value = r.display || r.verdict;
    cancelAutoClear();
  });
}

// "Hint": the stuck signal. The ladder level is driven by the ink revision — pressing
// again without new ink goes one level deeper; the counter only advances on a hint
// that actually arrived, so a failed request cannot eat a ladder level.
function onHint(): void {
  void runButton('Thinking about a hint…', async (img, stale) => {
    const unchanged = surface.value.strokeCount() === strokesAtLastHint;
    const r = await feedback.getHint(img, activeMode.value, unchanged);
    if (stale()) return;
    absorbStatement(r);
    if (r.noProblem) {
      lastFeedback.value = NO_PROBLEM_MSG;
      return;
    }
    if (r.ungraded || !r.hint) {
      lastFeedback.value = 'No hint came back. Press again.';
      return;
    }
    strokesAtLastHint = surface.value.strokeCount();
    feedback.deliver(r.hint, activeMode.value, true, false);
    lastFeedback.value = r.display || r.hint;
    if (settings.ui.autoExpandFeedback) {
      overlay.value = { title: 'Hint', body: r.display || r.hint };
    }
  });
}

// "Ask": a typed question about the page in hand, answered with the same grounding a
// grading request gets (ink, statement of record, reference, the feedback so far).
// The panel keeps only the latest answer; earlier ones stay model context. A failed
// ask keeps the draft in the box so the same question is one Enter away.
const askDraft = ref('');
const askShown = ref('');
const askAnswer = ref('');
// The capture note: when the reply judged the question itself worth keeping (a gap or
// a technique worth practicing), the revealed line shows under the answer while the
// card lands in the deck in the background.
const askNote = ref('');

// Notes attached to the ask: individual notes and whole folders (subtrees), resolved
// to compact transcript text by the notes store, so a folder of handwriting rides
// along as a few hundred tokens instead of a pile of screenshots. The selection is
// sticky across Clear on purpose: a study session usually keeps its references.
const askNoteIds = ref<string[]>([]);
const askFolderIds = ref<string[]>([]);
const notesPickerOpen = ref(false);
const askAttached = computed(() => resolveAskNotes(askNoteIds.value, askFolderIds.value));
const pickerTree = computed(() => folderTree());

function toggleAskFolder(id: string): void {
  const i = askFolderIds.value.indexOf(id);
  if (i >= 0) askFolderIds.value.splice(i, 1);
  else askFolderIds.value.push(id);
}

function toggleAskNote(id: string): void {
  const i = askNoteIds.value.indexOf(id);
  if (i >= 0) askNoteIds.value.splice(i, 1);
  else askNoteIds.value.push(id);
}

function clearAskRefs(): void {
  askNoteIds.value = [];
  askFolderIds.value = [];
}

function askNoteTitle(id: string): string {
  return notesStore.notes.find((n) => n.id === id)?.title || 'Untitled';
}

// The pad's ask is about the PAGE: it needs ink like every other button, and the
// attached notes ride along as extra context ("solve it the way my formula sheet
// does"). General questions with no page in hand live in the Chat window under the
// Notes mode — a different persona, deliberately.
function onAsk(): void {
  const q = askDraft.value.trim();
  if (!q || busy.value || !inkPresent.value) return;
  void runButton('Answering…', async (img, stale) => {
    const r = await feedback.askQuestion(img, activeMode.value, q, askAttached.value.notes);
    if (stale()) return;
    absorbStatement(r);
    askShown.value = q;
    askNote.value = '';
    if (r.noProblem) {
      askAnswer.value = NO_PROBLEM_MSG;
      return;
    }
    if (r.ungraded || !r.answer) {
      askAnswer.value = 'No answer came back. Ask again.';
      return;
    }
    askDraft.value = '';
    askAnswer.value = r.display || r.answer;
    askNote.value = r.revealed ?? '';
    if (settings.ui.autoExpandFeedback) {
      overlay.value = {
        title: 'Answer',
        sub: q,
        body: askAnswer.value,
        note: askNote.value || undefined,
      };
    }
    const style = activeMode.value.feedbackStyle;
    if (style === 'spoken' || style === 'both') feedback.speak(r.answer);
  });
}

// "Finish": the declared end of the page. CORRECT starts the auto-clear countdown
// (cancellable, and writing cancels it), archives the solved page, and anything else
// names the first blocker and calls a pending countdown off.
function onFinish(): void {
  void runButton('Final check…', async (img, stale) => {
    const r = await feedback.finishCheck(img, activeMode.value);
    if (stale()) return;
    absorbStatement(r);
    if (r.noProblem) {
      lastFeedback.value = NO_PROBLEM_MSG;
      return;
    }
    if (r.ungraded) {
      lastFeedback.value = UNUSABLE_MSG;
      return;
    }
    feedback.deliver(r.verdict, activeMode.value, true);
    if (feedback.isCorrect(r.verdict)) {
      lastFeedback.value = feedback.describe(r.verdict, activeMode.value);
      solvedThisPage.value = true;
      // The exact image the judge approved goes to the archive, with the page's
      // label/statement/reference; the search index is written in the background.
      void archiveCurrent(img, 'correct');
      startAutoClear();
    } else {
      lastFeedback.value = r.display || r.verdict;
      cancelAutoClear();
    }
  });
}

async function connect() {
  try {
    status.value = 'Scanning for pen…';
    await pen.scanPen();
    status.value = '';
  } catch (err: any) {
    status.value = err?.message ?? 'Could not connect to the pen.';
  }
}

// ---- archive ----

const solvedThisPage = ref(false);
const archNote = ref('');
let archTimer: number | undefined;

function flashArchive(msg: string): void {
  archNote.value = msg;
  if (archTimer) window.clearTimeout(archTimer);
  archTimer = window.setTimeout(() => {
    archNote.value = '';
    archTimer = undefined;
  }, 2500);
}

async function archiveCurrent(img: string, verdict: 'correct' | 'open'): Promise<void> {
  if (!img) return;
  try {
    const snap = feedback.pageSnapshot();
    const thumb = await makeThumb(img);
    await saveAufgabe({
      modeId: activeMode.value.id,
      modeLabel: activeMode.value.label,
      problem: snap.problem,
      statement: snap.statement,
      solution: snap.solution,
      verdict,
      image: img,
      thumb,
    });
    flashArchive('Archived.');
  } catch (err) {
    console.warn('[nuclear-learning] archive save failed:', err);
    flashArchive('Archive failed.');
  }
}

// Manual save: any page, solved or not, goes to the archive on demand (verdict
// 'open' until a finish CORRECT upgrades the same problem's entry).
function onArchive(): void {
  if (busy.value || !surface.value.hasContent()) return;
  void archiveCurrent(surface.value.exportImage(), solvedThisPage.value ? 'correct' : 'open');
}

// Quick capture into the notebook: the page as written (scratch column included on
// the tablet — a note is a note) lands in the Inbox, and the background transcriber
// turns it into searchable, ask-attachable text. Organize later, per the capture-
// first convention.
function onNoteCapture(): void {
  const img = isTablet.value
    ? tablet.exportImage('all')
    : canvas.hasContent()
      ? canvas.exportImage()
      : '';
  if (!img) {
    flashArchive('Nothing to note.');
    return;
  }
  void (async () => {
    try {
      const thumb = await makeThumb(img);
      // Tablet captures keep their strokes, so the note can be continued later in
      // the Notebook's editor; Neo pen captures stay image-only snapshots.
      await saveNoteFromPad({
        image: img,
        thumb,
        strokes: isTablet.value ? tablet.getStrokes() : undefined,
      });
      flashArchive('Noted → Inbox.');
    } catch (err) {
      console.warn('[nuclear-learning] note capture failed:', err);
      flashArchive('Note failed.');
    }
  })();
}

// The Archive tab's "Üben" button lands here: the statement arrives pinned on the
// pad's edge, ready to be copied and re-solved.
watch(practiceText, (t) => {
  if (!t) return;
  pinned.value = t;
  practiceText.value = '';
});

// Fullscreen writing: with the page aspect matching the tablet, a fullscreened pad
// makes the Wacom's active area map ~1:1 onto the page instead of onto the whole
// desktop — the pen stops feeling like a mouse. The ResizeObserver re-fits the
// bitmap on the way in and out.
function toggleFullscreen(el: HTMLElement | null): void {
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen().catch(() => {});
}

// ---- large reading window ----

// Hints and ask answers are the two message kinds with real content depth, and a
// 400px side card is a keyhole for them. They open in a large overlay (auto when
// enabled in settings; always via the ⤢ buttons), Esc / backdrop closes.
const overlay = ref<{ title: string; sub?: string; body: string; note?: string } | null>(null);

function expandFeedback(): void {
  if (lastFeedback.value) overlay.value = { title: 'Feedback', body: lastFeedback.value };
}

function expandAsk(): void {
  if (askAnswer.value) {
    overlay.value = {
      title: 'Answer',
      sub: askShown.value,
      body: askAnswer.value,
      note: askNote.value || undefined,
    };
  }
}

// ---- keyboard ----

// One hand stays on the pen; the other gets the whole loop: P/C/H/F drive the four
// buttons, Z/Y/E drive the ink, +/-/0 the view. The Wacom driver can map the pen's
// own buttons to these keys, which covers "one pen button = undo, one = check".
function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Hold-to-repeat for undo/redo: keeping Z (or the pen button mapped to Ctrl/Cmd+Z)
// pressed peels strokes off one after another instead of demanding one press per
// stroke, accelerating the longer it is held (holdRepeat owns the curve, Presets
// owns its numbers). Cadence comes from ONE shared gate fed by two sources, the OS
// key auto-repeat (e.repeat) and a fallback interval for drivers that hold the key
// down without repeating it. The gate keeps the two sources from doubling up.
// The Cmd variant runs WITHOUT the fallback interval: macOS suppresses the plain
// key's keyup while Cmd is held, so a quick Cmd+Z tap with a lingering Cmd would
// leave an interval running with no stop signal. For Cmd shortcuts the OS
// auto-repeat alone drives the hold, which it delivers reliably, though that also
// caps them at the OS repeat rate: the ramp's top end belongs to plain Z and to the
// pen button, both of which drive themselves.
const HOLD_TICK_MS = 10; // poll rate only; the gap between removals comes from the ramp

let held: {
  key: string;
  action: () => void;
  started: number;
  last: number;
  timer: number;
} | null = null;

function fireHeld(): void {
  if (!held) return;
  const now = performance.now();
  if (!holdDue(held.started, held.last, now)) return;
  held.last = now;
  held.action();
}

function startHold(key: string, action: () => void, withTimer: boolean): void {
  stopHold();
  held = { key, action, started: performance.now(), last: 0, timer: 0 };
  if (withTimer) held.timer = window.setInterval(fireHeld, HOLD_TICK_MS);
}

function stopHold(): void {
  if (!held) return;
  if (held.timer) window.clearInterval(held.timer);
  held = null;
}

function onKeyUp(e: KeyboardEvent): void {
  if (!held) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === held.key || k === 'Meta' || k === 'Control' || k === 'Shift' || k === 'Alt') stopHold();
}

function onKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    if (overlay.value) {
      overlay.value = null;
      e.preventDefault();
    }
    return;
  }
  if (isEditableTarget(e.target)) return;
  // MainView stays mounted behind other tabs (v-show); keys must not fire there.
  if (!padwrapRef.value || padwrapRef.value.offsetParent === null) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && (k === 'z' || k === 'y')) {
    if (isTablet.value) {
      const action = k === 'y' || e.shiftKey ? tablet.redo : tablet.undo;
      if (e.repeat) {
        fireHeld();
      } else {
        action();
        startHold(k, action, !e.metaKey);
      }
      e.preventDefault();
    }
    return;
  }
  if (mod || e.altKey) return;
  // Held P/C/H/F must not machine-gun the four buttons (each press is a real model
  // call), and a held E would flicker the eraser toggle.
  if (e.repeat && (k === 'p' || k === 'c' || k === 'h' || k === 'f' || k === 'e')) return;
  switch (k) {
    case 'z':
    case 'y': {
      if (isTablet.value) {
        const action = k === 'y' ? tablet.redo : tablet.undo;
        if (e.repeat) {
          fireHeld();
        } else {
          action();
          startHold(k, action, true);
        }
        e.preventDefault();
      }
      break;
    }
    case 'e':
      if (isTablet.value) {
        tablet.toggleEraser();
        e.preventDefault();
      }
      break;
    case 'p':
      onProblemWritten();
      e.preventDefault();
      break;
    case 'c':
      onCheck();
      e.preventDefault();
      break;
    case 'h':
      onHint();
      e.preventDefault();
      break;
    case 'f':
      onFinish();
      e.preventDefault();
      break;
    case '+':
    case '=':
      if (isTablet.value) {
        tablet.zoomBy(1.25);
        e.preventDefault();
      }
      break;
    case '-':
      if (isTablet.value) {
        tablet.zoomBy(0.8);
        e.preventDefault();
      }
      break;
    case '0':
      if (isTablet.value) {
        tablet.resetView();
        e.preventDefault();
      }
      break;
  }
}

// The pinned problem survives automatic page turnovers (auto-clear, a physical page
// flip): the learner may still be copying or solving it across pages, and wiping it
// at the unrelated problem's CORRECT lost the card mid-intent. It dies only on the
// manual Clear (wipePin), a mode switch, or its own close button.
function startFreshPage(wipePin = false) {
  cancelAutoClear();
  generation += 1; // invalidate any in-flight request
  canvas.clear();
  tablet.clear();
  inkPresent.value = false;
  strokesAtLastHint = -1;
  solvedThisPage.value = false;
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
  readStatement.value = '';
  editingStatement.value = false;
  askDraft.value = '';
  askShown.value = '';
  askAnswer.value = '';
  askNote.value = '';
  overlay.value = null;
  if (wipePin) {
    drillRequest += 1;
    pinned.value = '';
  }
  pickNextUp();
}

// Switching mode is a fresh start for feedback context (the drawing stays; press a
// button to evaluate it under the new preset — nothing runs by itself).
watch(selectedModeId, () => {
  cancelAutoClear();
  generation += 1;
  strokesAtLastHint = -1;
  solvedThisPage.value = false;
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
  readStatement.value = '';
  editingStatement.value = false;
  askDraft.value = '';
  askShown.value = '';
  askAnswer.value = '';
  askNote.value = '';
  overlay.value = null;
  drillRequest += 1;
  pinned.value = '';
});

let resizeObserver: ResizeObserver | undefined;
let resizeFrame = 0;

function scheduleCanvasResize() {
  if (resizeFrame) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0;
    canvas.resize();
    tablet.resize();
  });
}

onMounted(() => {
  pickNextUp();
  canvas.resize();
  tablet.resize();
  if (padwrapRef.value && 'ResizeObserver' in window) {
    // Observe the stable container. Observing the canvas itself while resize() rewrites
    // its bitmap dimensions creates a ResizeObserver feedback loop in Chromium.
    resizeObserver = new ResizeObserver(scheduleCanvasResize);
    resizeObserver.observe(padwrapRef.value);
  } else {
    window.addEventListener('resize', scheduleCanvasResize);
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', stopHold);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', scheduleCanvasResize);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', stopHold);
  stopHold();
  if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
  if (archTimer) window.clearTimeout(archTimer);
  cancelAutoClear();
});

const connectionLabel = computed(() => {
  if (pen.state.scanning) return 'Scanning…';
  if (pen.state.connected) {
    return pen.state.battery != null ? `Pen connected · ${pen.state.battery}%` : 'Pen connected';
  }
  return 'Pen disconnected';
});
</script>

<template>
  <div class="app">
    <header class="bar">
      <select v-model="settings.input.source" class="src" aria-label="Input source" title="Where the ink comes from">
        <option value="tablet">Tablet</option>
        <option value="neo">Neo pen</option>
      </select>
      <button
        v-if="!isTablet"
        :disabled="pen.state.scanning || pen.state.connected"
        @click="connect"
      >
        {{ pen.state.connected ? 'Connected' : 'Connect pen' }}
      </button>
      <select v-if="modes.length > 1" v-model="selectedModeId" aria-label="Grader preset">
        <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
      <button title="Wipe the pad and start a new problem" @click="startFreshPage(true)">Clear</button>
      <button
        :disabled="busy || !inkPresent"
        title="Save this page to the Archive (a solved page saves itself). Label and search index are written in the background."
        @click="onArchive"
      >
        Archive
      </button>
      <button
        title="Capture this page as a note into the Inbox. A background call transcribes it to searchable text."
        @click="onNoteCapture"
      >
        Note
      </button>
      <span v-if="archNote" class="archnote" role="status">{{ archNote }}</span>
      <span class="spacer" />
      <span v-if="!isTablet" class="conn" :class="{ on: pen.state.connected }" role="status" aria-live="polite">
        {{ connectionLabel }}
      </span>
    </header>

    <!-- The four moves of a page, in order. Nothing runs on its own: you say when the
         problem is on the page, when to check, when you are stuck, and when you are done. -->
    <div class="actionbar">
      <button
        :disabled="busy || !inkPresent"
        title="The statement is on the page. Read it and work out the reference solution. (P)"
        @click="onProblemWritten"
      >
        Problem written
      </button>
      <button
        :disabled="busy || !inkPresent"
        title="Is the work so far correct? (C)"
        @click="onCheck"
      >
        Check
      </button>
      <button
        :disabled="busy || !inkPresent"
        title="I am stuck. What theory applies next? (H)"
        @click="onHint"
      >
        Hint
      </button>
      <button
        class="finish"
        :disabled="busy || !inkPresent"
        title="I declare the page done. Judge it. (F)"
        @click="onFinish"
      >
        Finish
      </button>
      <span v-if="busy" class="workline" role="status">{{ status || 'Working…' }}</span>
      <span v-else-if="isTablet" class="keys" aria-hidden="true">
        P·C·H·F buttons &nbsp; Z undo · Y redo · E eraser &nbsp; ctrl+scroll zoom · 0 fit
      </span>
    </div>

    <main class="stage">
      <div ref="padwrapRef" class="padwrap">
        <canvas v-show="!isTablet" ref="canvasRef" class="pad" role="img" aria-label="Live pen strokes" />
        <canvas
          v-show="isTablet"
          ref="tabletCanvasRef"
          class="pad tabpad"
          :class="{ erasing: tablet.state.tool === 'eraser' }"
          aria-label="Tablet writing area"
        />
        <div v-show="isTablet" class="tooldock" role="toolbar" aria-label="Ink tools">
          <button :disabled="!tablet.state.canUndo" title="Undo stroke (Z; hold to remove several)" @click="tablet.undo()">Undo</button>
          <button :disabled="!tablet.state.canRedo" title="Redo (Y)" @click="tablet.redo()">Redo</button>
          <button
            :class="{ on: tablet.state.tool === 'eraser' }"
            title="Stroke eraser (E). Holding the pen's lower button erases too, and lets go of it again."
            @click="tablet.toggleEraser()"
          >
            Eraser
          </button>
          <span class="zoomlvl">{{ tablet.state.zoomPct }}%</span>
          <button title="Zoom out (-)" @click="tablet.zoomBy(0.8)">−</button>
          <button title="Zoom in (+); ctrl+scroll zooms at the cursor" @click="tablet.zoomBy(1.25)">+</button>
          <button title="Fit the page (0)" @click="tablet.resetView()">Fit</button>
          <button
            title="Fullscreen writing: the page fills the screen, so the tablet maps ~1:1 onto it (Esc leaves)"
            @click="toggleFullscreen(padwrapRef)"
          >
            Full
          </button>
        </div>
        <div v-if="autoClearLeft > 0" class="autoclear" role="status">
          <span class="ac-dot" />
          <span class="ac-msg">
            Solved. Clearing for the next problem in {{ autoClearLeft }}s
            <template v-if="nextUpLabel"> · <MathText :text="nextUpLabel" /></template>
          </span>
          <button class="ghost" @click="cancelAutoClear">Keep</button>
        </div>
      </div>

      <!-- The side panel: the verdict's display version with real typesetting room
           (multi-line, $$-LaTeX), the pinned next-up problem in its own section so a
           scan's feedback never hides the problem mid-copy, and the session rows.
           A held correction shows here while its audio waits out the grace window;
           a glance stays opt-in. -->
      <aside class="panel">
        <div class="p-head">{{ activeMode.label }}</div>
        <section class="p-sec">
          <div class="p-label">
            <span>Feedback</span>
            <button
              v-if="lastFeedback"
              class="p-x"
              aria-label="Open the feedback in a large window"
              title="Open large"
              @click="expandFeedback"
            >
              ⤢
            </button>
          </div>
          <div class="p-body" role="status" aria-live="polite">
            <MathText :text="status || lastFeedback || 'Write on the pad, then use the buttons above.'" />
          </div>
        </section>
        <!-- The ask line: any typed question about the page in hand ("what if I
             substitute here?"), grounded in the ink, the statement of record, and the
             reference. The latest answer stays until the next question or Clear. -->
        <section class="p-sec">
          <div class="p-label">
            <span>Ask</span>
            <button
              v-if="askAnswer"
              class="p-x"
              aria-label="Open the answer in a large window"
              title="Open large"
              @click="expandAsk"
            >
              ⤢
            </button>
          </div>
          <form class="ask-form" @submit.prevent="onAsk">
            <textarea
              v-model="askDraft"
              class="ask-input"
              rows="2"
              placeholder="What if I…? Why does…?"
              aria-label="Ask about the current page"
              title="A question about the page in hand. The answer reads your ink and knows the reference; attached notes ride along as text. General questions live in the Notes-mode Chat."
              @keydown.enter.exact.prevent="onAsk"
            />
            <button type="submit" :disabled="busy || !inkPresent || !askDraft.trim()">Ask</button>
          </form>
          <div class="ask-attach">
            <button
              type="button"
              class="ghost attach-btn"
              title="Attach notes or whole folders as context for the answer"
              @click="notesPickerOpen = true"
            >
              + Notes
            </button>
            <span v-for="fid in askFolderIds" :key="`f-${fid}`" class="attach-chip">
              {{ folderPath(fid) }}/*
              <button class="chip-x" :aria-label="`Detach folder ${folderPath(fid)}`" @click="toggleAskFolder(fid)">×</button>
            </span>
            <span v-for="nid in askNoteIds" :key="`n-${nid}`" class="attach-chip">
              {{ askNoteTitle(nid) }}
              <button class="chip-x" :aria-label="`Detach note ${askNoteTitle(nid)}`" @click="toggleAskNote(nid)">×</button>
            </span>
          </div>
          <div v-if="askAttached.pending > 0" class="ask-note">
            {{ askAttached.pending }} attached note{{ askAttached.pending === 1 ? '' : 's' }} still transcribing.
          </div>
          <div v-if="askShown" class="ask-q">{{ askShown }}</div>
          <div v-if="askAnswer" class="p-body" aria-live="polite"><MathText :text="askAnswer" /></div>
          <div v-if="askNote" class="ask-note">Noted: <MathText :text="askNote" /></div>
        </section>
        <!-- The capture's read-back: what the model believes the statement says.
             Editable — fix a misread digit here and confirm; untouched, it stands as
             the statement of record that all grading trusts over the ink. -->
        <section v-if="readStatement" class="p-sec">
          <div class="p-label">
            <span>Statement (as read)</span>
            <button
              v-if="!editingStatement"
              class="p-x"
              aria-label="Edit the statement"
              title="Fix a misread symbol"
              :disabled="busy"
              @click="onEditStatement"
            >
              ✎
            </button>
          </div>
          <div v-if="!editingStatement" class="p-body"><MathText :text="readStatement" /></div>
          <div v-else>
            <textarea v-model="statementDraft" class="stmt-edit" rows="4" :disabled="busy" />
            <div class="stmt-actions">
              <button :disabled="busy || !statementDraft.trim()" @click="onConfirmStatement">
                Solve with this
              </button>
              <button class="ghost" :disabled="busy" @click="onCancelStatement">Cancel</button>
            </div>
          </div>
        </section>
        <section v-if="pinned" class="p-sec">
          <div class="p-label">
            <span>Problem</span>
            <button class="p-x" aria-label="Dismiss problem" title="Dismiss" @click="pinned = ''">×</button>
          </div>
          <div class="p-body"><MathText :text="pinned" /></div>
        </section>
        <section v-if="!sessionHidden" class="p-sec">
          <div class="p-label">
            <span>Session</span>
            <button class="p-x" aria-label="Hide session card" title="Hide until reload" @click="sessionHidden = true">×</button>
          </div>
          <div v-if="dayLine" class="p-row">{{ dayLine }}</div>
          <div v-if="dueLine" class="p-row">{{ dueLine }}</div>
          <button
            v-if="nextUpLabel"
            class="ghost nextup"
            :disabled="drillBusy"
            :aria-busy="drillBusy"
            @click="onNextUpTap"
          >
            <template v-if="drillBusy">Writing the drill…</template>
            <MathText v-else :text="nextUpLabel" />
          </button>
          <div v-if="!dayLine && !dueLine && !nextUpLabel" class="p-row muted">
            Nothing queued. Solve something.
          </div>
        </section>
      </aside>
    </main>

    <!-- The ask attachment picker: folders (whole subtrees) and single notes. -->
    <div v-if="notesPickerOpen" class="ovl" @click.self="notesPickerOpen = false">
      <div class="ovl-card" role="dialog" aria-modal="true" aria-label="Attach notes">
        <div class="ovl-head">
          <span class="ovl-title">Attach notes to Ask</span>
          <button class="p-x" aria-label="Close" @click="notesPickerOpen = false">×</button>
        </div>
        <div class="picker-rows">
          <template v-for="t in pickerTree" :key="t.folder.id">
            <label class="picker-row" :style="{ paddingLeft: `${t.depth * 1.1}rem` }">
              <input
                type="checkbox"
                :checked="askFolderIds.includes(t.folder.id)"
                @change="toggleAskFolder(t.folder.id)"
              />
              <span class="picker-name">{{ t.folder.name }}</span>
              <span class="picker-count">{{ notesInFolder(t.folder.id, true).length }}</span>
            </label>
            <label
              v-for="n in notesInFolder(t.folder.id)"
              :key="n.id"
              class="picker-row pnote"
              :style="{ paddingLeft: `${t.depth * 1.1 + 1.5}rem` }"
            >
              <input
                type="checkbox"
                :checked="askNoteIds.includes(n.id)"
                @change="toggleAskNote(n.id)"
              />
              <span class="picker-name">{{ n.title || (n.hasImage && !n.extracted ? 'Transcribing…' : 'Untitled') }}</span>
            </label>
          </template>
          <div v-if="notesStore.notes.length === 0" class="picker-empty">
            No notes yet. The Note button above captures the current page into the Inbox.
          </div>
        </div>
        <div class="picker-actions">
          <button @click="notesPickerOpen = false">Done</button>
          <span class="spacer" />
          <button class="ghost" :disabled="!askFolderIds.length && !askNoteIds.length" @click="clearAskRefs">
            Clear selection
          </button>
        </div>
      </div>
    </div>

    <!-- The large reading window: hints and answers at text size, not card size. -->
    <div v-if="overlay" class="ovl" @click.self="overlay = null">
      <div class="ovl-card" role="dialog" aria-modal="true" :aria-label="overlay.title">
        <div class="ovl-head">
          <span class="ovl-title">{{ overlay.title }}</span>
          <button class="p-x" aria-label="Close" title="Close (Esc)" @click="overlay = null">×</button>
        </div>
        <div v-if="overlay.sub" class="ovl-sub">{{ overlay.sub }}</div>
        <div class="ovl-body"><MathText :text="overlay.body" /></div>
        <div v-if="overlay.note" class="ovl-note">Noted: <MathText :text="overlay.note" /></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.src {
  max-width: 8.5rem;
}

.archnote {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--gold);
}

.spacer {
  flex: 1;
}

.actionbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.8rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.actionbar .finish {
  border-color: var(--gold);
}

.workline {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--muted);
}

.keys {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 0.66rem;
  color: var(--muted);
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .keys {
    display: none;
  }
}

.stmt-edit {
  width: 100%;
  resize: vertical;
  font-size: 0.85rem;
  line-height: 1.4;
}

.ask-form {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
}

.ask-input {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  line-height: 1.4;
  resize: vertical;
}

.ask-attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.5rem;
}

.attach-btn {
  font-size: 0.7rem;
  padding: 0.2rem 0.55rem;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--mono);
  font-size: 0.66rem;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.12rem 0.3rem 0.12rem 0.55rem;
  max-width: 100%;
}

.chip-x {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1;
  padding: 0 0.15rem;
  cursor: pointer;
}

.chip-x:hover {
  color: var(--bad);
}

.picker-rows {
  display: flex;
  flex-direction: column;
  max-height: 55vh;
  overflow-y: auto;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.28rem 0.4rem;
  font-size: 0.85rem;
  border-radius: var(--radius);
  cursor: pointer;
}

.picker-row:hover {
  background: var(--bg);
}

.picker-row.pnote {
  font-size: 0.8rem;
  color: var(--muted);
}

.picker-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-count {
  font-family: var(--mono);
  font-size: 0.64rem;
  color: var(--muted);
}

.picker-empty {
  color: var(--muted);
  font-size: 0.8rem;
  padding: 0.6rem 0.4rem;
}

.picker-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.8rem;
}

.ask-q {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 0.55rem;
  margin-bottom: 0.3rem;
  overflow-wrap: anywhere;
}

.ask-note {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--gold);
  margin-top: 0.45rem;
}

.stmt-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.45rem;
}

.conn {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.3rem 0.6rem;
}

.conn.on {
  color: var(--ink);
  border-color: var(--ink);
}

.stage {
  flex: 1;
  padding: 0.8rem;
  min-height: 0;
  display: flex;
  gap: 0.8rem;
}

.padwrap {
  flex: 1;
  min-width: 0;
  position: relative;
}

.panel {
  width: 400px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  min-height: 0;
  overflow-y: auto;
}

.p-head {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--muted);
}

.p-sec {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 0.8rem;
  flex: none;
}

.p-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 0.45rem;
}

.p-x {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 0.95rem;
  line-height: 1;
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  margin: -0.35rem -0.35rem -0.35rem 0;
  cursor: pointer;
}

.p-x:hover {
  color: var(--ink);
}

.p-body {
  font-size: 0.9rem;
  color: var(--ink);
  line-height: 1.5;
  /* Inline math no longer scrolls per-formula (it sits on the baseline like text);
     a formula wider than the card scrolls the body instead of overflowing it. */
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.p-body::-webkit-scrollbar {
  height: 4px;
}

.p-body::-webkit-scrollbar-track {
  background: transparent;
}

.p-body::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 999px;
}

.p-row {
  font-size: 0.85rem;
  color: var(--ink);
  padding: 0.15rem 0;
  font-variant-numeric: tabular-nums;
}

.p-row.muted {
  color: var(--muted);
}

.nextup {
  margin-top: 0.35rem;
  width: 100%;
  text-align: left;
}

@media (max-width: 900px) {
  .stage {
    flex-direction: column;
  }

  .panel {
    width: auto;
    max-height: 45%;
  }
}

.autoclear {
  position: absolute;
  left: 50%;
  bottom: 1.4rem;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem 0.5rem 0.85rem;
  background: var(--panel);
  border: 1px solid var(--gold);
  border-radius: var(--radius);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  font-size: 0.8rem;
  color: var(--ink);
}

.autoclear .ac-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--good);
  flex: none;
}

.autoclear .ac-msg {
  font-variant-numeric: tabular-nums;
}

.pad {
  width: 100%;
  height: 100%;
  display: block;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  touch-action: none;
}

/* The tablet surface: the page is drawn aspect-fixed INSIDE the canvas (desk-gray
   surround), so the element itself just fills the pad area. */
.tabpad {
  background: var(--bg);
  cursor: crosshair;
}

.tabpad.erasing {
  cursor: cell;
}

.tooldock {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.4rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.08);
}

.tooldock button {
  font-size: 0.72rem;
  padding: 0.3rem 0.55rem;
}

.tooldock button.on {
  border-color: var(--gold);
  color: var(--gold);
}

.tooldock .zoomlvl {
  font-family: var(--mono);
  font-size: 0.68rem;
  color: var(--muted);
  min-width: 3ch;
  text-align: right;
  padding: 0 0.15rem;
  font-variant-numeric: tabular-nums;
}

/* The large reading window for hints and answers. */
.ovl {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  padding: 1.2rem;
}

.ovl-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 14px 48px rgba(0, 0, 0, 0.25);
  width: min(760px, 94vw);
  max-height: 82vh;
  overflow-y: auto;
  padding: 1rem 1.3rem 1.2rem;
}

.ovl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--mono);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin-bottom: 0.6rem;
}

.ovl-sub {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  margin-bottom: 0.6rem;
  overflow-wrap: anywhere;
}

.ovl-body {
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--ink);
  overflow-x: auto;
}

.ovl-note {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--gold);
  margin-top: 0.7rem;
}
</style>
