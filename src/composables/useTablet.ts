import { onBeforeUnmount, reactive, watch, type Ref } from 'vue';
import { settings } from '@/stores/settings';
import { holdDue } from '@/composables/holdRepeat';
import {
  EXPORT_MARGIN,
  baseWidth,
  bucketWidth,
  drawStrokes,
  planInkTiles,
  strokeBounds,
  tileScale,
  widthFor,
  type TabletPoint,
  type TabletStroke,
  type TabletZone,
} from '@/composables/inkExport';

// The stroke model and the paint loop live in inkExport, which the notes store also
// draws with. Re-exported here so the engine stays the one import a view needs.
export type { TabletPoint, TabletStroke, TabletZone };

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

/**
 * A picture placed on the surface: a pasted screenshot, a dropped photo. Centre,
 * size and angle in page units, with the bytes carried inline so a note round-trips
 * through one blob. Ink is drawn over the top of these.
 */
export interface TabletImage {
  id: number;
  src: string; // data URL
  x: number; // centre
  y: number;
  w: number;
  h: number;
  rot: number; // radians
}

type Op =
  | { kind: 'add'; stroke: TabletStroke }
  | { kind: 'erase'; strokes: TabletStroke[] }
  | { kind: 'imgAdd'; img: TabletImage }
  | { kind: 'imgDel'; img: TabletImage }
  | { kind: 'imgXform'; id: number; before: TabletImage; after: TabletImage };

export interface TabletState {
  // hand = drag the surface; select = pick up the pictures on it
  tool: 'pen' | 'eraser' | 'hand' | 'select';
  zoomPct: number;
  canUndo: boolean;
  canRedo: boolean;
  hasInk: boolean; // main-zone ink (what grading gates on)
  hasImages: boolean; // at least one picture placed on the surface
  hasSelection: boolean; // a picture is picked up, so Delete has a target
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
const MAX_UNDO = 200;
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
    hasImages: false,
    hasSelection: false,
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
    // A picture counts as content, so Fit frames it and the board can be panned
    // around one even before a single stroke is written near it.
    for (const im of images) {
      for (const p of imgCorners(im)) {
        if (p.x < b.minX) b.minX = p.x;
        if (p.y < b.minY) b.minY = p.y;
        if (p.x > b.maxX) b.maxX = p.x;
        if (p.y > b.maxY) b.maxY = p.y;
      }
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
      // Pictures sit under the ink, so writing on top of a screenshot works.
      drawImages(ctx, images);
      drawStrokes(ctx, strokes);
      drawSelection(ctx, S);
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
    drawImages(ctx, images);
    drawStrokes(ctx, strokes);
    drawSelection(ctx, S);

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

  // ---- pictures on the surface ----
  //
  // A screenshot pasted into a note is an OBJECT, not a backdrop: it can be picked
  // up, resized, turned and thrown away, and ink goes over the top of it. The
  // backdrop above stays what it always was, a fixed under-layer for notes saved
  // before strokes were persisted; this is the layer you can actually work with.
  //
  // Geometry is centre plus half-extent plus an angle, because that is what makes
  // rotation and corner-resize simple: every hit test moves the pointer into the
  // picture's own unrotated frame and asks a rectangle question there.

  const images: TabletImage[] = [];
  const imgEls = new Map<string, HTMLImageElement>();
  let selectedImg = 0; // id, 0 = nothing selected
  let imgDrag:
    | {
        pointerId: number;
        mode: 'move' | 'resize' | 'rotate';
        corner: number; // which corner is held, for resize
        startX: number;
        startY: number;
        before: TabletImage;
      }
    | null = null;

  const HANDLE_PX = 9; // on screen, so handles stay grabbable at any zoom
  const ROTATE_ARM_PX = 26;

  /** Decoded once per source and kept, so a redraw never waits on the image. */
  function imgEl(src: string): HTMLImageElement | null {
    const have = imgEls.get(src);
    if (have) return have.complete && have.naturalWidth > 0 ? have : null;
    const el = new Image();
    el.onload = () => scheduleRender();
    el.src = src;
    imgEls.set(src, el);
    return null;
  }

  function imageById(id: number): TabletImage | undefined {
    return images.find((i) => i.id === id);
  }

  /** The four corners in page space, clockwise from top-left of the unrotated box. */
  function imgCorners(im: TabletImage): { x: number; y: number }[] {
    const hw = im.w / 2;
    const hh = im.h / 2;
    const cos = Math.cos(im.rot);
    const sin = Math.sin(im.rot);
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([dx, dy]) => ({ x: im.x + dx * cos - dy * sin, y: im.y + dx * sin + dy * cos }));
  }

