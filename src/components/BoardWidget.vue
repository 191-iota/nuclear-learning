<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TabletWidget } from '@/composables/inkExport';
import {
  buildWidget,
  mountWidget,
  widgetStorage,
  type WidgetHandle,
} from '@/widgetHost';

/**
 * One widget on the board: a frame you grab, and inside it a component you use.
 *
 * The split is the whole design. A pasted picture is passive, so the pen picks it up
 * anywhere on it; a widget has fields and sliders, and a thing you cannot touch
 * without moving it is not a thing you can use. So the border is the object and the
 * inside is the component: press the frame to drag it, pull a corner to size it, and
 * everything within the border goes to the widget from the moment it lands, with no
 * mode to enter first.
 *
 * The border keeps its thickness on screen rather than on the page, for the same
 * reason the picture handles do: at a tenth of the zoom a border measured in page
 * units is a hairline nobody can hit.
 */

const props = defineProps<{
  widget: TabletWidget;
  /** Page units to CSS pixels, from the ink engine: client = page * k + o. */
  k: number;
  ox: number;
  oy: number;
}>();

const emit = defineEmits<{
  update: [patch: Partial<TabletWidget>];
  remove: [];
  edit: [];
}>();

/** Grab border and corner grips, in screen pixels, so both stay hittable at any zoom. */
const BORDER = 10;
const MIN_W = 140;
const MIN_H = 90;
const REBUILD_MS = 700;

const host = ref<HTMLElement | null>(null);
const frame = ref<HTMLElement | null>(null);
const error = ref('');
const live = ref(false);
const dragging = ref(false);

const frameStyle = computed(() => ({
  left: `${props.ox + (props.widget.x - props.widget.w / 2) * props.k - BORDER}px`,
  top: `${props.oy + (props.widget.y - props.widget.h / 2) * props.k - BORDER}px`,
  width: `${props.widget.w * props.k + BORDER * 2}px`,
  height: `${props.widget.h * props.k + BORDER * 2}px`,
  padding: `${BORDER}px`,
}));

// The component is laid out at its size in page units and then scaled as one piece,
// so zooming the board zooms the widget with it, the way it does a picture. Laying it
// out at the scaled size instead would reflow the whole thing on every zoom step.
const innerStyle = computed(() => ({
  width: `${props.widget.w}px`,
  height: `${props.widget.h}px`,
  transform: `scale(${props.k})`,
  transformOrigin: 'top left',
}));

// ---- dragging the frame ----

let handle: WidgetHandle | null = null;

interface Drag {
  pointerId: number;
  corner: '' | 'tl' | 'tr' | 'br' | 'bl';
  startX: number;
  startY: number;
  box: { l: number; t: number; r: number; b: number };
}
let drag: Drag | null = null;

function boxOf(w: TabletWidget): { l: number; t: number; r: number; b: number } {
  return { l: w.x - w.w / 2, t: w.y - w.h / 2, r: w.x + w.w / 2, b: w.y + w.h / 2 };
}

/**
 * A component that reaches for a global `storage` rather than the prop gets this
 * widget's while the pointer is in it, so two widgets on one board cannot write into
 * each other's box (see mountWidget).
 */
function claim(): void {
  handle?.claim();
}

