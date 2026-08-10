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
    const w = bucketWidth(widthFor(s, pts[i].p));
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

export function drawStrokes(ctx: CanvasRenderingContext2D, list: TabletStroke[]): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = settings.canvas.strokeColor;
  ctx.fillStyle = settings.canvas.strokeColor;
  for (const s of list) drawStroke(ctx, s);
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
