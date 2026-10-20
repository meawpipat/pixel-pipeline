// FR-06 grey quantization, Auto thresholds, dither-in-input detector.
// Index image: { w, h, I: Uint8Array } with 0..3 palette, 4 transparent.
import { TRANSPARENT } from './config.js';

const LEVELS = [0, 85, 170, 255];

export function quantize(nat, [t1, t2, t3]) {
  const I = new Uint8Array(nat.w * nat.h);
  for (let i = 0; i < I.length; i++) {
    const L = nat.L[i];
    I[i] = L < 0 ? TRANSPARENT : L < t1 ? 0 : L < t2 ? 1 : L < t3 ? 2 : 3;
  }
  return { w: nat.w, h: nat.h, I };
}

export function histogram(nat) {
  const h = new Uint32Array(256);
  for (const L of nat.L) if (L >= 0) h[L]++;
  return h;
}

/** Auto thresholds (FR-06). Returns { thresholds:[t1,t2,t3], levels:number[], means:number[] }. */
export function autoThresholds(nat, mergeLuma = 20) {
  const vals = [];
  for (const L of nat.L) if (L >= 0) vals.push(L);
  if (!vals.length) return { thresholds: [43, 128, 213], levels: [], means: [] };
  // 1-D k-means, init 0/85/170/255, ≤50 iterations or until no assignment changes.
  let means = LEVELS.slice();
  let assign = new Int8Array(vals.length).fill(-1);
  for (let it = 0; it < 50; it++) {
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < means.length; k++) {
        if (means[k] == null) continue;
        const d = Math.abs(vals[i] - means[k]);
        if (d < bd) { bd = d; bk = k; }
      }
      if (assign[i] !== bk) { assign[i] = bk; changed = true; }
    }
    const sum = new Float64Array(4), cnt = new Uint32Array(4);
    for (let i = 0; i < vals.length; i++) { sum[assign[i]] += vals[i]; cnt[assign[i]]++; }
    means = means.map((m, k) => (cnt[k] ? sum[k] / cnt[k] : null));
    if (!changed) break;
  }
  // Drop empty clusters, merge clusters within mergeLuma (weighted by size).
  const cnt = new Uint32Array(4);
  for (let i = 0; i < vals.length; i++) cnt[assign[i]]++;
  let cl = means.map((m, k) => ({ m, n: cnt[k] })).filter((c) => c.m != null && c.n > 0).sort((a, b) => a.m - b.m);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i + 1 < cl.length; i++) {
      if (cl[i + 1].m - cl[i].m < mergeLuma) {
        const n = cl[i].n + cl[i + 1].n;
        cl.splice(i, 2, { m: (cl[i].m * cl[i].n + cl[i + 1].m * cl[i + 1].n) / n, n });
        merged = true; break;
      }
    }
  }
  return thresholdsFromClusters(cl.map((c) => c.m));
}

/** Map sorted cluster means to palette levels (order-preserving, min total distance, ties darker) and derive thresholds. */
export function thresholdsFromClusters(means) {
  const cl = means.slice().sort((a, b) => a - b).map((m) => ({ m }));
  // Order-preserving assignment to levels minimising total |mean − level|; ties → darker.
  const k = cl.length;
  let best = null;
  const choose = (start, depth, acc) => {
    if (depth === k) {
      const cost = acc.reduce((s, lv, i) => s + Math.abs(cl[i].m - LEVELS[lv]), 0);
      if (!best || cost < best.cost - 1e-9) best = { cost, lv: acc.slice() };
      return;
    }
    for (let lv = start; lv <= 4 - (k - depth); lv++) { acc.push(lv); choose(lv + 1, depth + 1, acc); acc.pop(); }
  };
  choose(0, 0, []); // lexicographic order explores darker assignments first → ties keep darker
  const used = best.lv; // level index per cluster, increasing
  // Thresholds t1..t3 separate levels 0|1, 1|2, 2|3.
  const t = [0, 0, 0];
  for (let b = 0; b < 3; b++) {
    // boundary between level b and b+1
    const below = used.map((lv, i) => (lv <= b ? i : -1)).filter((i) => i >= 0);
    const above = used.map((lv, i) => (lv > b ? i : -1)).filter((i) => i >= 0);
    if (!below.length) t[b] = 0;
    else if (!above.length) t[b] = 256;
    else {
      const ia = below[below.length - 1], ib = above[0];
      t[b] = Math.ceil((cl[ia].m + cl[ib].m) / 2);
    }
  }
  return { thresholds: t, levels: used.map((lv) => LEVELS[lv]), means: cl.map((c) => c.m) };
}

/** Dither-in-input detector: ratio of opaque pixels in checker or dot-lattice patterns. */
export function ditherRatio(q) {
  const { w, h, I } = q;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? TRANSPARENT : I[y * w + x]);
  const flag = new Uint8Array(w * h);
  let opaque = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = at(x, y);
    if (v === TRANSPARENT) continue;
    opaque++;
    // (a) 2x2 checker with this pixel at top-left
    const b = at(x + 1, y), c = at(x, y + 1), d = at(x + 1, y + 1);
    if (b !== TRANSPARENT && c !== TRANSPARENT && d !== TRANSPARENT && v === d && b === c && v !== b) {
      flag[y * w + x] = flag[y * w + x + 1] = flag[(y + 1) * w + x] = flag[(y + 1) * w + x + 1] = 1;
    }
    // (b) dot lattice
    const n4 = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
    if (n4.every((u) => u === n4[0]) && n4[0] !== v && n4[0] !== TRANSPARENT &&
        at(x - 2, y) === v && at(x + 2, y) === v && at(x, y - 2) === v && at(x, y + 2) === v) flag[y * w + x] = 1;
  }
  let f = 0;
  for (let i = 0; i < w * h; i++) if (flag[i] && I[i] !== TRANSPARENT) f++;
  return opaque ? f / opaque : 0;
}
