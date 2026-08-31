import { settings } from '@/stores/settings';

/**
 * Ink as data: the stroke model, the paint loop, and the export that feeds the
 * transcriber. Split out of useTablet so the engine is not the only thing that can
 * draw a stroke. The notes store re-renders a saved note's ink long after its canvas
 * is gone, and cloning the paint loop there would have let the two drift until an
 * exported note stopped looking like the note the learner wrote.
 *
 * The export half exists because a board has no size. A page could always be sent to
 * the transcriber as one image, since one page is one screenful of writing; a board
 * grows until its long edge no longer fits an image budget, and scaling it to fit
 * renders a 1.2-unit pen thinner than a pixel. Past that point the picture is a grey
 * smear and the transcription is guesswork.
 *
 * So a board is not sent as one picture of everything. exportInkTiles() cuts it into
 * the regions a reader would recognise as separate (ink that sits together belongs
 * together, ink separated by a hand's width of empty board does not), and sends each
 * region as its own image at full pen weight. Empty board between regions costs
 * nothing, because it is never in any tile. A region too big to render at 1:1 is cut
 * further into overlapping cells, the overlap being what keeps a glyph that straddles
 * a seam whole in at least one of them.
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
  /**
   * Pinned to the surface: the pen goes straight through it, so it can neither be
   * picked up nor nudged and every press over it is writing. A picture you are
   * taking notes ON is a background, and a background that moves when the pen
   * clips its edge has ruined the page under it.
   */
  locked?: boolean;
}

/**
 * A widget placed on the surface: the same kind of object a picture is, holding a
 * component instead of pixels. Centre, size and its own saved state, in page units,
 * so it round-trips through one blob with the rest of the note.
 *
 * It is the one board object that is not painted onto the canvas. A picture is
 * pixels and can be drawn; a widget has fields you type into and sliders you drag,
 * so it lives as real elements above the ink, positioned by the same transform. What
 * ends up in the exported page image is its outline (see renderBoard), because the
 * transcriber has to know something stood there.
 */
export interface TabletWidget {
  id: number;
  src: string; // JSX
  x: number; // centre
  y: number;
  w: number;
  h: number;
  /** Whatever the component put in the `storage` it was handed. */
  data?: Record<string, unknown>;
}

/** Decoded pictures, by source. A redraw must never wait on a download. */
export type ImageResolver = (src: string) => HTMLImageElement | null;

/** The page is a fixed 1000 units tall; its width follows the tablet's aspect. */
export const PAGE_H = 1000;

export function pageWidth(): number {
  const a = Number(settings.tablet.aspect) || 1.6;
  return Math.round(PAGE_H * Math.min(2.4, Math.max(0.8, a)));
}

/** A rectangle in page units. The export crops to one of these. */
export interface InkBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface InkTile {
  image: string; // JPEG data URL
  box: InkBox; // the page-unit region it covers, for the probe and for debugging
}

// Hard ceiling on how far pressure can widen a stroke past its base width. Kept
// tight: a heavy hand should not turn the configured fine pen into a marker.
export const WIDTH_CAP = 1.2;
export const EXPORT_MARGIN = 30; // page units around the ink, keeps superscripts off the edge

// The vision model reads an image as 32-pixel patches and takes at most this many;
// anything larger it silently scales down before the model ever sees it. Sizing a
// tile to this budget instead of to a pixel width is what keeps our scaling decision
// the LAST one applied, rather than one the API quietly overrides.
const PATCH = 32;
const PATCH_BUDGET = 1536;
const BUDGET_PX = PATCH_BUDGET * PATCH * PATCH;
// Ceiling on upscaling a small tile: a three-word note blown up to fill the budget
// costs a full image's tokens to say very little.
const MAX_TILE_SCALE = 1.6;

