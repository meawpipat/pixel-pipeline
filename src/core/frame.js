// FR-13 strip split, FR-09 stray pixels, FR-08 outline.
// Frame: { w, h, I: Uint8Array (0..3, 4 = transparent), ox, oy } where (ox, oy) is the
// position of I[0] in segment-local cell coordinates.
import { TRANSPARENT } from './config.js';

/** Keep only cells whose centre lies inside [0, size) of the ROI (FR-13 W definition). */
export function cellRangeInRoi(lines, size) {
  let a = -1, b = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    const c = (lines[i] + lines[i + 1]) / 2;
    if (c >= 0 && c < size) { if (a < 0) a = i; b = i; }
  }
  return a < 0 ? [0, -1] : [a, b];
}

export function subImage(q, x0, y0, w, h) {
  const I = new Uint8Array(w * h).fill(TRANSPARENT);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x0 + x, sy = y0 + y;
    if (sx >= 0 && sy >= 0 && sx < q.w && sy < q.h) I[y * w + x] = q.I[sy * q.w + sx];
  }
  return { w, h, I };
}

export const defaultDividers = (W, N) => Array.from({ length: N - 1 }, (_, i) => Math.floor(((i + 1) * W) / N + 0.5));

/** Validate a strip's used-segment list (FR-23): sorted, unique, in range, non-empty. Returns the list (all if absent). */
export function checkUse(use, n) {
  if (use == null) return Array.from({ length: n }, (_, i) => i);
  if (!Array.isArray(use) || !use.length) throw new Error('use at least one frame of the strip');
  for (let i = 0; i < use.length; i++) {
    if (!Number.isInteger(use[i]) || use[i] < 0 || use[i] >= n) throw new Error(`used segment ${use[i]} is outside 0..${n - 1}`);
    if (i && use[i] <= use[i - 1]) throw new Error('used segments must be listed once each, in order');
  }
  return use.slice();
}

/** Split an index image (full strip, cells within ROI) into N frames. Only used segments (and segment 0, the anchor) must hold pixels. */
export function splitStrip(q, n, dividers, use = null) {
  const used = new Set(checkUse(use, n));
  if (!(n >= 1)) throw new Error('strip frame count must be ≥ 1');
  const W = q.w;
  const d = dividers && dividers.length ? dividers : defaultDividers(W, n);
  if (d.length !== n - 1) throw new Error(`expected ${n - 1} dividers, got ${d.length}`);
  for (let i = 0; i < d.length; i++) {
    if (!Number.isInteger(d[i]) || d[i] < 1 || d[i] > W - 1 || (i && d[i] <= d[i - 1])) throw new Error(`invalid divider #${i + 1} (${d[i]}): must be strictly increasing integers in 1..${W - 1}`);
  }
  const bounds = [0, ...d, W];
  const frames = [];
  for (let s = 0; s < n; s++) {
    const sub = subImage(q, bounds[s], 0, bounds[s + 1] - bounds[s], q.h);
    const empty = !sub.I.some((v) => v !== TRANSPARENT);
    if (empty && s === 0) throw new Error(used.has(0) ? 'first frame empty' : 'segment 0 anchors the unit and must contain pixels — move the first divider or the region');
    if (empty && used.has(s)) throw new Error(`segment ${s} is empty`);
    frames.push({ ...sub, ox: 0, oy: 0 });
  }
  return { frames, dividers: d };
}

const at = (f, x, y) => (x < 0 || y < 0 || x >= f.w || y >= f.h ? TRANSPARENT : f.I[y * f.w + x]);

/** FR-09: isolated opaque pixels whose 8 neighbours all differ (or are transparent). */
export function strayPixels(f) {
  const out = [];
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const v = at(f, x, y);
    if (v === TRANSPARENT) continue;
    let iso = true;
    for (let dy = -1; dy <= 1 && iso; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(f, x + dx, y + dy) === v) { iso = false; break; }
    if (iso) out.push([x, y]);
  }
  return out;
}

export function removeStray(f) {
  const I = f.I.slice();
  for (const [x, y] of strayPixels(f)) I[y * f.w + x] = TRANSPARENT;
  return { ...f, I };
}

/** FR-08: ratio of edge pixels (opaque, 4-neighbour of transparency) that are not black. */
export function outlineRatio(f) {
  let edge = 0, bad = 0;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const v = at(f, x, y);
    if (v === TRANSPARENT) continue;
    if (at(f, x - 1, y) === TRANSPARENT || at(f, x + 1, y) === TRANSPARENT || at(f, x, y - 1) === TRANSPARENT || at(f, x, y + 1) === TRANSPARENT) {
      edge++; if (v !== 0) bad++;
    }
  }
  return edge ? bad / edge : 0;
}

/** FR-08 auto-outline: add index 0 on transparent pixels 8-adjacent to opaque. Grows by 1 px each side. */
export function addOutline(f) {
  const w = f.w + 2, h = f.h + 2, I = new Uint8Array(w * h).fill(TRANSPARENT);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = at(f, x - 1, y - 1);
    if (v !== TRANSPARENT) { I[y * w + x] = v; continue; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(f, x - 1 + dx, y - 1 + dy) !== TRANSPARENT) { I[y * w + x] = 0; dy = 2; break; }
  }
  return { w, h, I, ox: f.ox - 1, oy: f.oy - 1 };
}

/** Opaque bbox in frame-local coords, or null. */
export function opaqueBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (f.I[y * f.w + x] !== TRANSPARENT) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { left: x0, top: y0, right: x1, bottom: y1 };
}
