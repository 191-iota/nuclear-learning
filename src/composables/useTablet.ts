import { onBeforeUnmount, reactive, watch, type Ref } from 'vue';
import { settings } from '@/stores/settings';
import {
  PAGE_H,
  backdropBox,
  baseWidth,
  bucketWidth,
  drawStrokes,
  imageCorners as imgCorners,
  inkAnchor,
  drawImages as paintImages,
  pageWidth as pageW,
  planInkTiles,
  renderBoard,
  tileScale,
  widthFor,
  type TabletImage,
  type TabletPoint,
  type TabletStroke,
  type TabletWidget,
  type TabletZone,
} from '@/composables/inkExport';

// The stroke model and the paint loop live in inkExport, which the notes store also
// draws with. Re-exported here so the engine stays the one import a view needs.
export type { TabletImage, TabletPoint, TabletStroke, TabletWidget, TabletZone };

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
 *   serifs are not cut off. What is drawn is a curve rather than the chain of
 *   straight segments the samples arrive as (inkExport owns that), and the live pen
 *   lays down exactly the same curve, so nothing changes shape when the pen lifts.
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

type Op =
  | { kind: 'add'; stroke: TabletStroke }
  | { kind: 'erase'; strokes: TabletStroke[] }
  | { kind: 'imgAdd'; img: TabletImage }
  | { kind: 'imgDel'; img: TabletImage }
  | { kind: 'imgXform'; id: number; before: TabletImage; after: TabletImage };