// How much empty board separates two regions. Three grid cells at the default raster:
// wide enough that the lines of one paragraph stay together, tight enough that work
// parked in another corner of the board is recognised as its own thing.
const CLUSTER_GAP = 120;
// The width the pen has to keep in the finished image. Under a whole pixel a stroke
// is drawn as a partial-coverage grey and the transcriber starts guessing at letters.
const MIN_PEN_PX = 1;
// Ceiling on images per note. A note is one thing a learner wrote, so a request that
// wants dozens of pictures of it has stopped being a transcription. A board far past
// what this many budget-sized tiles can hold is scaled down inside its tiles like
// before, since at that size no bounded number of images keeps every stroke sharp.
const MAX_TILES = 12;
// Cells are grown slightly past their share so a glyph split by a seam survives whole
// in the neighbour.
const TILE_OVERLAP = 0.05;

// ---- rendering ----

// Pressure barely moves the line (mirrors the Neo engine): the resting width IS
// the configured width, a heavy hand adds at most WIDTH_CAP. Steeper curves kept
// reading as "thicker than the setting says" under real writing pressure.
export function widthFor(s: TabletStroke, p: number): number {
  return Math.min(s.w * WIDTH_CAP, Math.max(0.4, s.w * (0.85 + 0.3 * p)));
}

// Bucketed so consecutive segments of near-equal pressure batch into one path.
export function bucketWidth(w: number): number {
  return Math.round(w / 0.15) * 0.15;
}

/**
 * Where the drawn curve passes through after sample `i`: the midpoint of the segment
 * that follows it.
 *
 * A tablet hands over a chain of samples, and joining them with straight lines draws
 * exactly that chain, every sample a small corner, which is why handwriting came out
 * looking faceted and raw however finely it was sampled. Taking each sample as the
 * CONTROL point of a quadratic and the midpoints as the points the curve passes
 * through turns the chain into one continuous curve: the corners round off at the
 * scale of the sampling, which is the scale the hand never meant to draw at, and
 * every real turn of the pen survives because it spans many samples.
 *
 * The engine draws the live stroke with the same rule, so the ink under the pen and
 * the ink after the pen lifts are the same shape.
 */
export function inkAnchor(pts: TabletPoint[], i: number): { x: number; y: number } {
  const a = pts[i];
  const b = pts[i + 1];
  if (!b) return { x: a.x, y: a.y };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
  const last = pts.length - 1;
  let bw = -1;
  let open = false;
  for (let i = 1; i <= last; i += 1) {
    const w = bucketWidth(widthFor(s, pts[i].p));
    if (w !== bw) {
      // A width change starts its own path, picking up exactly where the last one
      // ended (the anchor), so the curve stays continuous across the seam.
      if (open) ctx.stroke();
      const from = i === 1 ? pts[0] : inkAnchor(pts, i - 1);
      ctx.beginPath();
      ctx.lineWidth = w;
      ctx.moveTo(from.x, from.y);
      open = true;
      bw = w;
    }
    // The tail runs to the real last sample: a stroke must end where the pen did,
    // or every full stop and serif would be trimmed by half a segment.
    if (i === last) ctx.lineTo(pts[i].x, pts[i].y);
    else {
      const to = inkAnchor(pts, i);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, to.x, to.y);
    }
  }
  if (open) ctx.stroke();
}

