import { onBeforeUnmount, reactive, watch, type Ref } from 'vue';
import { settings } from '@/stores/settings';

/**
 * Stroke-based ink engine for a graphics tablet (Wacom & friends) drawing straight
 * onto the canvas via pointer events — the second input source beside the Neo pen.
 *
 * Design decisions, each mirroring a friction point of writing algebra on a tablet:
 * - All ink lives in a fixed PAGE coordinate space (height 1000, width from the
 *   configured tablet aspect). The on-screen canvas is aspect-locked to the same
 *   ratio, so tablet-to-screen mapping never stretches differently per monitor.
 * - Strokes are objects, not pixels: undo pops a whole stroke, the eraser removes
 *   whole strokes it touches. One bad symbol disappears cleanly instead of leaving
 *   half-scrubbed pixels between the lines.
 * - Input is lightly smoothed (EMA over position and pressure) so raw tablet jitter
 *   does not read as shaky handwriting; the final raw point is kept so tails and
 *   serifs are not cut off.
 * - The view can zoom and pan, but stroke width is defined in page units: ink
 *   written at any zoom has the same thickness ON THE PAGE, so a long derivation
 *   stays uniform.
 * - A scratch column on the right takes side arithmetic. A stroke belongs to the
 *   zone it STARTS in, and exports include only main-zone ink, so abandoned scraps
 *   never reach the grader.
 * - exportImage() crops to the ink's bounding box plus a margin generous enough
 *   that exponents, fraction bars, and subscripts never touch the edge.
 */

export interface TabletPoint {
  x: number;
  y: number;
  p: number; // pressure 0..1
}

export type TabletZone = 'main' | 'scratch';

export interface TabletStroke {
  id: number;
  zone: TabletZone;
  w: number; // base width in page units; pressure modulates around it
  pts: TabletPoint[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Op = { kind: 'add'; stroke: TabletStroke } | { kind: 'erase'; strokes: TabletStroke[] };

export interface TabletState {
  tool: 'pen' | 'eraser';
  zoomPct: number;
  canUndo: boolean;
  canRedo: boolean;
  hasInk: boolean; // main-zone ink (what grading gates on)
}

export interface UseTabletOptions {
  onInk?: () => void; // fires when the pen touches down to draw
  // false = a plain page with no scratch column (the notes editor: nothing on a
  // general note is "not graded", so the divider would only confuse).
  scratch?: boolean;
}

const PAGE_H = 1000;
// Hard ceiling on how far pressure can widen a stroke past its base width. Kept
// tight: a heavy hand should not turn the configured fine pen into a marker.
const WIDTH_CAP = 1.2;
const MAX_UNDO = 200;
const EXPORT_MARGIN = 30; // page units around the ink, keeps superscripts off the edge
const MIN_Z = 1;
const MAX_Z = 8;

export function useTablet(canvasRef: Ref<HTMLCanvasElement | null>, options: UseTabletOptions = {}) {
  const strokes: TabletStroke[] = [];
  const undoStack: Op[] = [];
  const redoStack: Op[] = [];
  let nextId = 1;
  // Monotonic ink revision: add/erase/undo/redo/clear all advance it. The hint
  // ladder's "page unchanged since last hint" reads this, so un-doing ink counts as
  // a change exactly like adding ink does.
  let rev = 0;

  const state = reactive<TabletState>({
    tool: 'pen',
    zoomPct: 100,
    canUndo: false,
    canRedo: false,
    hasInk: false,
  });

  // View: zoom factor over the fit scale, plus the page point at the viewport centre.
  const view = { z: 1, cx: 0, cy: 0 };
  let viewInit = false;

  function pageW(): number {
    const a = Number(settings.tablet.aspect) || 1.6;
    return Math.round(PAGE_H * Math.min(2.4, Math.max(0.8, a)));
  }

  function scratchX(): number {
    if (options.scratch === false) return Infinity;
    const share = Math.min(0.4, Math.max(0, Number(settings.tablet.scratchShare) || 0));
    return share >= 0.05 ? pageW() * (1 - share) : Infinity; // Infinity = no scratch zone
  }

  function baseWidth(): number {
    const w = Number(settings.tablet.baseWidth);
    return Number.isFinite(w) && w > 0 ? Math.min(6, Math.max(0.5, w)) : 1.2;
  }

  function context(): CanvasRenderingContext2D | null {
    const c = canvasRef.value;
    return c ? c.getContext('2d') : null;
  }

  function fitScale(c: HTMLCanvasElement): number {
    return Math.min(c.width / pageW(), c.height / PAGE_H);
  }

  function scale(c: HTMLCanvasElement): number {
    return fitScale(c) * view.z;
  }

  function offsets(c: HTMLCanvasElement): { ox: number; oy: number } {
    const S = scale(c);
    return { ox: c.width / 2 - view.cx * S, oy: c.height / 2 - view.cy * S };
  }

  function clampView(): void {
    view.z = Math.min(MAX_Z, Math.max(MIN_Z, view.z));
    if (view.z <= MIN_Z + 1e-6) {
      view.cx = pageW() / 2;
      view.cy = PAGE_H / 2;
    } else {
      view.cx = Math.min(pageW(), Math.max(0, view.cx));
      view.cy = Math.min(PAGE_H, Math.max(0, view.cy));
    }
    state.zoomPct = Math.round(view.z * 100);
  }

  function ensureView(): void {
    if (viewInit) return;
    viewInit = true;
    view.cx = pageW() / 2;
    view.cy = PAGE_H / 2;
  }

  // ---- rendering ----

  let rafId = 0;

  function scheduleRender(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      redraw();
    });
  }

