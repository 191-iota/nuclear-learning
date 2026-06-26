<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import modesData from '@config/modes.json';
import { usePen, type PenDot } from '@/composables/usePen';
import { useCanvas } from '@/composables/useCanvas';
import { useFeedback } from '@/composables/useFeedback';
import type { Mode } from '@/types';

const DOT_HOVER = 3;

const modes = modesData as unknown as Mode[];
const selectedModeId = ref(modes[0].id);
const activeMode = computed<Mode>(() => modes.find((m) => m.id === selectedModeId.value) ?? modes[0]);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const canvas = useCanvas(canvasRef);
const feedback = useFeedback();

const lastFeedback = ref('');
const status = ref('');
const requesting = ref(false);

// Orchestration state for sequential, coherent scans.
let dirty = false; // new strokes since the last completed scan
let pendingAgain = false; // strokes arrived while a scan was in flight
let debounceTimer: number | undefined;
let generation = 0; // bumped on clear / mode change to discard stale in-flight scans

function onDot(dot: PenDot) {
  canvas.addDot(dot);
  if (dot.dotType === DOT_HOVER) return;
  dirty = true;
  scheduleFeedback();
}

const pen = usePen({ onDot });

function scheduleFeedback() {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(runFeedback, activeMode.value.debounceMs);
}

async function runFeedback() {
  if (!canvas.hasContent() || !dirty) return;
  if (requesting.value) {
    pendingAgain = true; // serialise: re-run after the current scan finishes
    return;
  }
  requesting.value = true;
  dirty = false;
  const gen = generation;
  status.value = 'Checking…';
  try {
    const png = canvas.exportPng();
    const text = await feedback.getFeedback(png, activeMode.value);
    if (gen !== generation) {
      status.value = ''; // a reset happened mid-flight — drop this result
      return;
    }
    feedback.recordVerdict(text);
    lastFeedback.value = feedback.isQuiet(text) ? 'Looks good so far…' : text;
    feedback.deliver(text, activeMode.value);
    status.value = '';
  } catch (err: any) {
    if (gen !== generation) {
      status.value = '';
      return;
    }
    status.value = err?.message ?? 'Error contacting Claude.';
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

function startFreshPage() {
  generation += 1; // invalidate any in-flight scan
  if (debounceTimer) window.clearTimeout(debounceTimer);
  dirty = false;
  pendingAgain = false;
  canvas.clear();
  feedback.resetSession();
  lastFeedback.value = '';
  status.value = '';
}

// Switching mode is also a fresh start for feedback context (keep the drawing).
watch(selectedModeId, () => {
  generation += 1;
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
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', canvas.resize);
  if (debounceTimer) window.clearTimeout(debounceTimer);
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
    </main>

    <footer class="status">
      <span class="mode">{{ activeMode.label }}</span>
      <span class="sep">·</span>
      <span class="msg">{{ status || lastFeedback || 'Write on the pad — feedback appears here.' }}</span>
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