/**
 * The ink colour, and why the shipped one is not black.
 *
 * Reading speed is flat once contrast is well past threshold (Legge, Rubin and
 * Luebker, 1987), so every dark ink on white paper reads at the same speed and the
 * choice is settled by what happens on either side of that plateau.
 *
 * Below it is the part that decides it for mathematics. Fine detail is resolved by
 * the luminance channel; the chromatic channels stop resolving detail at a fraction
 * of the spatial frequency luminance still carries (Mullen, 1985). An exponent, a
 * prime, a minus and a fraction bar are the smallest marks on a page of algebra, and
 * ink that differs from the paper mostly in HUE hands exactly those marks to the
 * channel that cannot see them. That rules out a saturated pen of any colour,
 * however well it reads across a heading.
 *
 * Above the plateau is glare. Black on white is the largest luminance step a screen
 * can make, and stepping back from it is what the readability work agrees on for
 * long sessions (Rello and Baeza-Yates, 2012, measured shorter fixations on softer
 * pairs than on black and white).
 *
 * So: dark enough that nothing thin is at risk, one step back from the maximum, and
 * almost no chroma. #1f2a37 is L* 17, C* 10 at hue 266 degrees, and 14.5:1 against
 * white paper, twice the AAA floor of 7:1. The hue is the one part of this the
 * science leaves open. A slight blue is what ink has always been, it keeps
 * handwriting apart from the interface's warm near-black, and at C* 10 there is far
 * too little of it to fringe a 1.2-unit stroke.
 *
 * The quieter half of the argument: colour used to mark the matching parts of an
 * expression genuinely helps, and it only works while colour is rare on the page.
 * A near-neutral default keeps that channel free.
 *
 * Ink is applied when a stroke is DRAWN and no stroke carries a colour of its own,
 * so changing this repaints every note ever written, everywhere, at once. The one
 * thing that does not follow by itself is a picture of a note rendered before the
 * change; stores/inkColor.ts carries those across.
 */
export function drawStrokes(ctx: CanvasRenderingContext2D, list: TabletStroke[]): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = settings.canvas.strokeColor;
  ctx.fillStyle = settings.canvas.strokeColor;
  for (const s of list) drawStroke(ctx, s);
}

// ---- pictures on the surface ----

