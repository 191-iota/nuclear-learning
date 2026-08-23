import { reactive, watch } from 'vue';
import { settings, inkOnDisk } from '@/stores/settings';
import { dbState } from '@/db';
import { makeThumb } from '@/stores/archive';
import {
  backdropBox,
  renderBoard,
  type TabletImage,
  type TabletStroke,
} from '@/composables/inkExport';
import {
  loadNoteBg,
  loadNoteImages,
  loadNoteInk,
  notesStore,
  setNotePreview,
  type Note,
} from '@/stores/notes';

/**
 * The ink colour applied to writing that already exists.
 *
 * Nothing stores a colour per stroke: ink takes its colour when it is drawn (see
 * drawStrokes in inkExport, which is also where the shipped colour is argued for), so
 * changing the setting repaints every stroke in the app the moment it is next drawn.
 * Old notes reopen in the new ink, their transcription tiles are rendered in it, and
 * none of that needs anything from this module.
 *
 * What does not follow by itself is the PICTURE of a note. Each note keeps a JPEG of
 * the board and a thumbnail for the notebook grid, both rendered when the note was
 * last saved, so a note written last month would sit in the grid in last month's ink
 * next to a note written today. This module re-renders those.
 *
 * The rule it works under, which is what makes it safe to run without being asked:
 *
 * - A note's picture and thumbnail are a RENDER of its strokes. The editor rebuilds
 *   them on every save. Re-rendering them changes nothing that was written, and this
 *   module rewrites nothing else: not the transcript, not the tags, not the title,
 *   not even the edited stamp, so the notebook does not reorder itself.
 * - Anything that IS the writing is left alone on disk. The strokes are untouched by
 *   definition. A pre-strokes note that was continued keeps its original picture as a
 *   backdrop layer, and that file stays exactly as it was: it is recoloured in memory
 *   when it is loaded, so it follows the ink colour today and would follow it again if
 *   the colour changed once more.
 * - A note that has no strokes keeps its picture untouched, and is counted as such.
 *   Its picture is either a pasted screenshot or a capture from before ink was
 *   persisted, and nothing inside a JPEG says which. Recolouring a photograph on the
 *   guess that it might be handwriting is not a trade worth making. Continue writing
 *   on one and it gains strokes and a backdrop, and from then on it follows.
 *
 * The Aufgaben archive is deliberately outside all of this. Those pages are the record
 * of what was handed in and graded, and a record is not a thing to repaint.
 *
 * Console access: __nlInkColor()
 */

const KEY = 'nl.ink.v1';

/**
 * How much colour of its own a pixel may carry and still count as ink on paper, out
 * of 255. Handwriting rendered in a near-neutral ink stays well under this even after
 * JPEG has had its way with the edges; anything above it belongs to a picture and is
 * left alone.
 */
const CHROMA_MAX = 40;

interface InkRecord {
  /** The colour of rasters that are never rewritten (a legacy note's backdrop). */
  origin: string;
  /** The colour the note pictures on disk have been rendered in. */
  baked: string;
}

function loadRecord(): InkRecord {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<InkRecord> | null;
    if (saved?.origin && saved?.baked) return { origin: saved.origin, baked: saved.baked };
  } catch {
    /* fall through to the first-run record */
  }
  // First run under this module: everything on disk was drawn in the colour that was
  // in force before this load, whatever it was.
  return { origin: inkOnDisk, baked: inkOnDisk };
}

const record = loadRecord();

export const inkColorState = reactive({
  origin: record.origin,
  baked: record.baked,
  running: false,
  done: 0,
  total: 0,
  /** Notes whose picture is not a render of strokes, so it was left as it is. */
  kept: 0,
  failed: 0,
});

function save(): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ origin: inkColorState.origin, baked: inkColorState.baked }),
    );
  } catch {
    /* storage unavailable, non-fatal */
  }
}

// ---- the colour pass over a raster ----