function begin(e: PointerEvent, corner: Drag['corner']): void {
  // Only the frame itself starts a drag. A press that landed on the component inside
  // belongs to the component, and reaches this handler only by bubbling.
  if (!corner && e.target !== frame.value) return;
  e.preventDefault();
  e.stopPropagation();
  drag = {
    pointerId: e.pointerId,
    corner,
    startX: e.clientX,
    startY: e.clientY,
    box: boxOf(props.widget),
  };
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function moveTo(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = (e.clientX - drag.startX) / props.k;
  const dy = (e.clientY - drag.startY) / props.k;
  const { l, t, r, b } = drag.box;

  if (!drag.corner) {
    emit('update', { x: (l + r) / 2 + dx, y: (t + b) / 2 + dy });
    return;
  }
  // The corner opposite the one being held stays where it is.
  let nl = l;
  let nt = t;
  let nr = r;
  let nb = b;
  if (drag.corner === 'tl' || drag.corner === 'bl') nl = Math.min(l + dx, r - MIN_W);
  else nr = Math.max(r + dx, l + MIN_W);
  if (drag.corner === 'tl' || drag.corner === 'tr') nt = Math.min(t + dy, b - MIN_H);
  else nb = Math.max(b + dy, t + MIN_H);
  emit('update', {
    x: (nl + nr) / 2,
    y: (nt + nb) / 2,
    w: Math.round(nr - nl),
    h: Math.round(nb - nt),
  });
}

function end(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag = null;
  dragging.value = false;
}

// ---- what runs inside ----

let timer: number | undefined;
let generation = 0;

// One storage object per widget, kept across rebuilds so a component that reads it in
// a state initializer sees the same thing every time it is remounted.
const storage = widgetStorage(
  () => props.widget.data ?? {},
  (next) => emit('update', { data: next }),
);

function teardown(): void {
  handle?.destroy();
  handle = null;
  live.value = false;
}

async function rebuild(): Promise<void> {
  const mine = ++generation;
  const built = await buildWidget(props.widget.src);
  if (mine !== generation) return;
  if (built.error) {
    // A failed build leaves the last working one running: the alternative is that the
    // thing on the board vanishes the moment a bracket is opened in its source.
    error.value = built.error;
    return;
  }
  error.value = '';
  if (!built.component) {
    teardown();
    return;
  }
  const el = host.value;
  if (!el) return;
  teardown();
  handle = mountWidget(el, built.component, { storage }, (message) => {
    error.value = message;
  });
  live.value = true;
}

function schedule(delay: number): void {
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => void rebuild(), delay);
}

onMounted(() => schedule(0));
watch(() => props.widget.src, () => schedule(REBUILD_MS));

onBeforeUnmount(() => {
  if (timer) window.clearTimeout(timer);
  generation += 1;
  teardown();
});
</script>

<template>
  <div
    ref="frame"
    class="bw"
    :class="{ dragging }"
    :style="frameStyle"
    @pointerdown.capture="claim"
    @focusin="claim"
    @pointerdown="begin($event, '')"
    @pointermove="moveTo"
    @pointerup="end"
    @pointercancel="end"
  >
    <div class="bw-inner" :style="innerStyle">
      <div ref="host" class="bw-host" />
      <p v-if="!live && !error" class="bw-wait mono">Compiling…</p>
    </div>

    <p v-if="error" class="bw-err mono">{{ error }}</p>

    <span
      v-for="c in (['tl', 'tr', 'br', 'bl'] as const)"
      :key="c"
      class="bw-grip"
      :class="c"
      @pointerdown="begin($event, c)"
      @pointermove="moveTo"
      @pointerup="end"
      @pointercancel="end"
    />

    <span class="bw-acts">
      <button type="button" title="Edit this widget's code" @pointerdown.stop @click="emit('edit')">
        Code
      </button>
      <button type="button" title="Take this widget off the board" @pointerdown.stop @click="emit('remove')">
        Remove
      </button>
    </span>
  </div>
</template>

<style scoped>
.bw {
  position: absolute;
  box-sizing: border-box;
  border-radius: calc(var(--radius) + 4px);
  background: var(--panel);
  /* Stated rather than inherited, so the paper palette below actually reaches the
     text: `color` was resolved on body with the app theme's ink and would come down
     unchanged however the token is redefined here. */
  color: var(--ink);
  border: 1px solid var(--border);
  box-shadow: 0 1px 6px rgb(0 0 0 / 0.07);
  cursor: move;
  touch-action: none;
  /* The layer above the ink lets everything through; a widget is what catches it. */
  pointer-events: auto;
}

.bw:hover,
.bw.dragging {
  border-color: var(--gold);
}