export interface TabletState {
  // hand = drag the surface. Pictures have no tool of their own: they are picked up
  // with the pen (see the pointer handlers).
  tool: 'pen' | 'eraser' | 'hand';
  zoomPct: number;
  canUndo: boolean;
  canRedo: boolean;
  hasInk: boolean; // main-zone ink (what grading gates on)
  hasImages: boolean; // at least one picture placed on the surface
  hasSelection: boolean; // a picture is picked up, so Delete has a target
  lockedImages: number; // pictures pinned to the surface, so the dock can offer them back
  hasWidgets: boolean; // at least one widget placed on the surface
  // Bumped on every redraw. The widget layer is elements above the canvas rather than
  // paint on it, so it has to re-place itself whenever the view moves, and this is
  // what a pan or a zoom tells it with.
  viewRev: number;
  // Monotonic revision of everything on the surface. Reactive on purpose: it is what
  // the notes editor autosaves against, so a stroke, an erase, an undo or a picture
  // being moved all read as "there is something new to write to disk".
  rev: number;
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
    lockedImages: 0,
    hasWidgets: false,
    viewRev: 0,
    rev: 0,
  });

  // View: zoom factor over the fit scale, plus the page point at the viewport centre.
  const view = { z: 1, cx: 0, cy: 0 };
  let viewInit = false;

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

  /**
   * What is actually ON the board: ink, pictures, and the backdrop, and nothing else.
   * Null when the board is empty.
   *
   * Fitting to this rather than to the box below is what makes reopening a note land
   * on the note. A board is unbounded, so a page written a few screens down from the
   * origin is a perfectly ordinary thing to have; framing it TOGETHER with the empty
   * home sheet put the writing in a corner of a mostly blank screen, zoomed out by
   * however far from the origin it happened to be.
   */
  function drawnBox(): Box | null {
    let b: Box | null = null;
    const grow = (x: number, y: number) => {
      if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        if (x < b.minX) b.minX = x;
        if (y < b.minY) b.minY = y;
        if (x > b.maxX) b.maxX = x;
        if (y > b.maxY) b.maxY = y;
      }
    };
    for (const s of strokes) {
      grow(s.minX, s.minY);
      grow(s.maxX, s.maxY);
    }
    // A picture counts as content, so Fit frames it and the board can be panned
    // around one even before a single stroke is written near it.
    for (const im of images) for (const p of imgCorners(im)) grow(p.x, p.y);
    // A widget counts as content for the same reason a picture does.
    for (const wd of widgets) {
      grow(wd.x - wd.w / 2, wd.y - wd.h / 2);
      grow(wd.x + wd.w / 2, wd.y + wd.h / 2);
    }
    if (backdropRect) {
      grow(backdropRect.x, backdropRect.y);
      grow(backdropRect.x + backdropRect.w, backdropRect.y + backdropRect.h);
    }
    return b;
  }

  // Everything above, unioned with one nominal page at the origin. This is the box
  // panning is bounded by, so the starting area always stays reachable however far
  // out the writing has gone.
  function contentBox(): Box {
    const b: Box = { minX: 0, minY: 0, maxX: pageW(), maxY: PAGE_H };
    const d = drawnBox();
    if (d) {
      b.minX = Math.min(b.minX, d.minX);
      b.minY = Math.min(b.minY, d.minY);
      b.maxX = Math.max(b.maxX, d.maxX);
      b.maxY = Math.max(b.maxY, d.maxY);
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
    state.viewRev += 1;
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
  // A press over the pictures, whose meaning the next move or the release settles.
  // `down` is the pointerdown itself, kept so a stroke that turns out to be a stroke
  // still starts where the pen actually landed.
  let pending: { pointerId: number; down: PointerEvent; pick: TabletImage | null } | null = null;
  let lastErase: { x: number; y: number } | null = null;
  let lastDown: { type: string; button: number; buttons: number } | null = null;
  // A short log of what the driver actually sent, readable via `__nlInk().recent` (or
  // `__nlTablet().recent`). Pen buttons behave differently on every driver and none of
  // it can be reasoned about from in here, so a gesture that misbehaves can be pressed
  // once and then read back exactly as the browser received it. Moves are only logged
  // while the barrel button is held, and only when they say something new, so an erase
  // pass does not flood the buffer with its own repetition.
  const recent: string[] = [];
  const TRACE_MAX = 40;
  let lastTrace = '';

  function trace(e: PointerEvent): void {
    const move = e.type === 'pointermove';
    if (move && !buttonErase) return;
    const sig = `${e.type.slice(7)} ${e.pointerType} b${e.button} B${e.buttons} ${e.pressure > 0 ? 'tip' : 'hover'}`;
    if (move && sig === lastTrace) return;
    lastTrace = sig;
    recent.push(`${sig} → ${state.tool}${erasing ? ' erasing' : ''}`);
    if (recent.length > TRACE_MAX) recent.shift();
  }
  // A backdrop layer under the strokes: a note saved before stroke persistence
  // reopens with its image here, so it can be continued instead of staying a dead
  // snapshot. Included in exports, never erasable, never part of undo.
  let backdrop: HTMLImageElement | null = null;
  let backdropRect: { x: number; y: number; w: number; h: number } | null = null;

  /**
   * Resolves once the picture has been decoded and placed, so a caller that is about
   * to fit the view can wait for the layer that decides how big the board is. Before
   * it resolved, a note whose only content is its backdrop was fitted against an
   * empty board.
   */
  function setBackdrop(dataUrl: string | null): Promise<void> {
    if (!dataUrl) {
      backdrop = null;
      backdropRect = null;
      scheduleRender();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        backdrop = img;
        backdropRect = backdropBox(img);
        scheduleRender();
        resolve();
      };
      // A backdrop that will not decode is a missing layer, never a stuck caller.
      img.onerror = () => resolve();
      img.src = dataUrl;
    });
  }

  // ---- pictures on the surface ----
  //
  // A screenshot pasted into a note is an OBJECT, not a backdrop: it can be picked
  // up, resized, turned and thrown away, and ink goes over the top of it. The
  // backdrop above stays what it always was, a fixed under-layer for notes saved
  // before strokes were persisted; this is the layer you can actually work with.
  //
  // They have no tool of their own. Reaching for a "Pictures" mode to nudge a
  // screenshot, and remembering to leave it again before writing the next line, is
  // more bookkeeping than the job is worth: the pen taps a picture to pick it up and
  // taps off it to put it down (see onPointerDown). Neither tap leaves ink.
  //
  // Geometry is centre plus half-extent plus an angle, because that is what makes
  // rotation and corner-resize simple: every hit test moves the pointer into the
  // picture's own unrotated frame and asks a rectangle question there.

  const images: TabletImage[] = [];
  const imgEls = new Map<string, HTMLImageElement>();

  // Widgets are the other kind of object on the surface, and the engine holds them for
  // the same reasons it holds pictures: Fit has to frame them, the export has to reach
  // around them, and one save writes everything on the board at once. What it does NOT
  // do is draw them. A widget is elements above the canvas (see WidgetLayer), because
  // it has fields you type into, and the engine only owns where it sits.
  const widgets: TabletWidget[] = [];
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
  // How far a press may travel and still count as a tap rather than the start of a
  // stroke. On screen, because it is a property of the hand, not of the zoom.
  const TAP_PX = 4;

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

  /**
   * Topmost picture under the pointer; later ones are drawn on top, so search back.
   * A locked one is invisible to this, which is the whole of what locking does: the
   * press over it is never a tap on a picture, so it becomes ink without the wait
   * that deciding between the two costs.
   */
  function imageAt(x: number, y: number): TabletImage | null {
    for (let i = images.length - 1; i >= 0; i -= 1) {
      if (!images[i].locked && pointInImage(images[i], x, y)) return images[i];
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

  /** The shared painter, fed from this surface's own decode cache. */
  function drawImages(ctx: CanvasRenderingContext2D, list: TabletImage[]): void {
    paintImages(ctx, list, imgEl);
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
   * centred on it, then select it so it can be dragged into place straight away. The
   * pen stays the pen: placing the picture is a drag, and the next tap off it is
   * already writing again. Pasting used to leave the editor entirely and make a new
   * note out of the screenshot.
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
        // Written out rather than left off, so an undo of a lock has a false to
        // restore instead of a missing key that Object.assign would skip.
        locked: false,
      };
      imgEls.set(dataUrl, el);
      images.push(im);
      pushOp({ kind: 'imgAdd', img: { ...im } });
      bump();
      selectImage(im.id);
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

  /** Put the held picture down. Esc reaches for this before it closes anything. */
  function clearSelection(): void {
    selectImage(0);
  }

  /**
   * Pin the held picture to the surface and let go of it. From here the pen writes
   * over it as if it were paper: no frame, no grips, and no press near its edge that
   * turns out to have moved it instead of drawing.
   *
   * Recorded as an ordinary transform, so undo takes the lock back off.
   */
  function lockSelectedImage(): void {
    const im = imageById(selectedImg);
    if (!im || im.locked) return;
    const before = { ...im };
    im.locked = true;
    pushOp({ kind: 'imgXform', id: im.id, before, after: { ...im } });
    selectImage(0);
    bump();
    scheduleRender();
  }

  /**
   * Hand every pinned picture back. A locked picture cannot be tapped by definition,
   * so the way out cannot be on the picture itself; it is one dock button that names
   * how many it is about to release.
   */
  function unlockImages(): void {
    const locked = images.filter((im) => im.locked);
    if (!locked.length) return;
    for (const im of locked) {
      const before = { ...im };
      im.locked = false;
      pushOp({ kind: 'imgXform', id: im.id, before, after: { ...im } });
    }
    bump();
    scheduleRender();
  }

  function getImages(): TabletImage[] {
    return JSON.parse(JSON.stringify(images)) as TabletImage[];
  }

  // ---- widgets on the surface ----

  function getWidgets(): TabletWidget[] {
    return JSON.parse(JSON.stringify(widgets)) as TabletWidget[];
  }

  function setWidgets(list: TabletWidget[]): void {
    widgets.length = 0;
    for (const w of list) {
      widgets.push({ ...w });
      // Ids are handed out from one counter for every object on the surface, so a
      // reopened note must not start issuing ids it is already using.
      if (w.id >= nextId) nextId = w.id + 1;
    }
    bump();
    scheduleRender();
  }

  /**
   * Put a widget on the surface, placed the way a pasted picture is: a comfortable
   * fraction of the view, centred on it, so it lands where you are looking and leaves
   * board to write on around it.
   */
  function addWidget(src: string): TabletWidget {
    const c = canvasRef.value;
    const S = c ? scale(c) : 1;
    const viewW = c ? c.width / S : pageW();
    const viewH = c ? c.height / S : PAGE_H;
    const wd: TabletWidget = {
      id: nextId++,
      src,
      x: view.cx,
      y: view.cy,
      w: Math.round(Math.max(240, Math.min(viewW * 0.5, 620))),
      h: Math.round(Math.max(180, Math.min(viewH * 0.5, 460))),
      data: {},
    };
    widgets.push(wd);
    bump();
    scheduleRender();
    return wd;
  }

  function updateWidget(id: number, patch: Partial<TabletWidget>): void {
    const wd = widgets.find((x) => x.id === id);
    if (!wd) return;
    Object.assign(wd, patch);
    bump();
    scheduleRender();
  }

  function removeWidget(id: number): void {
    const i = widgets.findIndex((x) => x.id === id);
    if (i < 0) return;
    widgets.splice(i, 1);
    bump();
    scheduleRender();
  }

  /**
   * Where a page point lands on screen, in the CSS pixels the DOM measures in. The
   * widget layer is elements over the canvas rather than paint on it, so it places
   * itself with the same transform the renderer draws with. The canvas backing store
   * is in device pixels and its box is not, hence the ratio.
   */
  function clientTransform(): { k: number; ox: number; oy: number } | null {
    const c = canvasRef.value;
    if (!c || !c.width) return null;
    const rect = c.getBoundingClientRect();
    const ratio = rect.width / c.width;
    const { ox, oy } = offsets(c);
    return { k: scale(c) * ratio, ox: ox * ratio, oy: oy * ratio };
  }

  function setImages(list: TabletImage[]): void {
    images.length = 0;
    selectedImg = 0;
    state.hasSelection = false;
    for (const im of list) {
      if (!im?.src || !Number.isFinite(im.w) || !Number.isFinite(im.h)) continue;
      images.push({ ...im, rot: Number.isFinite(im.rot) ? im.rot : 0, locked: Boolean(im.locked) });
      if (im.id >= nextId) nextId = im.id + 1;
    }
    state.hasImages = images.length > 0;
    state.lockedImages = images.filter((im) => im.locked).length;
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
    state.rev = rev;
    state.canUndo = undoStack.length > 0;
    state.canRedo = redoStack.length > 0;
    state.hasInk = strokes.some((s) => s.zone === 'main');
    // A board holding only a pasted screenshot is still worth saving.
    state.hasImages = images.length > 0;
    state.hasWidgets = widgets.length > 0;
    state.lockedImages = images.filter((im) => im.locked).length;
    if (selectedImg && !imageById(selectedImg)) selectImage(0);
    // Undo can put a lock back on the picture currently held; the frame around it
    // would then offer grips that no longer do anything.
    if (selectedImg && imageById(selectedImg)?.locked) selectImage(0);
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
    // Incremental draw of just the fresh piece keeps the pen latency at one frame.
    // It lays down the SAME curve the finished stroke is drawn with (inkAnchor), so
    // the ink never re-shapes itself the moment the pen lifts. The piece drawn is the
    // one that has settled: the curve through the point before last. The half segment
    // still open at the tip is a fraction of a millimetre of writing behind the nib,
    // and drawing it straight would leave a whisker sticking out of every corner
    // until the redraw.
    const ctx = context();
    if (ctx) {
      const S = scale(c);
      const { ox, oy } = offsets(c);
      ctx.setTransform(S, 0, 0, S, ox, oy);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = settings.canvas.strokeColor;
      ctx.lineWidth = bucketWidth(widthFor(s, next.p));
      const n = s.pts.length;
      ctx.beginPath();
      if (n >= 3) {
        const from = inkAnchor(s.pts, n - 3);
        const to = inkAnchor(s.pts, n - 2);
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(s.pts[n - 2].x, s.pts[n - 2].y, to.x, to.y);
      } else {
        // Two points are still a straight line in the finished stroke too.
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(next.x, next.y);
      }
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

  // A fit asked for while the canvas has no size yet, kept until it has one. The
  // notes editor fills a board (strokes, pictures, backdrop) before the canvas is
  // mounted, so the fit that followed had nothing to measure and quietly fell through
  // to the home page. A note written far out on the board then opened a screen or two
  // away from its own writing, with nothing on screen to say which way to scroll.
  let wantFit = false;

  // Page: back to the whole sheet at 100%. Board: fit everything written, which is
  // the only way to find ink you panned away from — and it never zooms IN past 100%,
  // so a nearly empty board does not blow two words up to fill the screen.
  function resetView(): void {
    const c = canvasRef.value;
    if (options.board && (!c || c.width < 2 || c.height < 2)) {
      wantFit = true; // resize() runs it the moment there is something to measure
      return;
    }
    wantFit = false;
    // Whatever is computed here IS the opening view, so say so. ensureView only ever
    // runs from a redraw that has a canvas, and until this board had one it had never
    // run at all: the fit below landed correctly and the first frame after it then
    // replaced it with the home page, which is the y offset a reopened note showed.
    ensureView();
    if (options.board && c) {
      // The writing itself, and the home page only when there is no writing. Zoom is
      // still capped at 100%, which is what keeps two words from filling the screen.
      const b = drawnBox() ?? contentBox();
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

  // ---- the pen's lower barrel button: hold it to erase ----

  // The button is a held modifier, not a command: press it and the pen is the eraser,
  // let go and it is whatever it was before. That is the one thing a pen button is
  // for on every other writing surface, and it is the gesture that removes a symbol
  // without a hand leaving the tablet to reach for a key.
  //
  // It used to fire undo (and repeat while held). Undo keeps the keyboard, its own
  // hold ramp there, and the tooldock button; erasing had neither.
  //
  // Accepted from any pointer type, because the driver may report the pen as a mouse,
  // and the canvas suppresses the context menu anyway.
  //
  // Drivers disagree about everything else, so nothing here trusts a single signal:
  //
  // - The press may arrive while the pen hovers (button 2), or only once the tip lands
  //   with the button already down (buttons bit 2). Either latches the eraser.
  // - The tip landing while the button is held may be reported as a fresh pointerdown,
  //   or as nothing at all: a barrel button mapped to right-click makes the whole thing
  //   ONE right-button drag, where the contact only ever shows up in pointermove. So
  //   movement with the tip down starts the erasing even when no pointerdown came.
  // - `buttons` may not carry bit 1 on that contact (a right-drag is reported as
  //   button 2 alone), so contact is read from the tip pressure as well.
  // - `buttons` may not carry bit 2 after the press either. Taking that silence for a
  //   release would drop the eraser on the first move, so the bit is only believed as
  //   a release signal once the driver has been seen reporting it at all.
  let buttonErase: { pointerId: number; tool: TabletState['tool']; sawBit: boolean } | null = null;

  /** Is the tip actually on the tablet? Pens report their pressure, and a mouse
   *  reports 0.5 whenever a button is down, which is the same question for a mouse. */
  function inContact(e: PointerEvent): boolean {
    return (e.buttons & 1) !== 0 || e.pressure > 0;
  }

  function startButtonErase(e: PointerEvent): void {
    if (buttonErase) return;
    // sawBit starts false however this press was reported: the question it answers is
    // whether the driver keeps mentioning the button AFTER the press, and the press
    // itself is no evidence of that.
    buttonErase = { pointerId: e.pointerId, tool: state.tool, sawBit: false };
    state.tool = 'eraser';
  }

  /** Give the pen back whatever it was holding before the button went down. */
  function endButtonErase(): void {
    if (!buttonErase) return;
    state.tool = buttonErase.tool;
    buttonErase = null;
  }

  // A button released between two events (the pen left the tablet, the window lost
  // focus, a driver that skips the up) would otherwise leave the pen stuck erasing.
  function checkButtonRelease(e: PointerEvent): void {
    if (!buttonErase || e.pointerId !== buttonErase.pointerId) return;
    if ((e.buttons & 2) !== 0) {
      buttonErase.sawBit = true;
      return;
    }
    // Mid-gesture silence about the button is only a release from a driver that talks
    // about it. From any other, the button's OWN pointerup is the release, and the
    // tip's is not: lifting the pen between two rubs must not drop the eraser.
    if (!buttonErase.sawBit && !(e.type === 'pointerup' && e.button === 2)) return;
    endButtonErase();
    if (erasing && erasing.pointerId === e.pointerId) endErase();
  }

  // ---- event handlers ----

  function onPointerDown(e: PointerEvent): void {
    const c = canvasRef.value;
    if (!c) return;
    trace(e);
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
    // The barrel button, down: the pen becomes the eraser until it is let go.
    if (e.button === 2 || (e.buttons & 2) !== 0) {
      // A stroke under the pen is finished first. The button changes the tool in the
      // middle of a gesture, and half a letter must not be carried into the eraser.
      if (active && e.pointerId === active.pointerId) endStroke();
      pending = null;
      startButtonErase(e);
      // Usually the press arrives while the pen hovers, and there is nothing to lift
      // until the tip is down. Fall through only when it already is, which is a
      // question about contact rather than about which bits the driver sets.
      if (!inContact(e)) return;
    }
    if (isEraserPointer(e) || state.tool === 'eraser') {
      erasing = { pointerId: e.pointerId, removed: [] };
      const pt = toPage(c, e.clientX, e.clientY);
      eraseAt(pt.x, pt.y);
      options.onInk?.();
      return;
    }
    if (e.button !== 0) return;
    // The pen, over pictures. A picture that is already held owns the pointer: its
    // grips resize and turn it, its body drags it. A grip wins over the picture under
    // the pointer, so a corner that overhangs a neighbour still resizes what you meant.
    const pt = toPage(c, e.clientX, e.clientY);
    const sel = imageById(selectedImg);
    if (sel && !sel.locked) {
      const grip = gripAt(sel, pt.x, pt.y, scale(c));
      if (grip || pointInImage(sel, pt.x, pt.y)) {
        imgDrag = {
          pointerId: e.pointerId,
          mode: grip ? grip.mode : 'move',
          corner: grip ? grip.corner : 0,
          startX: pt.x,
          startY: pt.y,
          before: { ...sel },
        };
        return;
      }
    }
    // Anywhere a picture is involved, the press has two possible meanings and the
    // pointer decides which: travel from here and it was a stroke (written over the
    // picture, which is the point of ink sitting on top of them), lift without
    // travelling and it was a tap that picks a picture up or puts one down. So a tap
    // to select never leaves a dot behind, and a tap to deselect never starts a new
    // note off with a speck of ink.
    const hit = imageAt(pt.x, pt.y);
    if (sel || hit) {
      pending = { pointerId: e.pointerId, down: e, pick: hit };
      return;
    }
    // The ordinary case, with no picture anywhere near: writing starts on contact.
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
    trace(e);
    // A hovering pen streams moves, so this catches a barrel button let go off the
    // surface, or one whose pointerup never arrived.
    checkButtonRelease(e);
    // With the button held, the tip touching down is what starts the erasing, whether
    // or not the driver announced it with a pointerdown. A barrel button mapped to
    // right-click reports the whole gesture as one drag, so the contact arrives here
    // and nowhere else; without this the eraser looked switched on and rubbed nothing
    // out. Lifting the tip closes the erase, so each pass is its own undo step.
    if (buttonErase && e.pointerId === buttonErase.pointerId && !panning && !active && !imgDrag) {
      if (inContact(e) && !erasing) erasing = { pointerId: e.pointerId, removed: [] };
      else if (!inContact(e) && erasing && erasing.pointerId === e.pointerId) endErase();
    }
    if (pending && e.pointerId === pending.pointerId) {
      const dx = e.clientX - pending.down.clientX;
      const dy = e.clientY - pending.down.clientY;
      if (dx * dx + dy * dy < TAP_PX * TAP_PX) return; // still could be a tap
      // Far enough to be writing. The stroke starts at the pointerdown, so the wait
      // costs nothing of the letter. Writing anywhere but on the held picture puts it
      // down, the same as tapping off it: the hand has moved on.
      const start = pending.down;
      pending = null;
      if (selectedImg) selectImage(0);
      beginStroke(c, start);
      appendPoint(c, e);
      return;
    }
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
    trace(e);
    // The barrel button's own release, or the tip's with the button already off it.
    // `buttons` here is the state AFTER this release, so letting the button go while
    // the tip stays down ends the erasing, and lifting the tip while the button stays
    // down keeps the eraser for the next touch.
    checkButtonRelease(e);
    // A press that never travelled: the tap picks up the picture under it, or puts
    // the held one down. No ink either way.
    if (pending && e.pointerId === pending.pointerId) {
      const pick = pending.pick;
      pending = null;
      selectImage(pick ? pick.id : 0);
      return;
    }
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
    trace(e);
    if (buttonErase && e.pointerId === buttonErase.pointerId) endButtonErase();
    if (pending && e.pointerId === pending.pointerId) pending = null;
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
    endButtonErase(); // nor a barrel button, which would leave the pen erasing
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
    endButtonErase();
    pending = null;
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
    // A fit that was asked for before this canvas existed happens here, now that the
    // board can actually be measured against it.
    if (wantFit) resetView();
    else redraw();
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
    widgets.length = 0;
    imgDrag = null;
    pending = null;
    selectedImg = 0;
    state.hasSelection = false;
    state.hasImages = false;
    state.hasWidgets = false;
    state.lockedImages = 0;
    endButtonErase();
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
  // (a note capture wants the whole page, side arithmetic included). The crop and the
  // paint live in inkExport, because a saved note is re-rendered from its strokes long
  // after this canvas is gone and the two pictures have to agree.
  function exportImage(zone: 'main' | 'all' = 'main'): string {
    const out = renderBoard({
      strokes,
      images,
      widgets,
      imageEl: imgEl,
      backdrop: backdrop && backdropRect ? { el: backdrop, ...backdropRect } : null,
      zone,
    });
    if (out.url) lastExport = { w: out.w, h: out.h };
    return out.url;
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
      // The last few pointer events as the driver sent them. Press the pen's button,
      // try the gesture that misbehaves, then read this back.
      recent: recent.slice(),
      erasing: Boolean(erasing),
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
        // A picture that will not respond to the pen is either locked or somewhere
        // other than where it looks; this says which.
        locked: Boolean(im.locked),
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
    clearSelection,
    lockSelectedImage,
    unlockImages,
    getImages,
    setImages,
    // Widgets on the surface
    addWidget,
    updateWidget,
    removeWidget,
    getWidgets,
    setWidgets,
    clientTransform,
  };
}