  // Pressure barely moves the line (mirrors the Neo engine): the resting width IS
  // the configured width, a heavy hand adds at most WIDTH_CAP. Steeper curves kept
  // reading as "thicker than the setting says" under real writing pressure.
  function widthFor(s: TabletStroke, p: number): number {
    return Math.min(s.w * WIDTH_CAP, Math.max(0.4, s.w * (0.85 + 0.3 * p)));
  }

  // Bucketed so consecutive segments of near-equal pressure batch into one path.
  function bucket(w: number): number {
    return Math.round(w / 0.15) * 0.15;
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: TabletStroke): void {
    const pts = s.pts;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      const r = widthFor(s, pts[0].p) / 2;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    let bw = -1;
    let open = false;
    for (let i = 1; i < pts.length; i += 1) {
      const w = bucket(widthFor(s, pts[i].p));
      if (w !== bw) {
        if (open) ctx.stroke();
        ctx.beginPath();
        ctx.lineWidth = w;
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        open = true;
        bw = w;
      }
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    if (open) ctx.stroke();
  }

  function drawStrokes(ctx: CanvasRenderingContext2D, list: TabletStroke[]): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = settings.canvas.strokeColor;
    ctx.fillStyle = settings.canvas.strokeColor;
    for (const s of list) drawStroke(ctx, s);
  }