/* The board is paper in both themes: the canvas is painted with a fixed colour
   (settings.canvas.backgroundColor) rather than a token, and the ink and the pictures
   on it are the same in either. A widget is an object on that page, so it takes the
   paper palette too. Following the app's theme instead put a charcoal card in the
   middle of a white sheet, which read as a hole in the page rather than a thing on it.
   The gold is left alone, because that is what the picture handles are drawn in and
   both are the same kind of frame around the same kind of object. */
[data-theme='dark'] .bw {
  --panel: #ffffff;
  --panel-2: #efeee9;
  --ink: #1a1915;
  --muted: #6c6a60;
  --border: #e3e2db;
  --accent: #1a1915;
  --accent-ink: #f4f4f1;
  --good: #4a7a4f;
  --bad: #b1492f;
}

/* The component's own box. Nothing here reads pointer events away from it. */
.bw-inner {
  overflow: auto;
  background: var(--panel);
  border-radius: var(--radius);
  cursor: auto;
}

.bw-host {
  min-height: 100%;
  padding: 0.55rem 0.65rem;
  font-size: 0.92rem;
  line-height: 1.5;
}

.bw-wait {
  margin: 0;
  padding: 0 0.65rem;
  font-size: 0.72rem;
  color: var(--muted);
}

/* Sits over the bottom of the frame rather than inside the layout, so an error never
   pushes the widget around while it is being edited. */
.bw-err {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  padding: 0.35rem 0.55rem;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--panel);
  border-top: 1px solid var(--bad);
  color: var(--bad);
  font-size: 0.68rem;
  line-height: 1.45;
  max-height: 4.5rem;
  overflow: auto;
}

.bw-grip {
  position: absolute;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--panel);
  border: 1.5px solid var(--gold);
  opacity: 0;
  transition: opacity 0.12s ease;
  touch-action: none;
}

.bw:hover .bw-grip,
.bw.dragging .bw-grip {
  opacity: 1;
}

.bw-grip.tl {
  left: -6px;
  top: -6px;
  cursor: nwse-resize;
}

.bw-grip.tr {
  right: -6px;
  top: -6px;
  cursor: nesw-resize;
}

.bw-grip.br {
  right: -6px;
  bottom: -6px;
  cursor: nwse-resize;
}

.bw-grip.bl {
  left: -6px;
  bottom: -6px;
  cursor: nesw-resize;
}

/* Named actions, shown when the pointer is on the widget, the way the note cards do
   it. They sit above the frame so they never cover what is running. */
.bw-acts {
  position: absolute;
  left: 0;
  bottom: 100%;
  margin-bottom: 4px;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.bw:hover .bw-acts,
.bw:focus-within .bw-acts {
  opacity: 1;
}

.bw-acts button {
  padding: 0.15rem 0.45rem;
  font-size: 0.68rem;
  cursor: pointer;
}

/* The app styles its own fields as input[type='text'], and a pasted component almost
   never writes the type out. Without this the boxes come back as the browser's own
   white ones, which is fine in the light theme and unreadable in the dark one. */
.bw-host :deep(input:not([type])),
.bw-host :deep(input[type='text']),
.bw-host :deep(input[type='number']),
.bw-host :deep(input[type='search']),
.bw-host :deep(input[type='date']),
.bw-host :deep(input[type='time']),
.bw-host :deep(input[type='email']),
.bw-host :deep(input[type='url']),
.bw-host :deep(select),
.bw-host :deep(textarea) {
  font-family: var(--mono);
  font-size: 0.8rem;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.25rem 0.4rem;
  max-width: 100%;
}

.bw-host :deep(input[type='checkbox']),
.bw-host :deep(input[type='radio']),
.bw-host :deep(input[type='range']) {
  accent-color: var(--accent);
}

.bw-host :deep(button) {
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
}

/* Tables are the one thing the app has no style for, and a table is what half of
   these turn out to be. */
.bw-host :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.bw-host :deep(th),
.bw-host :deep(td) {
  padding: 0.25rem 0.4rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  font-size: 0.8rem;
  vertical-align: middle;
}

.bw-host :deep(th) {
  font-family: var(--mono);
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--muted);
}
</style>
