<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { modes } from '@/stores/modes';
import { usePen, type PenDot } from '@/composables/usePen';
import { useCanvas } from '@/composables/useCanvas';
import { useFeedback } from '@/composables/useFeedback';
import { settings } from '@/stores/settings';
import type { Mode } from '@/types';

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
const canvas = useCanvas(canvasRef);
const feedback = useFeedback();

const lastFeedback = ref('');
const status = ref('');
const requesting = ref(false);

// Auto-clear after a correct answer: once a problem is marked CORRECT, a short
// countdown clears the pad for the next problem unless you keep it (or write more).
const autoClearLeft = ref(0); // seconds remaining; 0 = inactive
let autoClearTimer: number | undefined;

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
  autoClearLeft.value = secs;
  autoClearTimer = window.setInterval(() => {
    autoClearLeft.value -= 1;
    if (autoClearLeft.value <= 0) {
      cancelAutoClear();
      startFreshPage(); // same as pressing Clear
    }
  }, 1000);
}

// Orchestration state for sequential, coherent scans.
let dirty = false; // new strokes since the last completed scan
let pendingAgain = false; // strokes arrived while a scan was in flight
let debounceTimer: number | undefined;
let generation = 0; // bumped on clear / mode change to discard stale in-flight scans
// Change-gating: how many strokes existed at the last scan, plus an idle-flush
// timer so a small final increment is still checked once the pen goes idle.
let strokesAtLastScan = 0;
let flushTimer: number | undefined;
let flushing = false;

function onDot(dot: PenDot) {
  canvas.addDot(dot);
  if (dot.dotType === DOT_HOVER) return;
  // Writing again means you want to keep this page, call off any pending clear.
  if (autoClearLeft.value > 0) cancelAutoClear();
  dirty = true;
  // Active writing resumed, cancel any pending idle flush.
  flushing = false;
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  scheduleFeedback();
}

const pen = usePen({ onDot });

function scheduleFeedback() {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(runFeedback, activeMode.value.debounceMs);
}

// After the debounce fires with too little new ink, wait out a longer idle and
// then scan anyway, so a finished answer is never skipped just because the last
// addition was small.
function scheduleFlush() {
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flushing = true;
    runFeedback();
  }, settings.scan.idleFlushMs);
}

async function runFeedback() {
  if (!canvas.hasContent() || !dirty) return;
  if (requesting.value) {
    pendingAgain = true; // serialise: re-run after the current scan finishes
    return;
  }
  // Gate on how much new ink arrived since the last scan. Below the threshold we
  // wait for more (batching mid-writing scans), unless this is an idle flush. A
  // finished answer is substantial ink, so it always trips the threshold; and the
  // flush covers the case where the learner stops after a small final tweak.
  const newStrokes = canvas.strokeCount() - strokesAtLastScan;
  if (newStrokes <= 0) return;
  if (newStrokes < settings.scan.minNewStrokes && !flushing) {
    scheduleFlush();
    return;
  }
  flushing = false;
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  requesting.value = true;
  dirty = false;
  strokesAtLastScan = canvas.strokeCount();
  const gen = generation;
  status.value = 'Checking…';
  try {
    const img = canvas.exportImage();
    const text = await feedback.getFeedback(img, activeMode.value);
    if (gen !== generation) {
      status.value = ''; // a reset happened mid-flight, drop this result
      return;
    }
    if (import.meta.env.DEV) console.debug('[nuclear-learning] verdict:', JSON.stringify(text));
    feedback.recordVerdict(text);
    const played = feedback.deliver(text, activeMode.value);
    if (feedback.isQuiet(text)) {
      lastFeedback.value = 'Looks good so far…';
    } else if (played) {
      // Only refresh the shown correction when it actually spoke; a deduped repeat leaves it be.
      lastFeedback.value = feedback.describe(text, activeMode.value);
    }
    status.value = '';
    // Correct → offer to auto-advance to the next problem; any other verdict (a fresh error
    // after a correct one) calls off a pending clear. With the corner gate, CORRECT only fires
    // once every part is answered and double-underlined, so it is a real completion worth clearing.
    if (feedback.isCorrect(text)) startAutoClear();
    else if (!feedback.isQuiet(text)) cancelAutoClear();
  } catch (err: any) {
    if (gen !== generation) {
      status.value = '';
      return;
    }
    status.value = err?.message ?? 'Error contacting OpenAI.';
  } finally {
    requesting.value = false;
    // Drain queued work if any arrived. This must NOT be gated on the finishing
    // request's generation: a reset (Clear / mode switch) bumps `generation` and
    // queues new-generation work, and the rescheduled run re-reads `generation`
    // and re-checks the canvas, so it always targets the current page/mode.
    if (pendingAgain || dirty) {
      pendingAgain = false;
      scheduleFeedback();
    }
  }
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

function resetGating() {
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = undefined;
  flushing = false;
  strokesAtLastScan = 0;
}

function startFreshPage() {
  cancelAutoClear();
  generation += 1; // invalidate any in-flight scan
  if (debounceTimer) window.clearTimeout(debounceTimer);
  dirty = false;
  pendingAgain = false;
  resetGating();
  canvas.clear();
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
}

// Switching mode is also a fresh start for feedback context (keep the drawing).
watch(selectedModeId, () => {
  cancelAutoClear();
  generation += 1;
  resetGating(); // re-evaluate the existing drawing under the new mode
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
  if (canvas.hasContent()) {
    dirty = true;
    scheduleFeedback();
  }
});

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  canvas.resize();
  if (canvasRef.value && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => canvas.resize());
    resizeObserver.observe(canvasRef.value);
  } else {
    window.addEventListener('resize', canvas.resize);
  }
  // Silently reconnect to an already-paired pen (no chooser); no-op on first visit.
  void pen.autoConnect();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', canvas.resize);
  if (debounceTimer) window.clearTimeout(debounceTimer);
  if (flushTimer) window.clearTimeout(flushTimer);
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
      <select v-model="selectedModeId" aria-label="Mode">
        <option v-for="m in modes" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
      <button title="Wipe the pad and start a new problem" @click="startFreshPage">Clear</button>
      <span class="spacer" />
      <span class="conn" :class="{ on: pen.state.connected }">{{ connectionLabel }}</span>
    </header>

    <main class="stage">
      <canvas ref="canvasRef" class="pad" />
      <div v-if="autoClearLeft > 0" class="autoclear" role="status">
        <span class="ac-dot" />
        <span class="ac-msg">Solved. Clearing for the next problem in {{ autoClearLeft }}s</span>
        <button class="ghost" @click="cancelAutoClear">Keep</button>
      </div>
    </main>

    <footer class="status">
      <span class="mode">{{ activeMode.label }}</span>
      <span class="sep">·</span>
      <span class="msg">{{ status || lastFeedback || 'Write on the pad. Feedback appears here.' }}</span>
    </footer>
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
  position: relative;
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

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.9rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
  font-size: 0.8rem;
}

.status .mode {
  font-family: var(--mono);
  color: var(--muted);
}

.status .sep {
  color: var(--border);
}

.status .msg {
  color: var(--ink);
}
</style>