  function cssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function redraw(): void {
    const ctx = context();
    const c = canvasRef.value;
    if (!ctx || !c) return;
    ensureView();
    clampView();
    const W = pageW();
    const S = scale(c);
    const { ox, oy } = offsets(c);

    // Desk outside the page, then the white page itself.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar('--bg', '#f4f4f1');
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(S, 0, 0, S, ox, oy);
    ctx.fillStyle = settings.canvas.backgroundColor;
    ctx.fillRect(0, 0, W, PAGE_H);
    ctx.strokeStyle = cssVar('--border', '#e3e2db');
    ctx.lineWidth = 1.5 / view.z;
    ctx.strokeRect(0, 0, W, PAGE_H);

    // The Raster: kariert-paper grid, screen-only (exports stay clean white so the
    // grader and note images never carry it). Hairline at any zoom.
    const grid = Number(settings.tablet.gridSize) || 0;
    if (grid >= 10) {
      ctx.save();
      ctx.strokeStyle = 'rgba(100, 140, 180, 0.18)';
      ctx.lineWidth = 1 / S; // one device pixel
      ctx.beginPath();
      for (let x = grid; x < W; x += grid) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, PAGE_H);
      }
      for (let y = grid; y < PAGE_H; y += grid) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Scratch divider: dashed, with a quiet label. Page space, so it zooms along.
    const sx = scratchX();
    if (Number.isFinite(sx)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(140, 138, 125, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([7, 7]);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, PAGE_H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(140, 138, 125, 0.7)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Notizen — wird nicht bewertet', sx + 12, 24);
      ctx.restore();
    }

    if (backdrop && backdropRect) {
      ctx.drawImage(backdrop, backdropRect.x, backdropRect.y, backdropRect.w, backdropRect.h);
    }
    drawStrokes(ctx, strokes);

    // Eraser ring while erasing, so the hit radius is visible.
    if (erasing && lastErase) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(177, 73, 47, 0.8)';
      ctx.lineWidth = 1.2 / view.z;
      ctx.arc(lastErase.x, lastErase.y, eraseRadius(), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- input ----

  interface ActiveStroke {
    pointerId: number;
    stroke: TabletStroke;
    sx: number;
    sy: number;
    sp: number;
  }

  let active: ActiveStroke | null = null;
  let erasing: { pointerId: number; removed: TabletStroke[] } | null = null;
  let panning: { pointerId: number; lastX: number; lastY: number } | null = null;
  let lastErase: { x: number; y: number } | null = null;
  let lastDown: { type: string; button: number; buttons: number } | null = null;
  // A backdrop layer under the strokes: a note saved before stroke persistence
  // reopens with its image here, so it can be continued instead of staying a dead
  // snapshot. Included in exports, never erasable, never part of undo.
  let backdrop: HTMLImageElement | null = null;
  let backdropRect: { x: number; y: number; w: number; h: number } | null = null;

  function setBackdrop(dataUrl: string | null): void {
    if (!dataUrl) {
      backdrop = null;
      backdropRect = null;
      scheduleRender();
      return;
    }
    const img = new Image();
    img.onload = () => {
      const M = 40;
      const k = Math.min((pageW() - 2 * M) / img.width, (PAGE_H - 2 * M) / img.height, 1.5);
      backdrop = img;
      backdropRect = { x: M, y: M, w: img.width * k, h: img.height * k };
      scheduleRender();
    };
    img.src = dataUrl;
  }

  function toPage(c: HTMLCanvasElement, clientX: number, clientY: number): TabletPoint {
    const rect = c.getBoundingClientRect();
    const X = ((clientX - rect.left) / Math.max(1, rect.width)) * c.width;
    const Y = ((clientY - rect.top) / Math.max(1, rect.height)) * c.height;
    const S = scale(c);
    const { ox, oy } = offsets(c);
    return { x: (X - ox) / S, y: (Y - oy) / S, p: 0.5 };
  }

  function clampToPage(pt: TabletPoint): TabletPoint {
    pt.x = Math.min(pageW(), Math.max(0, pt.x));
    pt.y = Math.min(PAGE_H, Math.max(0, pt.y));
    return pt;
  }

  function pressureOf(e: PointerEvent): number {
    // Mice report 0.5 while pressed; some pens report 0 on the first event.
    const p = e.pressure;
    return p > 0 ? Math.min(1, p) : 0.5;
  }

  function growBbox(s: TabletStroke, pt: TabletPoint): void {
    if (pt.x < s.minX) s.minX = pt.x;
    if (pt.y < s.minY) s.minY = pt.y;
    if (pt.x > s.maxX) s.maxX = pt.x;
    if (pt.y > s.maxY) s.maxY = pt.y;
  }

  function bump(): void {
    rev += 1;
    state.canUndo = undoStack.length > 0;
    state.canRedo = redoStack.length > 0;
    state.hasInk = strokes.some((s) => s.zone === 'main');
  }

  function pushOp(op: Op): void {
    undoStack.push(op);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    bump();
  }

  function isEraserPointer(e: PointerEvent): boolean {
    // The eraser end of a pen: button 5 at pointerdown, bit 32 in buttons while down.
    return e.button === 5 || (e.buttons & 32) !== 0;
  }

  function beginStroke(c: HTMLCanvasElement, e: PointerEvent): void {
    const pt = clampToPage(toPage(c, e.clientX, e.clientY));
    pt.p = pressureOf(e);
    const zone: TabletZone = pt.x >= scratchX() ? 'scratch' : 'main';
    const stroke: TabletStroke = {
      id: nextId++,
      zone,
      w: baseWidth(),
      pts: [pt],
      minX: pt.x,
      minY: pt.y,
      maxX: pt.x,
      maxY: pt.y,
    };
    active = { pointerId: e.pointerId, stroke, sx: pt.x, sy: pt.y, sp: pt.p };
    options.onInk?.();
  }

  function appendPoint(c: HTMLCanvasElement, e: PointerEvent, raw = false): void {
    if (!active) return;
    const s = active.stroke;
    const pt = clampToPage(toPage(c, e.clientX, e.clientY));
    const p = pressureOf(e);
    let x = pt.x;
    let y = pt.y;
    let pr = p;
    if (!raw) {
      // Light EMA: enough to take the shake out of raw tablet input, light enough
      // that the written form stays the learner's own hand.
      const a = 1 - Math.min(0.85, Math.max(0, Number(settings.tablet.smoothing) || 0));
      x = active.sx + (pt.x - active.sx) * a;
      y = active.sy + (pt.y - active.sy) * a;
      pr = active.sp + (p - active.sp) * a;
      active.sx = x;
      active.sy = y;
      active.sp = pr;
    }
    const prev = s.pts[s.pts.length - 1];
    const dx = x - prev.x;
    const dy = y - prev.y;
    // Sub-unit jitter carries no shape: skip it unless the pressure moved.
    if (!raw && dx * dx + dy * dy < 0.5 && Math.abs(pr - prev.p) < 0.05) return;
    const next: TabletPoint = { x, y, p: pr };
    s.pts.push(next);
    growBbox(s, next);
    // Incremental draw of just the fresh segment keeps the pen latency at one frame.
    const ctx = context();
    if (ctx) {
      const S = scale(c);
      const { ox, oy } = offsets(c);
      ctx.setTransform(S, 0, 0, S, ox, oy);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = settings.canvas.strokeColor;
      ctx.lineWidth = bucket(widthFor(s, next.p));
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }
  }

  function endStroke(): void {
    if (!active) return;
    const s = active.stroke;
    active = null;
    strokes.push(s);
    pushOp({ kind: 'add', stroke: s });
    scheduleRender();
  }

  // ---- eraser ----

  function eraseRadius(): number {
    // Finer when zoomed in, so single symbols can be picked out of dense work.
    return Math.min(9, Math.max(2.5, 9 / view.z));
  }

  function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2)) : 0;
    const dx = px - (ax + abx * t);
    const dy = py - (ay + aby * t);
    return dx * dx + dy * dy;
  }

  function strokeHit(s: TabletStroke, x: number, y: number, r: number): boolean {
    const pad = r + s.w;
    if (x < s.minX - pad || x > s.maxX + pad || y < s.minY - pad || y > s.maxY + pad) return false;
    const pts = s.pts;
    if (pts.length === 1) {
      const dx = pts[0].x - x;
      const dy = pts[0].y - y;
      return dx * dx + dy * dy <= pad * pad;
    }
    const r2 = pad * pad;
    for (let i = 1; i < pts.length; i += 1) {
      if (segDist2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) return true;
    }
    return false;
  }

  function eraseAt(x: number, y: number): void {
    if (!erasing) return;
    const r = eraseRadius();
    for (let i = strokes.length - 1; i >= 0; i -= 1) {
      if (strokeHit(strokes[i], x, y, r)) {
        erasing.removed.push(strokes[i]);
        strokes.splice(i, 1);
      }
    }
    lastErase = { x, y };
    scheduleRender(); // the ring follows the pen even without a hit
  }

  function endErase(): void {
    if (!erasing) return;
    const removed = erasing.removed;
    erasing = null;
    lastErase = null;
    if (removed.length) pushOp({ kind: 'erase', strokes: removed });
    scheduleRender();
  }

  // ---- undo / redo ----

  function removeById(id: number): void {
    const i = strokes.findIndex((s) => s.id === id);
    if (i >= 0) strokes.splice(i, 1);
  }

  function reinsert(list: TabletStroke[]): void {
    strokes.push(...list);
    strokes.sort((a, b) => a.id - b.id); // ids are monotonic, so z-order is restored
  }

  function undo(): void {
    const op = undoStack.pop();
    if (!op) return;
    if (op.kind === 'add') removeById(op.stroke.id);
    else reinsert(op.strokes);
    redoStack.push(op);
    bump();
    scheduleRender();
  }

  function redo(): void {
    const op = redoStack.pop();
    if (!op) return;
    if (op.kind === 'add') reinsert([op.stroke]);
    else for (const s of op.strokes) removeById(s.id);
    undoStack.push(op);
    bump();
    scheduleRender();
  }

  function toggleEraser(): void {
    state.tool = state.tool === 'eraser' ? 'pen' : 'eraser';
  }

  // ---- zoom / pan ----

  function zoomAt(c: HTMLCanvasElement, canvasX: number, canvasY: number, factor: number): void {
    ensureView();
    const S0 = scale(c);
    const px = (canvasX - offsets(c).ox) / S0;
    const py = (canvasY - offsets(c).oy) / S0;
    view.z = Math.min(MAX_Z, Math.max(MIN_Z, view.z * factor));
    const S1 = scale(c);
    // Keep the page point under the cursor stationary.
    view.cx = px - (canvasX - c.width / 2) / S1;
    view.cy = py - (canvasY - c.height / 2) / S1;
    clampView();
    scheduleRender();
  }

  function zoomBy(factor: number): void {
    const c = canvasRef.value;
    if (!c) return;
    zoomAt(c, c.width / 2, c.height / 2, factor);
  }

  function resetView(): void {
    view.z = 1;
    view.cx = pageW() / 2;
    view.cy = PAGE_H / 2;
    clampView();
    scheduleRender();
  }

  // ---- hold-to-repeat undo (pen barrel button) ----

  // Keep the undo button pressed and strokes peel off one after another; a single
  // click still removes exactly one. Stops on release (up, cancel, or a move that
  // shows the button no longer down) and when the undo stack runs dry.
  const HOLD_UNDO_DELAY_MS = 450;
  const HOLD_UNDO_EVERY_MS = 110;
  let holdUndo: { pointerId: number; timer: number } | null = null;

  function stopHoldUndo(): void {
    if (!holdUndo) return;
    window.clearInterval(holdUndo.timer);
    holdUndo = null;
  }

  function startHoldUndo(pointerId: number): void {
    stopHoldUndo();
    const started = performance.now();
    const timer = window.setInterval(() => {
      if (performance.now() - started < HOLD_UNDO_DELAY_MS) return;
      if (undoStack.length === 0) {
        stopHoldUndo();
        return;
      }
      undo();
    }, HOLD_UNDO_EVERY_MS);
    holdUndo = { pointerId, timer };
  }

  // ---- event handlers ----

  function onPointerDown(e: PointerEvent): void {
    const c = canvasRef.value;
    if (!c) return;
    // What the driver actually sends, readable via __nlTablet().lastDown — pen
    // button mysteries become facts instead of guesses.
    lastDown = { type: e.pointerType, button: e.button, buttons: e.buttons };
    if (e.pointerType === 'touch') return; // palm rejection: fingers never draw
    e.preventDefault();
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    if (e.button === 1) {
      panning = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
      return;
    }
    // The pen's lower barrel button = undo, whichever way the driver reports it: a
    // press while hovering (button 2) or the tip landing with the button held
    // (buttons bit 2). Accepted from any pointer type so a driver that reports the
    // pen as a mouse still works; the canvas suppresses the context menu anyway.
    if (e.button === 2 || (e.buttons & 2) !== 0) {
      undo();
      startHoldUndo(e.pointerId);
      return;
    }
    if (isEraserPointer(e) || state.tool === 'eraser') {
      erasing = { pointerId: e.pointerId, removed: [] };
      const pt = toPage(c, e.clientX, e.clientY);
      eraseAt(pt.x, pt.y);
      options.onInk?.();
      return;
    }
    if (e.button !== 0) return;
    beginStroke(c, e);
  }

  // The full-rate event list where the browser provides one; synthetic events and
  // some platforms hand back an EMPTY array, which must fall back to the event
  // itself or moves would be dropped silently.
  function coalesced(e: PointerEvent): PointerEvent[] {
    const list = e.getCoalescedEvents?.();
    return list && list.length ? list : [e];
  }

  function onPointerMove(e: PointerEvent): void {
    const c = canvasRef.value;
    if (!c) return;
    // A hovering pen streams moves; the moment the barrel button is no longer down
    // the hold ends, even if the matching pointerup got lost.
    if (holdUndo && e.pointerId === holdUndo.pointerId && (e.buttons & 2) === 0) stopHoldUndo();
    if (panning && e.pointerId === panning.pointerId) {
      const rect = c.getBoundingClientRect();
      const S = scale(c);
      const kx = c.width / Math.max(1, rect.width);
      const ky = c.height / Math.max(1, rect.height);
      view.cx -= ((e.clientX - panning.lastX) * kx) / S;
      view.cy -= ((e.clientY - panning.lastY) * ky) / S;
      panning.lastX = e.clientX;
      panning.lastY = e.clientY;
      clampView();
      scheduleRender();
      return;
    }
    if (erasing && e.pointerId === erasing.pointerId) {
      for (const ev of coalesced(e)) {
        const pt = toPage(c, ev.clientX, ev.clientY);
        eraseAt(pt.x, pt.y);
      }
      return;
    }
    if (active && e.pointerId === active.pointerId) {
      for (const ev of coalesced(e)) appendPoint(c, ev);
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const c = canvasRef.value;
    if (holdUndo && e.pointerId === holdUndo.pointerId) stopHoldUndo();
    if (panning && e.pointerId === panning.pointerId) {
      panning = null;
      return;
    }
    if (erasing && e.pointerId === erasing.pointerId) {
      endErase();
      return;
    }
    if (active && e.pointerId === active.pointerId) {
      // The last raw (unsmoothed) point keeps stroke tails from being cut short.
      if (c) appendPoint(c, e, true);
      endStroke();
    }
  }

  function onPointerCancel(e: PointerEvent): void {
    if (holdUndo && e.pointerId === holdUndo.pointerId) stopHoldUndo();
    if (panning && e.pointerId === panning.pointerId) panning = null;
    if (erasing && e.pointerId === erasing.pointerId) endErase();
    if (active && e.pointerId === active.pointerId) endStroke();
  }

  function onWheel(e: WheelEvent): void {
    const c = canvasRef.value;
    if (!c) return;
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      const X = ((e.clientX - rect.left) / Math.max(1, rect.width)) * c.width;
      const Y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * c.height;
      zoomAt(c, X, Y, Math.exp(-e.deltaY * 0.0022));
    } else {
      const S = scale(c);
      const kx = c.width / Math.max(1, rect.width);
      view.cx += (e.deltaX * kx) / S;
      view.cy += (e.deltaY * kx) / S;
      clampView();
      scheduleRender();
    }
  }

  function onContextMenu(e: Event): void {
    e.preventDefault(); // the barrel button must never open a context menu mid-flow
  }

  function attach(c: HTMLCanvasElement): void {
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', onPointerCancel);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', onContextMenu);
  }

  function detach(c: HTMLCanvasElement): void {
    stopHoldUndo();
    c.removeEventListener('pointerdown', onPointerDown);
    c.removeEventListener('pointermove', onPointerMove);
    c.removeEventListener('pointerup', onPointerUp);
    c.removeEventListener('pointercancel', onPointerCancel);
    c.removeEventListener('wheel', onWheel);
    c.removeEventListener('contextmenu', onContextMenu);
  }

  watch(
    canvasRef,
    (c, old) => {
      if (old) detach(old);
      if (c) {
        attach(c);
        resize();
      }
    },
    { immediate: true, flush: 'post' },
  );

  // Aspect, scratch-share, or grid edits re-shape the page live.
  watch(
    () => [
      settings.tablet.aspect,
      settings.tablet.scratchShare,
      settings.tablet.gridSize,
      settings.canvas.strokeColor,
    ],
    () => {
      clampView();
      scheduleRender();
    },
  );

  onBeforeUnmount(() => {
    const c = canvasRef.value;
    if (c) detach(c);
    stopHoldUndo();
    if (rafId) cancelAnimationFrame(rafId);
  });

  // ---- surface interface (parity with useCanvas) ----

  function resize(): void {
    const c = canvasRef.value;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    // Hidden (v-show off, other tab): keep the last real bitmap, exactly like useCanvas.
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    redraw();
  }

  function clear(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    strokes.length = 0;
    undoStack.length = 0;
    redoStack.length = 0;
    active = null;
    erasing = null;
    lastErase = null;
    backdrop = null;
    backdropRect = null;
    stopHoldUndo();
    bump();
    redraw();
  }

  function hasContent(): boolean {
    return strokes.some((s) => s.zone === 'main');
  }

  function strokeCount(): number {
    return rev;
  }

  // 'main' is what grading sees; 'all' additionally takes the scratch column along
  // (a note capture wants the whole page, side arithmetic included).
  function exportImage(zone: 'main' | 'all' = 'main'): string {
    const main = zone === 'all' ? strokes.slice() : strokes.filter((s) => s.zone === 'main');
    const bg = zone === 'all' && backdrop && backdropRect ? backdropRect : null;
    if (main.length === 0 && !bg) return '';
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of main) {
      const inflate = (s.w * WIDTH_CAP) / 2;
      minX = Math.min(minX, s.minX - inflate);
      minY = Math.min(minY, s.minY - inflate);
      maxX = Math.max(maxX, s.maxX + inflate);
      maxY = Math.max(maxY, s.maxY + inflate);
    }
    if (bg) {
      minX = Math.min(minX, bg.x);
      minY = Math.min(minY, bg.y);
      maxX = Math.max(maxX, bg.x + bg.w);
      maxY = Math.max(maxY, bg.y + bg.h);
    }
    minX -= EXPORT_MARGIN;
    minY -= EXPORT_MARGIN;
    maxX += EXPORT_MARGIN;
    maxY += EXPORT_MARGIN;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // Long edge capped by the export setting; scale also capped so a single short
    // line is not blown up into billboard glyphs (fewer pixels, fewer tokens).
    const k = Math.min(settings.export.maxEdgePx / Math.max(w, h), 1.6);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = settings.canvas.backgroundColor;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    if (bg && backdrop) ctx.drawImage(backdrop, bg.x, bg.y, bg.w, bg.h);
    drawStrokes(ctx, main);
    return out.toDataURL('image/jpeg', settings.export.jpegQuality);
  }

  // Console probe: __nlTablet() shows the live stroke/zone counts, the ink revision,
  // the view, and the export size — pen problems become checkable facts instead of
  // guesses about what the canvas holds.
  if (typeof window !== 'undefined') {
    (window as unknown as { __nlTablet: unknown }).__nlTablet = () => ({
      strokes: strokes.length,
      main: strokes.filter((s) => s.zone === 'main').length,
      scratch: strokes.filter((s) => s.zone === 'scratch').length,
      rev,
      zoomPct: state.zoomPct,
      tool: state.tool,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      lastDown,
      exportBytes: exportImage().length,
    });
  }

  // Ink round-trip: notes persist their strokes so a saved page can be reopened and
  // continued, not just looked at. Plain-JSON copies both ways.
  function getStrokes(): TabletStroke[] {
    return JSON.parse(JSON.stringify(strokes)) as TabletStroke[];
  }

  function setStrokes(list: TabletStroke[]): void {
    strokes.length = 0;
    undoStack.length = 0;
    redoStack.length = 0;
    active = null;
    erasing = null;
    let maxId = 0;
    for (const s of list) {
      if (!s || !Array.isArray(s.pts) || s.pts.length === 0) continue;
      strokes.push(s);
      if (s.id > maxId) maxId = s.id;
    }
    nextId = maxId + 1;
    bump();
    resetView();
  }

  return {
    state,
    clear,
    resize,
    redraw,
    exportImage,
    hasContent,
    strokeCount,
    undo,
    redo,
    toggleEraser,
    zoomBy,
    resetView,
    getStrokes,
    setStrokes,
    setBackdrop,
  };
}
