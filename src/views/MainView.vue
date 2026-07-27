<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { modes } from '@/stores/modes';
import { usePen, type PenDot } from '@/composables/usePen';
import { useCanvas } from '@/composables/useCanvas';
import { useFeedback } from '@/composables/useFeedback';
import MathText from '@/components/MathText.vue';
import { settings } from '@/stores/settings';
import { recommendPractice, rating, dayStats, announcedRank, markRankAnnounced } from '@/stores/skills';
import { dueLessons, lessonStats, lessonStore, nowTick, type Lesson } from '@/stores/lessons';
import { rankForRating } from '@/rank';
import { generateDrill } from '@/drill';
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
const padwrapRef = ref<HTMLDivElement | null>(null);
const canvas = useCanvas(canvasRef);
const feedback = useFeedback();

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
// Counts come from delivered CORRECTs and the estimator's own day bookkeeping, never
// usage buckets. Hard-capped: the rating delta is the only number besides counts, and
// this section never grows a metric, a ratio, or a bar.
const dayLine = computed(() => {
  const now = nowTick();
  const day = dayStats(now);
  if (day.solved === 0) return '';
  const capturedToday = lessonStore.lessons.filter(
    (l) => Math.floor(l.ts / DAY_MS) === Math.floor(now / DAY_MS),
  ).length;
  let s = `today: ${day.solved} solved`;
  if (day.ratingDelta !== null) s += ` · ${day.ratingDelta >= 0 ? '+' : ''}${day.ratingDelta}`;
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

// A rank-band crossing speaks one factual sentence ("2071. Strong FH Student."),
// upward only, each band once ever (persisted), and only when the mode speaks at all.
// Sequenced behind the CORRECT utterance because speak() cancels in-flight speech.
// A fact, not praise; it dies in one commit if it reads as noise.
function maybeAnnounceRank() {
  const r = rating();
  if (!r || r.provisional) return;
  const held = rankForRating(r.value);
  if (held.n <= announcedRank()) return;
  const style = activeMode.value.feedbackStyle;
  if (style !== 'spoken' && style !== 'both') return;
  markRankAnnounced(held.n);
  window.setTimeout(() => feedback.speak(`${r.value}. ${held.title}.`), 3500);
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
  maybeAnnounceRank();
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
// Stroke count at the last successful hint: an unchanged count at the next press means
// "still stuck at the same state", which is what advances the hint ladder one level.
// Strokes, not time — thinking long never escalates by itself.
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
  if (busy.value || !canvas.hasContent()) return;
  busy.value = true;
  const gen = generation;
  const stale = () => gen !== generation;
  status.value = label;
  try {
    await op(canvas.exportImage(), stale);
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

// "Hint": the stuck signal. The ladder level is driven by the stroke count — pressing
// again without new ink goes one level deeper; the counter only advances on a hint
// that actually arrived, so a failed request cannot eat a ladder level.
function onHint(): void {
  void runButton('Thinking about a hint…', async (img, stale) => {
    const unchanged = canvas.strokeCount() === strokesAtLastHint;
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
    strokesAtLastHint = canvas.strokeCount();
    feedback.deliver(r.hint, activeMode.value, true, false);
    lastFeedback.value = r.display || r.hint;
  });
}

// "Finish": the declared end of the page. CORRECT starts the auto-clear countdown
// (cancellable, and writing cancels it); anything else names the first blocker and
// calls a pending countdown off.
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

// The pinned problem survives automatic page turnovers (auto-clear, a physical page
// flip): the learner may still be copying or solving it across pages, and wiping it
// at the unrelated problem's CORRECT lost the card mid-intent. It dies only on the
// manual Clear (wipePin), a mode switch, or its own close button.
function startFreshPage(wipePin = false) {
  cancelAutoClear();
  generation += 1; // invalidate any in-flight request
  canvas.clear();
  inkPresent.value = false;
  strokesAtLastHint = -1;
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
  readStatement.value = '';
  editingStatement.value = false;
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
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
  readStatement.value = '';
  editingStatement.value = false;
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
  });
}

onMounted(() => {
  pickNextUp();
  canvas.resize();
  if (padwrapRef.value && 'ResizeObserver' in window) {
    // Observe the stable container. Observing the canvas itself while resize() rewrites
    // its bitmap dimensions creates a ResizeObserver feedback loop in Chromium.
    resizeObserver = new ResizeObserver(scheduleCanvasResize);
    resizeObserver.observe(padwrapRef.value);
  } else {
    window.addEventListener('resize', scheduleCanvasResize);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', scheduleCanvasResize);
  if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
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
      <button :disabled="pen.state.scanning || pen.state.connected" @click="connect">
        {{ pen.state.connected ? 'Connected' : 'Connect pen' }}
      </button>
      <select v-if="modes.length > 1" v-model="selectedModeId" aria-label="Grader preset">
        <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
      <button title="Wipe the pad and start a new problem" @click="startFreshPage(true)">Clear</button>
      <span class="spacer" />
      <span class="conn" :class="{ on: pen.state.connected }" role="status" aria-live="polite">
        {{ connectionLabel }}
      </span>
    </header>

    <!-- The four moves of a page, in order. Nothing runs on its own: you say when the
         problem is on the page, when to check, when you are stuck, and when you are done. -->
    <div class="actionbar">
      <button
        :disabled="busy || !inkPresent"
        title="The statement is on the page. Read it and work out the reference solution."
        @click="onProblemWritten"
      >
        Problem written
      </button>
      <button
        :disabled="busy || !inkPresent"
        title="Is the work so far correct?"
        @click="onCheck"
      >
        Check
      </button>
      <button
        :disabled="busy || !inkPresent"
        title="I am stuck. What theory applies next?"
        @click="onHint"
      >
        Hint
      </button>
      <button
        class="finish"
        :disabled="busy || !inkPresent"
        title="I declare the page done. Judge it."
        @click="onFinish"
      >
        Finish
      </button>
      <span v-if="busy" class="workline" role="status">{{ status || 'Working…' }}</span>
    </div>

    <main class="stage">
      <div ref="padwrapRef" class="padwrap">
        <canvas ref="canvasRef" class="pad" role="img" aria-label="Live pen strokes" />
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
          <div class="p-label">Feedback</div>
          <div class="p-body" role="status" aria-live="polite">
            <MathText :text="status || lastFeedback || 'Write on the pad, then use the buttons above.'" />
          </div>
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

.stmt-edit {
  width: 100%;
  resize: vertical;
  font-size: 0.85rem;
  line-height: 1.4;
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
  width: 340px;
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

</style>
