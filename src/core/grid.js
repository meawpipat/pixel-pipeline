// FR-04 pixel-grid detection: coarse period/phase from gradient projections,
// least-squares refinement, then local re-phasing (snap to edges within ±period/4).
import { luma } from './config.js';

/** Edge-energy profile per axis. g[x] = energy of the boundary between pixel x-1 and x. */
export function edgeProfiles(img) {
  const { w, h, rgba } = img;
  const v = new Int16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    v[i] = rgba[q + 3] < 128 ? -128 : luma(rgba[q], rgba[q + 1], rgba[q + 2]);
  }
  const gx = new Float64Array(w + 1), gy = new Float64Array(h + 1);
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) gx[x] += Math.abs(v[y * w + x] - v[y * w + x - 1]);
  for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) gy[y] += Math.abs(v[y * w + x] - v[(y - 1) * w + x]);
  return { gx, gy };
}

function percentile(arr, p) {
  const s = Array.from(arr).filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Coarse search: best (period, phase) maximising excess captured energy. */
export function coarsePeriod(g, minP = 2, maxP = 64) {
  const n = g.length;
  let total = 0; for (let i = 0; i < n; i++) total += g[i];
  if (total === 0) return null;
  maxP = Math.min(maxP, n / 2);
  const BIN = 0.1; // capture window ±min(1, p/4) px
  let best = null;
  for (let p = minP; p <= maxP + 1e-9; p = Math.round((p + 0.05) * 100) / 100) {
    const nb = Math.ceil(p / BIN);
    const hist = new Float64Array(nb);
    for (let x = 0; x < n; x++) if (g[x]) hist[Math.floor((x % p) / BIN) % nb] += g[x];
    const win = Math.round(Math.min(1.0, p / 4) / BIN);
    if (2 * win + 1 >= nb) continue;
    // circular window sum of width 2*win+1 bins
    let s = 0; for (let k = -win; k <= win; k++) s += hist[((k % nb) + nb) % nb];
    let bestS = s, bestB = 0;
    for (let b = 1; b < nb; b++) {
      s += hist[(b + win) % nb] - hist[(((b - win - 1) % nb) + nb) % nb];
      if (s > bestS) { bestS = s; bestB = b; }
    }
    const frac = bestS / total;
    const score = frac - Math.min(1, ((2 * win + 1) * BIN) / p);
    if (!best || score > best.score + 1e-12) best = { period: p, phase: bestB * BIN, score };
  }
  return best;
}

function linesFromModel(period, phase, n) {
  const lines = [];
  let k = Math.floor((0 - phase) / period);
  while (phase + k * period <= n + 1e-9) { lines.push(phase + k * period); k++; }
  return lines;
}

function snapLines(pred, g, period, thr) {
  const n = g.length - 1;
  return pred.map((c) => {
    const lo = Math.max(0, Math.ceil(c - period / 4)), hi = Math.min(n, Math.floor(c + period / 4));
    let bx = -1, bv = -1;
    for (let x = lo; x <= hi; x++) if (g[x] > bv || (g[x] === bv && Math.abs(x - c) < Math.abs(bx - c))) { bv = g[x]; bx = x; }
    return bx >= 0 && bv >= thr ? { pos: bx, snapped: true } : { pos: c, snapped: false };
  });
}

/**
 * Detect the grid on one axis.
 * opts: { period?, phase?, snapping=true } — period/phase override auto detection.
 * Returns { period, phase, lines:number[], confidence }.
 */
/**
 * Remove a uniform background of small edges (e.g. the 2-px lattice left when a generator
 * renders at half size and upscales x2, plus render noise): g' = max(0, g − moving median(7)).
 * Real art-grid edges are isolated peaks and survive.
 */
export function detrend(g, win = 7) {
  const h = win >> 1, out = new Float64Array(g.length), buf = [];
  for (let x = 0; x < g.length; x++) {
    buf.length = 0;
    for (let k = x - h; k <= x + h; k++) if (k >= 0 && k < g.length) buf.push(g[k]);
    buf.sort((a, b) => a - b);
    out[x] = Math.max(0, g[x] - buf[buf.length >> 1]);
  }
  return out;
}

export function detectAxis(gRaw, { period, phase, snapping = true } = {}, autoRange = [4, 64]) {
  if (period != null && !(Number.isFinite(period) && period >= 2 && period <= 64)) throw new Error(`grid period must be 2–64 source px, got ${period}`);
  if (phase != null && !Number.isFinite(phase)) throw new Error(`grid phase must be a number, got ${phase}`);
  // One rule for auto and stored grids: detrend whenever the period is ≥ 4 (the auto search floor).
  const g = period == null || period >= 4 ? detrend(gRaw) : gRaw;
  const n = g.length - 1;
  const thr = 0.25 * percentile(g, 0.9);
  let auto = period == null;
  if (auto) {
    const c = coarsePeriod(g, autoRange[0], autoRange[1]);
    if (!c) return { period: null, phase: null, lines: [], confidence: 0 };
    period = c.period; phase = c.phase;
  }
  if (phase == null) phase = 0;
  if (auto) {
    // Least-squares refinement on snapped lines (two passes).
    for (let pass = 0; pass < 2; pass++) {
      const pred = linesFromModel(period, phase, n);
      const sn = snapLines(pred, g, period, thr);
      const pts = [];
      sn.forEach((s, i) => { if (s.snapped) pts.push([Math.round((pred[i] - phase) / period), s.pos]); });
      if (pts.length < 3) break;
      let sk = 0, sx = 0, skk = 0, skx = 0;
      for (const [k, x] of pts) { sk += k; sx += x; skk += k * k; skx += k * x; }
      const m = pts.length, den = m * skk - sk * sk;
      if (!den) break;
      const p2 = (m * skx - sk * sx) / den, o2 = (sx - p2 * sk) / m;
      if (!(p2 > 1.5)) break;
      period = p2; phase = ((o2 % period) + period) % period;
    }
  }
  const pred = linesFromModel(period, phase, n);
  const sn = snapLines(pred, g, period, thr);
  // Confidence: share of edge energy within ±1 px of the grid lines, normalised so that a
  // random comb scores ~0 and a perfect grid scores 1: (E_line/E_total − 3/p) / (1 − 3/p).
  let eLine = 0, eAll = 0;
  const onLine = new Uint8Array(n + 1);
  for (const c of pred) for (let x = Math.round(c) - 1; x <= Math.round(c) + 1; x++) if (x >= 0 && x <= n) onLine[x] = 1;
  for (let x = 0; x <= n; x++) { eAll += g[x]; if (onLine[x]) eLine += g[x]; }
  const expect = Math.min(0.99, 3 / period);
  const confidence = eAll > 0 ? Math.max(0, Math.min(1, (eLine / eAll - expect) / (1 - expect))) : 0;
  let lines = snapping ? sn.map((s) => s.pos) : pred;
  // keep monotonic (snaps cannot cross) — fall back to prediction on conflict
  lines = lines.map((x, i) => (i > 0 && x <= lines[i - 1] ? pred[i] : x));
  return { period, phase, lines, confidence };
}

/** Detect both axes on a keyed ROI image. */
export function detectGrid(img, opts = {}, autoRange = [4, 64]) {
  const { gx, gy } = edgeProfiles(img);
  const x = detectAxis(gx, opts.x || {}, autoRange);
  const y = detectAxis(gy, opts.y || {}, autoRange);
  return { x, y, confidence: Math.min(x.confidence, y.confidence) };
}