function rgb(css: string): [number, number, number] {
  const hex = css.trim().replace('#', '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function decodeImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * A picture of ink on paper, in a different ink.
 *
 * Every pixel is read as a COVERAGE: how much of the old ink was laid over the paper
 * there, which is what the anti-aliased edge of a stroke is made of. That coverage is
 * then laid down again in the new colour. Paper stays paper, a fully inked pixel
 * becomes the new ink exactly, and every shade between keeps its share, so the shape
 * of every letter, the weight of every line and the softness of every edge come
 * through unchanged. Nothing here can move a stroke or thin one.
 *
 * Pixels carrying real colour are skipped, so a screenshot living inside the raster
 * survives as itself.
 */
export async function tintRaster(dataUrl: string, from: string, to: string): Promise<string> {
  if (!dataUrl || from.toLowerCase() === to.toLowerCase()) return dataUrl;
  const img = await decodeImage(dataUrl);
  if (!img) return dataUrl;
  const c = document.createElement('canvas');
  c.width = Math.max(1, img.naturalWidth || img.width);
  c.height = Math.max(1, img.naturalHeight || img.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  let frame: ImageData;
  try {
    frame = ctx.getImageData(0, 0, c.width, c.height);
  } catch {
    return dataUrl; // a tainted canvas, which our own data URLs never are
  }
  const px = frame.data;
  const [pr, pg, pb] = rgb(settings.canvas.backgroundColor || '#ffffff');
  const [fr, fg, fb] = rgb(from);
  const [tr, tg, tb] = rgb(to);
  const paperY = luma(pr, pg, pb);
  // How dark the old ink was against the paper. Dividing by it is what makes a fully
  // inked pixel land exactly on the new ink rather than a shade short of it.
  const span = Math.max(1, paperY - luma(fr, fg, fb));
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHROMA_MAX) continue;
    const y = luma(r, g, b);
    if (y >= paperY) continue; // paper, or JPEG ringing just above it
    const t = Math.min(1, (paperY - y) / span);
    px[i] = Math.round(pr + (tr - pr) * t);
    px[i + 1] = Math.round(pg + (tg - pg) * t);
    px[i + 2] = Math.round(pb + (tb - pb) * t);
  }
  ctx.putImageData(frame, 0, 0);
  return c.toDataURL('image/jpeg', settings.export.jpegQuality);
}

/**
 * A legacy note's backdrop layer in today's ink. The file on disk is left as it was
 * written; this is the copy the editor draws and the copy a re-render draws, so the
 * two agree and neither is destructive.
 */
export function inkedBackdrop(dataUrl: string): Promise<string> {
  return tintRaster(dataUrl, inkColorState.origin, settings.canvas.strokeColor);
}

// ---- the sweep over the notebook ----

/** Notes whose picture is a render this module can rebuild. */
function refreshable(n: Note): boolean {
  return n.source === 'pad' && Boolean(n.hasInk);
}

/** Notes with a picture that is not a render of strokes, so it stays as it is. */
function kept(n: Note): boolean {
  return n.source === 'pad' && n.hasImage && !n.hasInk;
}

export function pendingNotes(): number {
  return notesStore.notes.filter(refreshable).length;
}

export function keptNotes(): number {
  return notesStore.notes.filter(kept).length;
}

async function refreshNote(n: Note): Promise<boolean> {
  const strokes = (await loadNoteInk(n.id)) as TabletStroke[] | null;
  if (!strokes?.length) return false;
  const pics = n.hasImgs ? ((await loadNoteImages(n.id)) as TabletImage[] | null) ?? [] : [];
  // Pictures are drawn from their own blobs, in their own colours, exactly as the
  // editor draws them.
  const els = new Map<string, HTMLImageElement>();
  for (const im of pics) {
    const el = await decodeImage(im.src);
    if (el) els.set(im.src, el);
  }
  let backdrop: { el: HTMLImageElement; x: number; y: number; w: number; h: number } | null = null;
  if (n.hasBg) {
    const raw = await loadNoteBg(n.id);
    const el = raw ? await decodeImage(await inkedBackdrop(raw)) : null;
    if (el) backdrop = { el, ...backdropBox(el) };
  }
  const out = renderBoard({
    strokes,
    images: pics,
    imageEl: (src) => els.get(src) ?? null,
    backdrop,
    zone: 'all',
  });
  if (!out.url) return false;
  await setNotePreview(n.id, { image: out.url, thumb: await makeThumb(out.url) });
  return true;
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => resolve());
    else window.setTimeout(resolve, 0);
  });
}

/**
 * Re-render every note picture in the current ink. Runs once per colour change and
 * then stops: the record on disk says which colour the pictures hold, so a reload
 * costs nothing. One note at a time, yielding between them, because this is a canvas
 * render and a JPEG encode per note and the pen must never wait on it.
 */
export async function applyInkColor(force = false): Promise<void> {
  const to = settings.canvas.strokeColor;
  if (inkColorState.running) return;
  if (!force && to === inkColorState.baked) return;
  if (!dbState.available) return; // nothing durable to write to; the live ink is right anyway
  const todo = notesStore.notes.filter(refreshable);
  inkColorState.running = true;
  inkColorState.total = todo.length;
  inkColorState.done = 0;
  inkColorState.failed = 0;
  inkColorState.kept = notesStore.notes.filter(kept).length;
  try {
    for (const n of todo) {
      try {
        await refreshNote(n);
      } catch (err) {
        inkColorState.failed += 1;
        console.warn('[nuclear-learning] recolouring a note picture failed:', n.id, err);
      }
      inkColorState.done += 1;
      await idle();
    }
    // Recorded even when some notes failed, so a broken blob cannot make every boot
    // start the sweep again. The button in Presets forces a re-run.
    inkColorState.baked = to;
    save();
  } finally {
    inkColorState.running = false;
  }
  // The colour moved on while that was running, which a colour picker being dragged
  // will do. The pictures are one colour behind, so go round once more.
  if (settings.canvas.strokeColor !== inkColorState.baked) void applyInkColor();
}

/** How long the colour has to hold still before the notebook follows it. A colour
 *  picker being dragged emits a colour per frame, and each one is a render of every
 *  note in the book. */
const SETTLE_MS = 1200;

// The notebook loads from disk asynchronously, so the sweep waits for it and then
// runs behind the first paint. A colour that has not changed falls straight through.
if (typeof window !== 'undefined') {
  let stop: (() => void) | undefined;
  const start = (): void => {
    stop?.();
    void idle().then(() => applyInkColor());
  };
  if (notesStore.ready) start();
  else {
    stop = watch(
      () => notesStore.ready,
      (ready) => {
        if (ready) start();
      },
    );
  }

  let settle: number | undefined;
  watch(
    () => settings.canvas.strokeColor,
    () => {
      if (settle) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = undefined;
        void applyInkColor();
      }, SETTLE_MS);
    },
  );

  (window as unknown as { __nlInkColor: unknown }).__nlInkColor = () => ({
    ink: settings.canvas.strokeColor,
    origin: inkColorState.origin,
    baked: inkColorState.baked,
    running: inkColorState.running,
    done: inkColorState.done,
    total: inkColorState.total,
    kept: inkColorState.kept,
    failed: inkColorState.failed,
    pending: pendingNotes(),
  });
}
