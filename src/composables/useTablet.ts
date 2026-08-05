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
 * - Two surface shapes from the same engine (options.board). A PAGE is the fixed
 *   sheet above, bounded, never zoomed out past fit — the math pad, where one page
 *   is one problem. A BOARD is unbounded in every direction: ink goes anywhere,
 *   the view zooms far out and pans past the ink, and the grid runs to the edges.
 *   Notes are written on a board, because a topic does not end where a sheet does.
 *   Coordinates are the same in both, so a note written on the old fixed page
 *   reopens exactly where it was.
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
  tool: 'pen' | 'eraser' | 'hand'; // hand = drag the surface instead of writing on it
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
  // true = an unbounded board instead of a fixed page (see the header note).
  board?: boolean;
  // Console probe name. Two surfaces exist at once (the math pad and the notes
  // board), so they must not overwrite each other's probe: whichever mounted last
  // would answer for both, and a pen problem would be diagnosed on the wrong one.
  probeName?: string;
}

const PAGE_H = 1000;
// Hard ceiling on how far pressure can widen a stroke past its base width. Kept
// tight: a heavy hand should not turn the configured fine pen into a marker.
const WIDTH_CAP = 1.2;
const MAX_UNDO = 200;
const EXPORT_MARGIN = 30; // page units around the ink, keeps superscripts off the edge
const MIN_Z = 1;
const MAX_Z = 8;
// A board zooms out to a twentieth: a session's worth of notes fits on screen at
// once, which is the whole point of not being a page.
const BOARD_MIN_Z = 0.05;
// How far past the ink a board may be panned: one page in every direction, so
// there is always empty surface to start writing on, and never a void to get lost in.
const BOARD_PAN_SLACK = PAGE_H;
// Grid lines closer together than this on screen read as fog, so that pass is skipped.
const GRID_MIN_PX = 5;
// Ceiling on a board export's pixel count. A board can be far wider than a page,
// and scaling its long edge down to the page cap would thin the ink below what the
// transcriber can read — so board exports stay 1:1 in page units up to this budget.
const BOARD_MAX_PX = 4_000_000;

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

  function minZ(): number {
    return options.board ? BOARD_MIN_Z : MIN_Z;
  }

  function fitScale(c: HTMLCanvasElement): number {
    // Board: 100% means one page height fills the viewport, and the surface simply
    // continues past the edges. Page: 100% means the whole sheet is visible.
    if (options.board) return c.height / PAGE_H;
    return Math.min(c.width / pageW(), c.height / PAGE_H);
  }

  function scale(c: HTMLCanvasElement): number {
    return fitScale(c) * view.z;
  }

  function offsets(c: HTMLCanvasElement): { ox: number; oy: number } {
    const S = scale(c);
    return { ox: c.width / 2 - view.cx * S, oy: c.height / 2 - view.cy * S };
  }

  interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  // What the board actually holds: the ink and backdrop, unioned with one nominal
  // page at the origin. Keeping that home sheet in the union means Fit never blows
  // a single short stroke up to fill the screen, and the starting area stays findable.
  function contentBox(): Box {
    const b: Box = { minX: 0, minY: 0, maxX: pageW(), maxY: PAGE_H };
    for (const s of strokes) {
      if (s.minX < b.minX) b.minX = s.minX;
      if (s.minY < b.minY) b.minY = s.minY;
      if (s.maxX > b.maxX) b.maxX = s.maxX;
      if (s.maxY > b.maxY) b.maxY = s.maxY;
    }
    if (backdropRect) {
      b.minX = Math.min(b.minX, backdropRect.x);
      b.minY = Math.min(b.minY, backdropRect.y);
      b.maxX = Math.max(b.maxX, backdropRect.x + backdropRect.w);
      b.maxY = Math.max(b.maxY, backdropRect.y + backdropRect.h);
    }
    return b;
  }

  // The slice of surface currently on screen, in page units.
  function worldRect(c: HTMLCanvasElement): Box {
    const S = scale(c);
    const { ox, oy } = offsets(c);
    return {
      minX: -ox / S,
      minY: -oy / S,
      maxX: (c.width - ox) / S,
      maxY: (c.height - oy) / S,
    };
  }

  function clampView(): void {
    view.z = Math.min(MAX_Z, Math.max(minZ(), view.z));
    if (options.board) {
      // Free panning, bounded only by the content plus a page of slack.
      const b = contentBox();
      view.cx = Math.min(b.maxX + BOARD_PAN_SLACK, Math.max(b.minX - BOARD_PAN_SLACK, view.cx));
      view.cy = Math.min(b.maxY + BOARD_PAN_SLACK, Math.max(b.minY - BOARD_PAN_SLACK, view.cy));
    } else if (view.z <= MIN_Z + 1e-6) {
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

  // One pass of grid lines across the visible surface. Skipped when the spacing
  // would be too tight to read, which is what keeps a zoomed-out board clean.
  function gridPass(ctx: CanvasRenderingContext2D, r: Box, step: number, alpha: number, S: number): void {
    if (step <= 0 || step * S < GRID_MIN_PX) return;
    ctx.strokeStyle = `rgba(100, 140, 180, ${alpha})`;
    ctx.lineWidth = 1 / S; // one device pixel at any zoom
    ctx.beginPath();
    for (let x = Math.floor(r.minX / step) * step; x <= r.maxX; x += step) {
      ctx.moveTo(x, r.minY);
      ctx.lineTo(x, r.maxY);
    }
    for (let y = Math.floor(r.minY / step) * step; y <= r.maxY; y += step) {
      ctx.moveTo(r.minX, y);
      ctx.lineTo(r.maxX, y);
    }
    ctx.stroke();
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
    const grid = Number(settings.tablet.gridSize) || 0;

    if (options.board) {
      // No sheet and no desk: the surface is the same paper everywhere, and the
      // grid runs to all four edges so panning has visible landmarks.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = settings.canvas.backgroundColor;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(S, 0, 0, S, ox, oy);
      if (grid >= 10) {
        ctx.save();
        const r = worldRect(c);
        gridPass(ctx, r, grid, 0.16, S);
        // Every fifth line stays visible longer, so structure survives zooming out
        // well past the point where the fine grid disappears.
        gridPass(ctx, r, grid * 5, 0.22, S);
        ctx.restore();
      }
      if (backdrop && backdropRect) {
        ctx.drawImage(backdrop, backdropRect.x, backdropRect.y, backdropRect.w, backdropRect.h);
      }
      drawStrokes(ctx, strokes);
      if (erasing && lastErase) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(177, 73, 47, 0.8)';
        ctx.lineWidth = 1.2 / view.z;
        ctx.arc(lastErase.x, lastErase.y, eraseRadius(), 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }

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

  // On a page, ink stops at the edge. On a board there is no edge to stop at.
  function clampInk(pt: TabletPoint): TabletPoint {
    if (options.board) return pt;
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
    const pt = clampInk(toPage(c, e.clientX, e.clientY));
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
    const pt = clampInk(toPage(c, e.clientX, e.clientY));
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
    // Finer when zoomed in, so single symbols can be picked out of dense work. On a
    // board the cap is lifted: zoomed far out the ring must still cover something
    // bigger than a hairline, or erasing an old region means zooming back in first.
    const cap = options.board ? 60 : 9;
    return Math.min(cap, Math.max(2.5, 9 / view.z));
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

  // The hand: on a board the pen has to be able to move the surface, not only write
  // on it, and a tablet user has no middle mouse button. Holding space does the same
  // thing without leaving the pen tool.
  function toggleHand(): void {
    state.tool = state.tool === 'hand' ? 'pen' : 'hand';
  }

  // ---- zoom / pan ----

  function zoomAt(c: HTMLCanvasElement, canvasX: number, canvasY: number, factor: number): void {
    ensureView();
    const S0 = scale(c);
    const px = (canvasX - offsets(c).ox) / S0;
    const py = (canvasY - offsets(c).oy) / S0;
    view.z = Math.min(MAX_Z, Math.max(minZ(), view.z * factor));
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

  // Page: back to the whole sheet at 100%. Board: fit everything written, which is
  // the only way to find ink you panned away from — and it never zooms IN past 100%,
  // so a nearly empty board does not blow two words up to fill the screen.
  function resetView(): void {
    const c = canvasRef.value;
    if (options.board && c) {
      const b = contentBox();
      const w = Math.max(1, b.maxX - b.minX);
      const h = Math.max(1, b.maxY - b.minY);
      const base = fitScale(c);
      const need = Math.min(c.width / w, c.height / h) / base;
      view.z = Math.min(1, need * 0.96); // a little air around the content
      view.cx = (b.minX + b.maxX) / 2;
      view.cy = (b.minY + b.maxY) / 2;
    } else {
      view.z = 1;
      view.cx = pageW() / 2;
      view.cy = PAGE_H / 2;
    }
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
    // Middle button, the hand tool, or space held: drag the surface instead of
    // writing on it. On a board this is the primary way around.
    if (e.button === 1 || state.tool === 'hand' || spaceDown) {
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
      // Plain wheel / two-finger scroll pans: the board scrolls like a document in
      // both axes. (The vertical step used the horizontal ratio before, which made
      // scrolling drift on a non-square canvas.)
      const S = scale(c);
      const kx = c.width / Math.max(1, rect.width);
      const ky = c.height / Math.max(1, rect.height);
      view.cx += (e.deltaX * kx) / S;
      view.cy += (e.deltaY * ky) / S;
      clampView();
      scheduleRender();
    }
  }

  function onContextMenu(e: Event): void {
    e.preventDefault(); // the barrel button must never open a context menu mid-flow
  }

  // Space held = temporary hand, the convention every canvas app shares. Only the
  // flag is set here; typing a space into a field must stay a space, so nothing is
  // prevented and editable targets are ignored.
  let spaceDown = false;

  function isEditable(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  }

  function onSpaceDown(e: KeyboardEvent): void {
    if (e.code === 'Space' && !isEditable(e.target)) spaceDown = true;
  }

  function onSpaceUp(e: KeyboardEvent): void {
    if (e.code === 'Space') spaceDown = false;
  }

  function onWindowBlur(): void {
    spaceDown = false; // a key released outside the window would never be seen
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

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onSpaceDown);
    window.addEventListener('keyup', onSpaceUp);
    window.addEventListener('blur', onWindowBlur);
  }

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
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onSpaceDown);
      window.removeEventListener('keyup', onSpaceUp);
      window.removeEventListener('blur', onWindowBlur);
    }
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

  // Pixel size of the most recent export, for the probe: on a board this is the
  // number that decides both legibility and image cost.
  let lastExport = { w: 0, h: 0 };

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
    let k = Math.min(settings.export.maxEdgePx / Math.max(w, h), 1.6);
    if (options.board) {
      // A board's ink can span several pages. Squeezing that long edge into the page
      // cap would render the handwriting thinner than a pixel and the transcriber
      // would read nothing, so keep page units 1:1 and bound the total pixels instead.
      k = Math.min(1.6, Math.max(k, 1));
      const px = w * h * k * k;
      if (px > BOARD_MAX_PX) k *= Math.sqrt(BOARD_MAX_PX / px);
    }
    const out = document.createElement('canvas');
    // Rounding DOWN keeps a board export provably inside BOARD_MAX_PX; the pixel it
    // can cost either edge is a pixel of the crop margin, never of the ink.
    out.width = Math.max(1, Math.floor(w * k));
    out.height = Math.max(1, Math.floor(h * k));
    lastExport = { w: out.width, h: out.height };
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = settings.canvas.backgroundColor;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    if (bg && backdrop) ctx.drawImage(backdrop, bg.x, bg.y, bg.w, bg.h);
    drawStrokes(ctx, main);
    return out.toDataURL('image/jpeg', settings.export.jpegQuality);
  }

  // Console probe: __nlTablet() for the math pad, __nlInk() for the notes board.
  // Shows the live stroke/zone counts, the ink revision, the view, the surface's
  // grown bounds, and the export size — pen problems become checkable facts instead
  // of guesses about what the canvas holds.
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)[options.probeName ?? '__nlTablet'] = () => ({
      strokes: strokes.length,
      main: strokes.filter((s) => s.zone === 'main').length,
      scratch: strokes.filter((s) => s.zone === 'scratch').length,
      rev,
      zoomPct: state.zoomPct,
      tool: state.tool,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      lastDown,
      // Which surface shape this is, and how far it has grown.
      board: Boolean(options.board),
      bbox: contentBox(),
      view: { z: view.z, cx: Math.round(view.cx), cy: Math.round(view.cy) },
      exportBytes: exportImage().length,
      exportPx: lastExport,
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
    toggleHand,
    zoomBy,
    resetView,
    getStrokes,
    setStrokes,
    setBackdrop,
  };
}
