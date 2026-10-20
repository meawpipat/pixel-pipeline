// Exact palette mapping (FR-15 normalize, FR-17 import): no nearest-colour guessing.
import { decodePng } from './png.js';
import { TRANSPARENT } from './config.js';
import { canonicalPalette } from './validate.js';

/** Decode any 64x64 PNG and map it to an index array by exact RGB match; throws on anything else. */
export function normalizeToIndex(bytes, cfg) {
  const d = decodePng(bytes);
  if (d.w !== cfg.canvas.w || d.h !== cfg.canvas.h) throw new Error(`size ${d.w}x${d.h}, expected ${cfg.canvas.w}x${cfg.canvas.h}`);
  if (d.indexed) {
    const nPal = (d.indexed.palette || []).length / 3;
    for (const v of d.indexed.data) if (v >= nPal) throw new Error(`pixel index ${v} is outside the file's own palette (${nPal} entries)`);
  }
  const pal = canonicalPalette(cfg).slice(0, 4);
  const I = new Uint8Array(d.w * d.h);
  for (let i = 0; i < I.length; i++) {
    const q = i * 4, a = d.rgba[q + 3];
    if (a === 0) { I[i] = TRANSPARENT; continue; }
    if (a !== 255) throw new Error(`pixel ${i % d.w},${(i / d.w) | 0} has partial alpha ${a}`);
    const k = pal.findIndex((c) => c[0] === d.rgba[q] && c[1] === d.rgba[q + 1] && c[2] === d.rgba[q + 2]);
    if (k < 0) throw new Error(`pixel ${i % d.w},${(i / d.w) | 0} colour #${[0, 1, 2].map((j) => d.rgba[q + j].toString(16).padStart(2, '0')).join('')} is not a palette colour`);
    I[i] = k;
  }
  return { w: d.w, h: d.h, I };
}