/** The four corners in page space, clockwise from top-left of the unrotated box. */
export function imageCorners(im: TabletImage): { x: number; y: number }[] {
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

export function drawImages(
  ctx: CanvasRenderingContext2D,
  list: TabletImage[],
  resolve: ImageResolver,
): void {
  for (const im of list) {
    const el = resolve(im.src);
    if (!el) continue;
    ctx.save();
    ctx.translate(im.x, im.y);
    ctx.rotate(im.rot);
    ctx.drawImage(el, -im.w / 2, -im.h / 2, im.w, im.h);
    ctx.restore();
  }
}

/**
 * What a widget leaves behind in an exported page: its outline and a word for what it
 * is. The live thing is elements rather than pixels, so it cannot be painted here,
 * and leaving nothing would hand the transcriber a hole in the middle of a page with
 * writing arranged around it. An outline says something stood here and how much room
 * it took, which is what the handwriting around it refers to.
 */
function drawWidgets(ctx: CanvasRenderingContext2D, list: TabletWidget[]): void {
  for (const wd of list) {
    const x = wd.x - wd.w / 2;
    const y = wd.y - wd.h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 120, 120, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(x, y, wd.w, wd.h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(120, 120, 120, 0.8)';
    const size = Math.max(11, Math.min(26, wd.h * 0.08));
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText('widget', x + size * 0.6, y + size * 0.5);
    ctx.restore();
  }
}

/**
 * Where a note saved before stroke persistence lands when its picture is laid under
 * the ink as a backdrop. The engine places it and the re-render has to agree with
 * the engine to the pixel, or a note would move the moment its picture was refreshed.
 */
export function backdropBox(img: { width: number; height: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const M = 40;
  const k = Math.min((pageWidth() - 2 * M) / img.width, (PAGE_H - 2 * M) / img.height, 1.5);
  return { x: M, y: M, w: img.width * k, h: img.height * k };
}

/** Everything a surface can carry, in the order it is painted. */
export interface BoardLayers {
  strokes: TabletStroke[];
  images?: TabletImage[];
  widgets?: TabletWidget[];
  imageEl?: ImageResolver;
  backdrop?: { el: CanvasImageSource; x: number; y: number; w: number; h: number } | null;
  /** 'main' is what grading sees; 'all' takes the scratch column along too. */
  zone?: 'main' | 'all';
}

/**
 * One picture of a whole surface, cropped to what is on it. The live engine calls
 * this for its exports and the notes store calls it to re-render a saved note, so a
 * note re-rendered years later is the same image the editor would have made.
 *
 * Returns an empty url when there is nothing on the surface at all.
 */
export function renderBoard(layers: BoardLayers): { url: string; w: number; h: number } {
  const zone = layers.zone ?? 'main';
  const ink = zone === 'all' ? layers.strokes.slice() : layers.strokes.filter((s) => s.zone === 'main');
  const pics = layers.images ?? [];
  const wids = layers.widgets ?? [];
  const bg = zone === 'all' ? (layers.backdrop ?? null) : null;
  if (ink.length === 0 && !bg && pics.length === 0 && wids.length === 0) {
    return { url: '', w: 0, h: 0 };
  }
  const box = strokeBounds(ink);
  let minX = box ? box.minX : Infinity;
  let minY = box ? box.minY : Infinity;
  let maxX = box ? box.maxX : -Infinity;
  let maxY = box ? box.maxY : -Infinity;
  // A pasted screenshot is part of the note, so the transcriber must be shown it
  // and the crop must reach around it.
  for (const im of pics) {
    for (const p of imageCorners(im)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  // A widget is part of the page too, so the crop reaches around it even when the
  // note is nothing but a widget.
  for (const wd of wids) {
    minX = Math.min(minX, wd.x - wd.w / 2);
    minY = Math.min(minY, wd.y - wd.h / 2);
    maxX = Math.max(maxX, wd.x + wd.w / 2);
    maxY = Math.max(maxY, wd.y + wd.h / 2);
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
  const ctx = out.getContext('2d');
  if (!ctx) return { url: '', w: 0, h: 0 };
  ctx.fillStyle = settings.canvas.backgroundColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
  if (bg) ctx.drawImage(bg.el, bg.x, bg.y, bg.w, bg.h);
  drawImages(ctx, pics, layers.imageEl ?? (() => null));
  drawWidgets(ctx, wids);
  drawStrokes(ctx, ink);
  return {
    url: out.toDataURL('image/jpeg', settings.export.jpegQuality),
    w: out.width,
    h: out.height,
  };
}

// ---- geometry ----

/** The ink's own extent, each stroke widened by the fattest line pressure can make. */
export function strokeBounds(list: TabletStroke[]): InkBox | null {
  if (list.length === 0) return null;
  const b: InkBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of list) {
    const inflate = (s.w * WIDTH_CAP) / 2;
    b.minX = Math.min(b.minX, s.minX - inflate);
    b.minY = Math.min(b.minY, s.minY - inflate);
    b.maxX = Math.max(b.maxX, s.maxX + inflate);
    b.maxY = Math.max(b.maxY, s.maxY + inflate);
  }
  return b;
}

function pad(b: InkBox, by: number): InkBox {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function overlaps(a: InkBox, b: InkBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * The scale that fills as much of the patch budget as the ink can use. Above the
 * budget the API would rescale for us and thin the line doing it; below it, a small
 * tile is upscaled only as far as MAX_TILE_SCALE, since past that we are paying for
 * pixels of empty paper.
 */
export function tileScale(w: number, h: number): number {
  let k = Math.min(MAX_TILE_SCALE, Math.sqrt(BUDGET_PX / Math.max(1, w * h)));
  // A patch is charged whole, so each axis rounds up and the product can land just
  // over budget even when the areas agree. Step down until the count itself fits.
  while (k > 0.05 && Math.ceil((w * k) / PATCH) * Math.ceil((h * k) / PATCH) > PATCH_BUDGET) {
    k *= 0.98;
  }
  return k;
}

// ---- clustering ----

/**
 * Ink grouped by proximity: two strokes join the same region when their boxes come
 * within `gap` of each other, and joining is transitive, so a paragraph links line by
 * line into one region without any stroke having to be near all the others.
 *
 * Sorting by left edge first lets the scan stop early: once a candidate starts
 * further right than the current stroke ends plus the gap, nothing after it can touch
 * either, because the list only moves rightward from there.
 */
export function clusterStrokes(list: TabletStroke[], gap = CLUSTER_GAP): TabletStroke[][] {
  const n = list.length;
  if (n === 0) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]];
      r = parent[r];
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const order = list.map((_, i) => i).sort((a, b) => list[a].minX - list[b].minX);
  for (let a = 0; a < n; a += 1) {
    const si = list[order[a]];
    for (let b = a + 1; b < n; b += 1) {
      const sj = list[order[b]];
      if (sj.minX > si.maxX + gap) break;
      if (sj.minY - gap <= si.maxY && si.minY - gap <= sj.maxY) union(order[a], order[b]);
    }
  }

  const groups = new Map<number, TabletStroke[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(list[i]);
    else groups.set(root, [list[i]]);
  }
  return [...groups.values()];
}

/**
 * The order a reader would take them in: down the page, and left to right across
 * anything that sits at the same height. Regions whose vertical spans overlap are one
 * band, so two columns of a side-by-side derivation read across rather than the left
 * column being read to the bottom first.
 */
function readingOrder(boxes: InkBox[]): InkBox[] {
  const byTop = [...boxes].sort((a, b) => a.minY - b.minY);
  const bands: { bottom: number; items: InkBox[] }[] = [];
  for (const b of byTop) {
    const band = bands[bands.length - 1];
    if (band && b.minY <= band.bottom) {
      band.items.push(b);
      band.bottom = Math.max(band.bottom, b.maxY);
    } else {
      bands.push({ bottom: b.maxY, items: [b] });
    }
  }
  return bands.flatMap((band) => band.items.sort((a, b) => a.minX - b.minX));
}

/** The configured pen, clamped to what a pen can sensibly be. The tile planner needs
 *  it to know how thin the line would end up, and the engine to lay ink down with it,
 *  so the two read one definition rather than two that can drift apart. */
export function baseWidth(): number {
  const w = Number(settings.tablet.baseWidth);
  return Number.isFinite(w) && w > 0 ? Math.min(6, Math.max(0.5, w)) : 1.2;
}

/**
 * How many cells this region has to be cut into before its ink survives the trip.
 *
 * The test is the pen, not the pixel count: a region is left whole for as long as one
 * image can still draw the line at least MIN_PEN_PX across, because that is the point
 * below which the transcriber is reading a grey smudge rather than a stroke. A page of
 * writing passes and stays one image, which is why an ordinary note costs exactly what
 * it used to. Cutting earlier than that would double the token cost of every note to
 * sharpen ink that was already legible.
 */
function cellsNeeded(b: InkBox): number {
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  if (tileScale(w, h) * baseWidth() >= MIN_PEN_PX) return 1;
  const wanted = MIN_PEN_PX / baseWidth();
  // Each cell is grown on both sides for the seam overlap, so it carries more than its
  // plain share of the area. Counting the cells without that would hand every cell a
  // region slightly too big for the budget and land the pen just under the floor.
  const grow = (1 + 2 * TILE_OVERLAP) ** 2;
  return Math.max(1, Math.ceil((w * h * grow) / (BUDGET_PX / (wanted * wanted))));
}

/**
 * The column and row count to cut a region into, never exceeding the cells it was
 * allotted. Spending the whole allowance comes first, because every unused cell means
 * a larger piece and a thinner line in it; squareness only breaks ties between layouts
 * that use the same number, since a long ribbon of a tile wastes most of its budget on
 * the empty margin above and below one line of writing.
 */
function gridFor(w: number, h: number, cells: number): { cols: number; rows: number } {
  let best = { cols: 1, rows: 1, count: 1, score: Infinity };
  for (let cols = 1; cols <= cells; cols += 1) {
    const rows = Math.floor(cells / cols);
    if (rows < 1) break;
    const count = cols * rows;
    const score = Math.abs(Math.log(w / cols / (h / rows)));
    if (count > best.count || (count === best.count && score < best.score)) {
      best = { cols, rows, count, score };
    }
  }
  return best;
}

/** A region cut into at most `cells` overlapping pieces. */
function splitBox(b: InkBox, cells: number): InkBox[] {
  if (cells <= 1) return [b];
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const { cols, rows } = gridFor(w, h, cells);
  const cw = w / cols;
  const ch = h / rows;
  const ox = cw * TILE_OVERLAP;
  const oy = ch * TILE_OVERLAP;
  const out: InkBox[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({
        minX: Math.max(b.minX, b.minX + c * cw - ox),
        minY: Math.max(b.minY, b.minY + r * ch - oy),
        maxX: Math.min(b.maxX, b.minX + (c + 1) * cw + ox),
        maxY: Math.min(b.maxY, b.minY + (r + 1) * ch + oy),
      });
    }
  }
  return out;
}

// ---- export ----

function inkFor(list: TabletStroke[], zone: 'main' | 'all'): TabletStroke[] {
  return zone === 'all' ? list : list.filter((s) => s.zone === 'main');
}

/**
 * Where the tiles fall, without drawing any of them. Kept separate from the export so
 * the geometry can be checked on its own, and so the probe can report the cut a board
 * would be transcribed in without spending the time to rasterise it.
 */
export function planInkTiles(list: TabletStroke[], zone: 'main' | 'all' = 'all'): InkBox[] {
  const ink = inkFor(list, zone);
  if (ink.length === 0) return [];

  let groups = clusterStrokes(ink);

  // More regions than we will send: fold neighbours together in reading order, so the
  // merging follows the page rather than the order strokes happened to be drawn in.
  if (groups.length > MAX_TILES) {
    const boxed = groups.map((g) => ({ g, box: strokeBounds(g) as InkBox }));
    const order = readingOrder(boxed.map((x) => x.box));
    const sorted = order.map((box) => boxed.find((x) => x.box === box)!.g);
    const merged: TabletStroke[][] = [];
    const per = Math.ceil(sorted.length / MAX_TILES);
    for (let i = 0; i < sorted.length; i += per) merged.push(sorted.slice(i, i + per).flat());
    groups = merged;
  }

  // Regions too big to draw at 1:1 are cut into cells. Every region is owed at least
  // one tile, and what is left of the ceiling goes to the biggest regions first, since
  // those are the ones whose ink would otherwise be scaled thinnest.
  const boxes = groups
    .map((g) => pad(strokeBounds(g) as InkBox, EXPORT_MARGIN))
    .map((box) => ({ box, want: cellsNeeded(box) }))
    .sort((a, b) => b.want - a.want);
  let spare = Math.max(0, MAX_TILES - boxes.length);
  const cut: InkBox[] = [];
  for (const { box, want } of boxes) {
    const take = Math.min(want - 1, spare);
    spare -= take;
    cut.push(...splitBox(box, 1 + take));
  }

  return readingOrder(cut);
}

/**
 * One image per region of the board, in reading order. A page-sized note comes back
 * as a single tile and behaves exactly as it always did; only ink spread wider than
 * one image can carry is split, which is the case the board made possible.
 */
export function exportInkTiles(list: TabletStroke[], zone: 'main' | 'all' = 'all'): InkTile[] {
  const ink = inkFor(list, zone);
  return planInkTiles(list, zone).map((box) => ({ image: renderInk(ink, box), box }));
}

/** The strokes that touch `box`, drawn cropped to it. Strokes are never cut mid-path;
 *  a glyph reaching past the edge is clipped by the canvas and kept whole next door. */
export function renderInk(list: TabletStroke[], box: InkBox): string {
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const k = tileScale(w, h);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * k));
  out.height = Math.max(1, Math.round(h * k));
  const ctx = out.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = settings.canvas.backgroundColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.setTransform(k, 0, 0, k, -box.minX * k, -box.minY * k);
  const inside = list.filter((s) =>
    overlaps(box, { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY }),
  );
  drawStrokes(ctx, inside);
  return out.toDataURL('image/jpeg', settings.export.jpegQuality);
}
