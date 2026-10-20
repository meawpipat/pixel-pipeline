// FR-05 cell sampling (and Fallback area-average downscale).
// Output "native" image: { w, h, L: Int16Array } where L = luma 0..255 or -1 (transparent).
import { luma } from './config.js';

/**
 * Sample cells defined by grid lines (boundary coordinates in source px).
 * Samples = source pixels whose centres fall inside the cell's central rectangle
 * (half the cell size). Samples outside the image count as transparent.
 */
export function sampleCells(img, xLines, yLines, { cellAlphaMin = 0.5 } = {}) {
  const cw = xLines.length - 1, ch = yLines.length - 1;
  const L = new Int16Array(Math.max(0, cw * ch)).fill(-1);
  const vals = [];
  for (let cy = 0; cy < ch; cy++) {
    const t = yLines[cy], b = yLines[cy + 1];
    const y0 = t + (b - t) / 4, y1 = b - (b - t) / 4;
    for (let cx = 0; cx < cw; cx++) {
      const l = xLines[cx], r = xLines[cx + 1];
      const x0 = l + (r - l) / 4, x1 = r - (r - l) / 4;
      let total = 0; vals.length = 0;
      for (let py = Math.ceil(y0 - 0.5); py + 0.5 <= y1; py++) {
        if (py + 0.5 < y0) continue;
        for (let px = Math.ceil(x0 - 0.5); px + 0.5 <= x1; px++) {
          if (px + 0.5 < x0) continue;
          total++;
          if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue;
          const q = (py * img.w + px) * 4;
          if (img.rgba[q + 3] >= 128) vals.push(luma(img.rgba[q], img.rgba[q + 1], img.rgba[q + 2]));
        }
      }
      if (total === 0 || vals.length / total < cellAlphaMin) continue;
      vals.sort((a, b) => a - b);
      L[cy * cw + cx] = vals[(vals.length - 1) >> 1]; // lower median
    }
  }
  return { w: cw, h: ch, L };
}

/** Fallback: area-average downscale to target height (pixels assigned by centre). */
export function sampleFallback(img, targetH, { cellAlphaMin = 0.5 } = {}) {
  const f = img.h / targetH;
  const tw = Math.max(1, Math.round(img.w / f));
  const L = new Int16Array(tw * targetH).fill(-1);
  for (let ty = 0; ty < targetH; ty++) for (let tx = 0; tx < tw; tx++) {
    let total = 0, opaque = 0, sum = 0;
    for (let py = Math.ceil(ty * f - 0.5); py + 0.5 < (ty + 1) * f; py++) {
      if (py + 0.5 < ty * f || py < 0 || py >= img.h) continue;
      for (let px = Math.ceil(tx * f - 0.5); px + 0.5 < (tx + 1) * f; px++) {
        if (px + 0.5 < tx * f || px < 0 || px >= img.w) continue;
        total++;
        const q = (py * img.w + px) * 4;
        if (img.rgba[q + 3] >= 128) { opaque++; sum += luma(img.rgba[q], img.rgba[q + 1], img.rgba[q + 2]); }
      }
    }
    if (total && opaque / total >= cellAlphaMin) L[ty * tw + tx] = Math.floor((2 * sum + opaque) / (2 * opaque)); // half-up
  }
  return { w: tw, h: targetH, L };
}

/** Trim a native image to the bbox of opaque cells. Returns { img, offset:[x,y] }. */
export function trimNative(nat) {
  let x0 = nat.w, y0 = nat.h, x1 = -1, y1 = -1;
  for (let y = 0; y < nat.h; y++) for (let x = 0; x < nat.w; x++) if (nat.L[y * nat.w + x] >= 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return { img: { w: 0, h: 0, L: new Int16Array(0) }, offset: [0, 0] };
  const w = x1 - x0 + 1, h = y1 - y0 + 1, L = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = nat.L[(y0 + y) * nat.w + x0 + x];
  return { img: { w, h, L }, offset: [x0, y0] };
}