  /** The pointer expressed in the picture's own unrotated frame. */
  function toLocal(im: TabletImage, x: number, y: number): { x: number; y: number } {
    const cos = Math.cos(-im.rot);
    const sin = Math.sin(-im.rot);
    const dx = x - im.x;
    const dy = y - im.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  function pointInImage(im: TabletImage, x: number, y: number): boolean {
    const l = toLocal(im, x, y);
    return Math.abs(l.x) <= im.w / 2 && Math.abs(l.y) <= im.h / 2;
  }

  /** Topmost picture under the pointer; later ones are drawn on top, so search back. */
  function imageAt(x: number, y: number): TabletImage | null {
    for (let i = images.length - 1; i >= 0; i -= 1) {
      if (pointInImage(images[i], x, y)) return images[i];
    }
    return null;
  }

  /** Which grip of the selected picture is under the pointer, if any. */
  function gripAt(im: TabletImage, x: number, y: number, S: number): { mode: 'resize' | 'rotate'; corner: number } | null {
    const r = HANDLE_PX / S;
    const corners = imgCorners(im);
    for (let i = 0; i < 4; i += 1) {
      if (Math.hypot(x - corners[i].x, y - corners[i].y) <= r) return { mode: 'resize', corner: i };
    }
    // The turn grip sits off the top edge, on the picture's own up direction.
    const arm = ROTATE_ARM_PX / S;
    const up = { x: Math.sin(im.rot), y: -Math.cos(im.rot) };
    const hx = im.x + up.x * (im.h / 2 + arm);
    const hy = im.y + up.y * (im.h / 2 + arm);
    if (Math.hypot(x - hx, y - hy) <= r) return { mode: 'rotate', corner: 0 };
    return null;
  }

  function drawImages(ctx: CanvasRenderingContext2D, list: TabletImage[]): void {
    for (const im of list) {
      const el = imgEl(im.src);
      if (!el) continue;
      ctx.save();
      ctx.translate(im.x, im.y);
      ctx.rotate(im.rot);
      ctx.drawImage(el, -im.w / 2, -im.h / 2, im.w, im.h);
      ctx.restore();
    }
  }

  /** Selection frame and grips, screen-sized so they do not scale with the zoom. */
  function drawSelection(ctx: CanvasRenderingContext2D, S: number): void {
    const im = imageById(selectedImg);
    if (!im) return;
    const px = 1 / S;
    const r = (HANDLE_PX / S) * 0.7;
    const gold = cssVar('--gold', '#c39a27');
    ctx.save();
    ctx.strokeStyle = gold;
    ctx.lineWidth = 1.5 * px;
    const c = imgCorners(im);
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.stroke();
    // Stalk out to the turn grip, so it reads as belonging to this picture.
    const arm = ROTATE_ARM_PX / S;
    const up = { x: Math.sin(im.rot), y: -Math.cos(im.rot) };
    const hx = im.x + up.x * (im.h / 2 + arm);
    const hy = im.y + up.y * (im.h / 2 + arm);
    const topMid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = settings.canvas.backgroundColor;
    for (const p of [...c, { x: hx, y: hy }]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function selectImage(id: number): void {
    if (selectedImg === id) return;
    selectedImg = id;
    state.hasSelection = id !== 0;
    scheduleRender();
  }

  /**
   * Drop a picture on the surface, sized to sit comfortably in the current view and
   * centred on it, then select it and switch to the move tool so it can be placed
   * straight away. Pasting used to leave the editor entirely and make a new note.
   */
  function addImage(dataUrl: string): void {
    const el = new Image();
    el.onload = () => {
      const c = canvasRef.value;
      const S = c ? scale(c) : 1;
      const viewW = c ? c.width / S : pageW();
      const viewH = c ? c.height / S : PAGE_H;
      // Two thirds of the shorter view dimension: big enough to see, small enough
      // to leave somewhere to write.
      const k = Math.min((viewW * 0.66) / el.width, (viewH * 0.66) / el.height, 1);
      const im: TabletImage = {
        id: nextId++,
        src: dataUrl,
        x: view.cx,
        y: view.cy,
        w: Math.max(8, el.width * k),
        h: Math.max(8, el.height * k),
        rot: 0,
      };
      imgEls.set(dataUrl, el);
      images.push(im);
      pushOp({ kind: 'imgAdd', img: { ...im } });
      bump();
      selectImage(im.id);
      state.tool = 'select';
      scheduleRender();
    };
    el.src = dataUrl;
  }

  function deleteSelectedImage(): void {
    const im = imageById(selectedImg);
    if (!im) return;
    images.splice(images.indexOf(im), 1);
    pushOp({ kind: 'imgDel', img: { ...im } });
    selectImage(0);
    bump();
    scheduleRender();
  }

  function toggleSelect(): void {
    state.tool = state.tool === 'select' ? 'pen' : 'select';
    if (state.tool !== 'select') selectImage(0);
  }

  function getImages(): TabletImage[] {
    return JSON.parse(JSON.stringify(images)) as TabletImage[];
  }

  function setImages(list: TabletImage[]): void {
    images.length = 0;
    selectedImg = 0;
    state.hasSelection = false;
    for (const im of list) {
      if (!im?.src || !Number.isFinite(im.w) || !Number.isFinite(im.h)) continue;
      images.push({ ...im, rot: Number.isFinite(im.rot) ? im.rot : 0 });
      if (im.id >= nextId) nextId = im.id + 1;
    }
    state.hasImages = images.length > 0;
    scheduleRender();
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
    // A board holding only a pasted screenshot is still worth saving.
    state.hasImages = images.length > 0;
    if (selectedImg && !imageById(selectedImg)) selectImage(0);
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
      ctx.lineWidth = bucketWidth(widthFor(s, next.p));
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

  /** Put a picture back where it was, or take it away again. */
  function restoreImage(img: TabletImage): void {
    if (!imageById(img.id)) images.push({ ...img });
    images.sort((a, b) => a.id - b.id); // ids are monotonic, so z-order is restored
  }

  function dropImage(id: number): void {
    const i = images.findIndex((x) => x.id === id);
    if (i >= 0) images.splice(i, 1);
    if (selectedImg === id) selectImage(0);
  }

  function applyImage(to: TabletImage): void {
    const im = imageById(to.id);
    if (im) Object.assign(im, to);
  }

  function undo(): void {
    const op = undoStack.pop();
    if (!op) return;
    if (op.kind === 'add') removeById(op.stroke.id);
    else if (op.kind === 'erase') reinsert(op.strokes);
    else if (op.kind === 'imgAdd') dropImage(op.img.id);
    else if (op.kind === 'imgDel') restoreImage(op.img);
    else applyImage(op.before);
    redoStack.push(op);
    bump();
    scheduleRender();
  }

  function redo(): void {
    const op = redoStack.pop();
    if (!op) return;
    if (op.kind === 'add') reinsert([op.stroke]);
    else if (op.kind === 'erase') for (const s of op.strokes) removeById(s.id);
    else if (op.kind === 'imgAdd') restoreImage(op.img);
    else if (op.kind === 'imgDel') dropImage(op.img.id);
    else applyImage(op.after);
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

  // Keep the undo button pressed and strokes peel off one after another, faster the
  // longer it is held (holdRepeat owns the curve); a single click still removes
  // exactly one. Stops on release (up, cancel, or a move that shows the button no
  // longer down) and when the undo stack runs dry.
  //
  // The timer only asks "is one due yet"; it does not set the pace itself, so it ticks
  // well under the shortest gap the ramp can reach. Pacing it by the interval instead
  // would quantise the acceleration to the timer's own resolution.
  const HOLD_TICK_MS = 10;
  let holdUndo: { pointerId: number; timer: number; started: number; last: number } | null = null;

  function stopHoldUndo(): void {
    if (!holdUndo) return;
    window.clearInterval(holdUndo.timer);
    holdUndo = null;
  }

  function startHoldUndo(pointerId: number): void {
    stopHoldUndo();
    const state = { pointerId, timer: 0, started: performance.now(), last: 0 };
    state.timer = window.setInterval(() => {
      const now = performance.now();
      if (!holdDue(state.started, state.last, now)) return;
      if (undoStack.length === 0) {
        stopHoldUndo();
        return;
      }
      state.last = now;
      undo();
    }, HOLD_TICK_MS);
    holdUndo = state;
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
    // The move tool: pictures are picked up rather than written on. A grip of the
    // picture already selected wins over the picture under the pointer, so a corner
    // that overhangs a neighbour still resizes what you meant.
    if (state.tool === 'select' && e.button === 0) {
      const pt = toPage(c, e.clientX, e.clientY);
      const sel = imageById(selectedImg);
      const grip = sel ? gripAt(sel, pt.x, pt.y, scale(c)) : null;
      if (sel && grip) {
        imgDrag = {
          pointerId: e.pointerId,
          mode: grip.mode,
          corner: grip.corner,
          startX: pt.x,
          startY: pt.y,
          before: { ...sel },
        };
        return;
      }
      const hit = imageAt(pt.x, pt.y);
      selectImage(hit ? hit.id : 0);
      if (hit) {
        imgDrag = {
          pointerId: e.pointerId,
          mode: 'move',
          corner: 0,
          startX: pt.x,
          startY: pt.y,
          before: { ...hit },
        };
      }
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
    if (imgDrag && e.pointerId === imgDrag.pointerId) {
      const b = imgDrag.before;
      const im = imageById(b.id);
      if (!im) return;
      const pt = toPage(c, e.clientX, e.clientY);
      if (imgDrag.mode === 'move') {
        im.x = b.x + (pt.x - imgDrag.startX);
        im.y = b.y + (pt.y - imgDrag.startY);
      } else if (imgDrag.mode === 'rotate') {
        const from = Math.atan2(imgDrag.startY - b.y, imgDrag.startX - b.x);
        const to = Math.atan2(pt.y - b.y, pt.x - b.x);
        const step = Math.PI / 12; // hold shift for 15 degree stops
        const rot = b.rot + (to - from);
        im.rot = e.shiftKey ? Math.round(rot / step) * step : rot;
      } else {
        // Resize from the corner opposite the one being dragged, which stays put.
        // Aspect is locked: a screenshot squashed out of proportion is a ruined one.
        const anchor = imgCorners(b)[(imgDrag.corner + 2) % 4];
        const la = toLocal(b, anchor.x, anchor.y);
        const lp = toLocal(b, pt.x, pt.y);
        const k = Math.max(
          Math.abs(lp.x - la.x) / Math.max(1e-6, b.w),
          Math.abs(lp.y - la.y) / Math.max(1e-6, b.h),
        );
        const w = Math.max(12, b.w * k);
        const h = Math.max(12, b.h * k);
        const signX = imgDrag.corner === 0 || imgDrag.corner === 3 ? -1 : 1;
        const signY = imgDrag.corner === 0 || imgDrag.corner === 1 ? -1 : 1;
        const cx = (signX * w) / 2;
        const cy = (signY * h) / 2;
        const cos = Math.cos(b.rot);
        const sin = Math.sin(b.rot);
        im.w = w;
        im.h = h;
        im.x = anchor.x + cx * cos - cy * sin;
        im.y = anchor.y + cx * sin + cy * cos;
      }
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

  /** One undo step per gesture, and nothing recorded for a drag that moved nothing. */
  function endImgDrag(): void {
    if (!imgDrag) return;
    const b = imgDrag.before;
    const im = imageById(b.id);
    imgDrag = null;
    if (!im) return;
    if (im.x === b.x && im.y === b.y && im.w === b.w && im.h === b.h && im.rot === b.rot) return;
    pushOp({ kind: 'imgXform', id: im.id, before: b, after: { ...im } });
    bump();
  }

  function onPointerUp(e: PointerEvent): void {
    const c = canvasRef.value;
    if (holdUndo && e.pointerId === holdUndo.pointerId) stopHoldUndo();
    if (imgDrag && e.pointerId === imgDrag.pointerId) {
      endImgDrag();
      return;
    }
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
    if (imgDrag && e.pointerId === imgDrag.pointerId) endImgDrag();
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
    images.length = 0;
    imgDrag = null;
    selectedImg = 0;
    state.hasSelection = false;
    state.hasImages = false;
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
    const pics = images.slice();
    if (main.length === 0 && !bg && pics.length === 0) return '';
    const ink = strokeBounds(main);
    let minX = ink ? ink.minX : Infinity;
    let minY = ink ? ink.minY : Infinity;
    let maxX = ink ? ink.maxX : -Infinity;
    let maxY = ink ? ink.maxY : -Infinity;
    // A pasted screenshot is part of the note, so the transcriber must be shown it
    // and the crop must reach around it.
    for (const im of pics) {
      for (const p of imgCorners(im)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
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
    // line is not blown up into billboard glyphs (fewer pixels, fewer tokens). One
    // rule for both surface shapes: a board that outgrows the cap is transcribed as
    // several per-region images (exportInkTiles), so this image never has to carry a
    // whole sprawling board's legibility on its own.
    const k = Math.min(settings.export.maxEdgePx / Math.max(w, h), 1.6);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * k));
    out.height = Math.max(1, Math.round(h * k));
    lastExport = { w: out.width, h: out.height };
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = settings.canvas.backgroundColor;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    if (bg && backdrop) ctx.drawImage(backdrop, bg.x, bg.y, bg.w, bg.h);
    drawImages(ctx, pics);
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
      // Pictures on the surface. "images: 0" right after a paste means the paste
      // never reached addImage; a count with a selected id means it landed and the
      // problem is somewhere in drawing or in the view.
      images: images.length,
      selectedImage: selectedImg,
      pictures: images.map((im) => ({
        id: im.id,
        x: Math.round(im.x),
        y: Math.round(im.y),
        w: Math.round(im.w),
        h: Math.round(im.h),
        deg: Math.round((im.rot * 180) / Math.PI),
        loaded: Boolean(imgEls.get(im.src)?.complete),
      })),
      bbox: contentBox(),
      view: { z: view.z, cx: Math.round(view.cx), cy: Math.round(view.cy) },
      exportBytes: exportImage().length,
      exportPx: lastExport,
      // How the transcriber would be shown this surface: one region per image, in
      // reading order. Answers "why did my note come back garbled" without a network
      // call, since a board cut into more tiles than expected, or into one tile that
      // is plainly too big, is visible right here.
      tiles: planInkTiles(strokes, 'all').map((b) => ({
        x: Math.round(b.minX),
        y: Math.round(b.minY),
        w: Math.round(b.maxX - b.minX),
        h: Math.round(b.maxY - b.minY),
        pen: Number((tileScale(b.maxX - b.minX, b.maxY - b.minY) * baseWidth()).toFixed(2)),
      })),
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
    // Pictures on the surface
    addImage,
    deleteSelectedImage,
    toggleSelect,
    getImages,
    setImages,
  };
}
