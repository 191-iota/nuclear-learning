<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue';

/**
 * A small window that floats over whatever is underneath it: dragged by its title
 * bar, resized from its corner, and remembered where you left it.
 *
 * Two places need the same thing from opposite directions. In the chat, a note has to
 * be readable while the conversation continues, and a note that replaces the thread is
 * no use for checking a formula mid-question. In the notebook, a question has to be
 * askable without the page being written going away. One window serves both, which is
 * also why the geometry is keyed: the notebook's and the chat's are separate windows
 * with separate places on screen.
 *
 * Geometry lives under an nl.* key, so it mirrors to disk like every other one.
 */

const props = withDefaults(
  defineProps<{
    /** Where this window's geometry is remembered. One key per window, not per note. */
    paneKey: string;
    title: string;
    /** Opening size, used only when nothing is remembered yet. */
    w?: number;
    h?: number;
    minW?: number;
    minH?: number;
  }>(),
  { w: 460, h: 520, minW: 300, minH: 220 },
);

const emit = defineEmits<{ close: [] }>();

const KEY = 'nl.floatwin.v1';
const MARGIN = 12;

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function loadAll(): Record<string, Geom> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Geom>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(): void {
  const all = loadAll();
  all[props.paneKey] = {
    x: Math.round(geom.x),
    y: Math.round(geom.y),
    w: Math.round(geom.w),
    h: Math.round(geom.h),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

/**
 * Opening spot for a window nobody has moved yet: upper right, below the header. The
 * things it must not land on top of are at the two ends of the screen, the tooldock at
 * the top left of the board and the composer along the bottom of the chat.
 */
const TOP = 92;

function initial(): Geom {
  const saved = loadAll()[props.paneKey];
  const w = Math.min(saved?.w ?? props.w, Math.max(props.minW, window.innerWidth - 2 * MARGIN));
  const h = Math.min(
    saved?.h ?? props.h,
    Math.max(props.minH, window.innerHeight - TOP - 2 * MARGIN),
  );
  return {
    w,
    h,
    x: saved?.x ?? Math.max(MARGIN, window.innerWidth - w - MARGIN * 2),
    y: saved?.y ?? TOP,
  };
}

const geom = reactive<Geom>(initial());

/**
 * Keep it reachable. A window left at the right edge of the ultrawide would otherwise
 * open off the side of the laptop screen, with its title bar (the only way to drag it
 * back) out of reach.
 */
function clamp(): void {
  geom.w = Math.max(props.minW, Math.min(geom.w, window.innerWidth - 2 * MARGIN));
  geom.h = Math.max(props.minH, Math.min(geom.h, window.innerHeight - 2 * MARGIN));
  geom.x = Math.max(MARGIN - geom.w * 0.5, Math.min(geom.x, window.innerWidth - MARGIN * 4));
  geom.y = Math.max(0, Math.min(geom.y, window.innerHeight - MARGIN * 3));
}

function drag(e: PointerEvent, mode: 'move' | 'size'): void {
  const handle = e.currentTarget as HTMLElement;
  e.preventDefault();
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    /* capture is best-effort */
  }
  const startX = e.clientX;
  const startY = e.clientY;
  const start = { ...geom };
  const move = (ev: PointerEvent) => {
    if (mode === 'move') {
      geom.x = start.x + (ev.clientX - startX);
      geom.y = start.y + (ev.clientY - startY);
    } else {
      geom.w = Math.max(props.minW, start.w + (ev.clientX - startX));
      geom.h = Math.max(props.minH, start.h + (ev.clientY - startY));
    }
    clamp();
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    save();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function onResize(): void {
  clamp();
}

onMounted(() => {
  clamp();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div
    class="floatwin"
    :style="{ left: `${geom.x}px`, top: `${geom.y}px`, width: `${geom.w}px`, height: `${geom.h}px` }"
    role="dialog"
    :aria-label="title"
  >
    <div class="fw-head" @pointerdown="drag($event, 'move')">
      <span class="fw-title">{{ title }}</span>
      <span class="fw-acts" @pointerdown.stop>
        <slot name="actions" />
      </span>
      <button class="fw-x" type="button" aria-label="Close" title="Close" @pointerdown.stop @click="emit('close')">
        ×
      </button>
    </div>
    <div class="fw-body">
      <slot />
    </div>
    <span
      class="fw-grip"
      title="Drag to resize"
      @pointerdown="drag($event, 'size')"
    />
  </div>
</template>

<style scoped>
.floatwin {
  position: fixed;
  /* Over the ink editor, which owns its pane at 10, and under the note dialog at 40:
     opening a note covers the window rather than fighting it for the screen. */
  z-index: 30;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.fw-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.4rem 0.4rem 0.7rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.fw-head:active {
  cursor: grabbing;
}

.fw-title {
  flex: 1;
  min-width: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fw-acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  cursor: default;
}

.fw-x {
  flex: none;
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 1.05rem;
  line-height: 1;
  padding: 0.15rem 0.35rem;
  cursor: pointer;
}

.fw-x:hover {
  color: var(--ink);
}

.fw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.fw-grip {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  opacity: 0.6;
  background: linear-gradient(
    135deg,
    transparent 0 46%,
    var(--muted) 46% 54%,
    transparent 54% 66%,
    var(--muted) 66% 74%,
    transparent 74%
  );
}

.fw-grip:hover {
  opacity: 1;
}
</style>
