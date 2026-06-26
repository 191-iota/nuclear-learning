import type { Ref } from 'vue';
import settings from '@config/settings.json';
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
 * and project them — aspect-preserving and centred — into the canvas on every
 * frame. A `requestAnimationFrame` scheduler keeps that O(n)-per-frame regardless
 * of how fast dots arrive.
 */
export function useCanvas(canvasRef: Ref<HTMLCanvasElement | null>) {
  const dots: PenDot[] = [];
  let bbox: Bbox | null = null;
  let rafId = 0;
  // Largest force seen so far — the pen reports raw force values whose scale
  // varies, so we self-calibrate line width against this.
  let maxForce = 1;

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
    // Fit the writing to the canvas, but never magnify beyond maxScale — so a
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
      // PEN_DOWN starts a stroke but carries placeholder (-1,-1) coordinates —
      // use it only as a marker to break the line, never as a point. Skip
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
    const ctx = context();
    const c = canvasRef.value;
    if (ctx && c) fillBackground(ctx, c);
  }

  function exportPng(): string {
    // Flush any pending frame so the export reflects every dot.
    redraw();
    const c = canvasRef.value;
    return c ? c.toDataURL('image/png') : '';
  }

  function hasContent(): boolean {
    return dots.some((d) => d.x >= 0 && d.y >= 0 && d.dotType !== DOT_HOVER);
  }

  return { addDot, clear, resize, redraw, exportPng, hasContent };
}
