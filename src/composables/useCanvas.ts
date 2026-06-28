import type { Ref } from 'vue';
import { settings } from '@/stores/settings';
import type { PenDot } from '@/composables/usePen';

// Neo dot types.
const DOT_DOWN = 0;
const DOT_MOVE = 1;
const DOT_UP = 2;
const DOT_HOVER = 3;

interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Renders pen dots onto a canvas. The pen reports raw ncode coordinates whose
 * scale and origin depend on the page, so we track the bounding box of all dots
 * and project them, aspect-preserving and centred, into the canvas on every
 * frame. A `requestAnimationFrame` scheduler keeps that O(n)-per-frame regardless
 * of how fast dots arrive.
 */
export function useCanvas(canvasRef: Ref<HTMLCanvasElement | null>) {
  const dots: PenDot[] = [];
  let bbox: Bbox | null = null;
  let rafId = 0;
  // Largest force seen so far, the pen reports raw force values whose scale
  // varies, so we self-calibrate line width against this.
  let maxForce = 1;
  // Count of pen-down events = strokes written. Used to gate scans on how much
  // new ink has been added since the last check.
  let strokes = 0;

  function context(): CanvasRenderingContext2D | null {
    const c = canvasRef.value;
    return c ? c.getContext('2d') : null;
  }

  function fillBackground(ctx: CanvasRenderingContext2D, c: HTMLCanvasElement) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = settings.canvas.backgroundColor;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  }

  function project(d: PenDot, c: HTMLCanvasElement, b: Bbox) {
    const pad = 0.06;
    const w = Math.max(b.maxX - b.minX, 1e-6);
    const h = Math.max(b.maxY - b.minY, 1e-6);
    const dpr = window.devicePixelRatio || 1;
    // Fit the writing to the canvas, but never magnify beyond maxScale, so a
    // little writing stays a natural size instead of being blown up to fill the
    // pad. Anchored top-left so it grows down-and-right like writing on paper.
    const fitScale = Math.min((c.width * (1 - 2 * pad)) / w, (c.height * (1 - 2 * pad)) / h);
    const scale = Math.min(fitScale, settings.canvas.maxScale * dpr);
    const offX = c.width * pad;
    const offY = c.height * pad;
    return { px: offX + (d.x - b.minX) * scale, py: offY + (d.y - b.minY) * scale };
  }

  function lineWidthFor(d: PenDot) {
    // The pen reports raw force readings (a 16-bit value, not a 0..1 fraction)
    // and the scale differs per pen, so normalise against the largest force seen
    // so far. `pressureMultiplier` is then the width at full pressure.
    const f = typeof d.f === 'number' && d.f > 0 ? d.f : 0;
    const norm = maxForce > 0 ? Math.min(1, f / maxForce) : 0.5;
    return Math.min(6, Math.max(0.7, norm * settings.canvas.pressureMultiplier));
  }

  function redraw() {
    const ctx = context();
    const c = canvasRef.value;
    if (!ctx || !c) return;
    fillBackground(ctx, c);
    if (!bbox || dots.length === 0) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = settings.canvas.strokeColor;

    let prev: { px: number; py: number } | null = null;
    for (const d of dots) {
      // PEN_DOWN starts a stroke but carries placeholder (-1,-1) coordinates.
      // Use it only as a marker to break the line, never as a point. Skip
      // anything else without real coordinates (hover, page-info sentinels).
      if (d.dotType === DOT_DOWN) {
        prev = null;
        continue;
      }
      if (d.dotType === DOT_HOVER || d.x < 0 || d.y < 0) continue;
      if (d.dotType !== DOT_MOVE && d.dotType !== DOT_UP) continue;
      const p = project(d, c, bbox);
      if (prev) {
        ctx.lineWidth = lineWidthFor(d);
        ctx.beginPath();
        ctx.moveTo(prev.px, prev.py);
        ctx.lineTo(p.px, p.py);
        ctx.stroke();
      }
      prev = d.dotType === DOT_UP ? null : p;
    }
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      redraw();
    });
  }

  function expandBbox(d: PenDot) {
    if (!bbox) {
      bbox = { minX: d.x, minY: d.y, maxX: d.x, maxY: d.y };
      return;
    }
    if (d.x < bbox.minX) bbox.minX = d.x;
    if (d.y < bbox.minY) bbox.minY = d.y;
    if (d.x > bbox.maxX) bbox.maxX = d.x;
    if (d.y > bbox.maxY) bbox.maxY = d.y;
  }

  function addDot(d: PenDot) {
    if (d.dotType === DOT_HOVER) return;
    if (d.dotType === DOT_DOWN) strokes += 1;
    const hasCoords = d.x >= 0 && d.y >= 0;
    // Drop page-info / placeholder dots that carry no coordinates, but keep
    // PEN_DOWN (whose (-1,-1) is a sentinel) as a stroke-start marker.
    if (!hasCoords && d.dotType !== DOT_DOWN) return;
    dots.push(d);
    if (hasCoords) {
      expandBbox(d);
      if (typeof d.f === 'number' && d.f > maxForce) maxForce = d.f;
    }
    scheduleRender();
  }

  function resize() {
    const c = canvasRef.value;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    redraw();
  }

  function clear() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    dots.length = 0;
    bbox = null;
    maxForce = 1;
    strokes = 0;
    const ctx = context();
    const c = canvasRef.value;
    if (ctx && c) fillBackground(ctx, c);
  }

  function exportImage(): string {
    // Flush any pending frame so the export reflects every dot.
    redraw();
    const c = canvasRef.value;
    if (!c) return '';

    const q = settings.export.jpegQuality;
    // No ink yet: fall back to the whole pad (callers normally gate on hasContent).
    if (!bbox) return c.toDataURL('image/jpeg', q);

    // Project the ink's bounding box into canvas pixels, pad it, clamp to the pad.
    // Sending only the written region instead of the whole white canvas is the
    // dominant token saving, vision cost scales with pixel area, not bytes.
    const pad = settings.export.paddingPx;
    const p0 = project({ x: bbox.minX, y: bbox.minY } as PenDot, c, bbox);
    const p1 = project({ x: bbox.maxX, y: bbox.maxY } as PenDot, c, bbox);
    const sx = Math.max(0, Math.min(p0.px, p1.px) - pad);
    const sy = Math.max(0, Math.min(p0.py, p1.py) - pad);
    const sw = Math.min(c.width - sx, Math.abs(p1.px - p0.px) + pad * 2);
    const sh = Math.min(c.height - sy, Math.abs(p1.py - p0.py) + pad * 2);
    if (sw < 1 || sh < 1) return c.toDataURL('image/jpeg', q);

    // Downscale so the long edge never exceeds maxEdgePx, handwriting stays
    // legible well below that, and fewer pixels means fewer tokens. Never upscale.
    const scale = Math.min(1, settings.export.maxEdgePx / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const out = document.createElement('canvas');
    out.width = dw;
    out.height = dh;
    const octx = out.getContext('2d');
    if (!octx) return c.toDataURL('image/jpeg', q);
    octx.fillStyle = settings.canvas.backgroundColor;
    octx.fillRect(0, 0, dw, dh);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(c, sx, sy, sw, sh, 0, 0, dw, dh);
    // Lossy JPEG keeps the payload small while strokes stay crisp at this quality.
    return out.toDataURL('image/jpeg', q);
  }

  function hasContent(): boolean {
    return dots.some((d) => d.x >= 0 && d.y >= 0 && d.dotType !== DOT_HOVER);
  }

  function strokeCount(): number {
    return strokes;
  }

  return { addDot, clear, resize, redraw, exportImage, hasContent, strokeCount };
}
