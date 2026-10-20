// FR-02 ROI crop + FR-03 background keying at full resolution.

/** Crop RGBA to ROI {x,y,w,h} (clamped). Returns { w, h, rgba }. */
export function cropRoi(img, roi) {
  const x0 = Math.max(0, Math.floor(roi.x)), y0 = Math.max(0, Math.floor(roi.y));
  const x1 = Math.min(img.w, Math.floor(roi.x + roi.w)), y1 = Math.min(img.h, Math.floor(roi.y + roi.h));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(img.rgba.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1) * 4), y * w * 4);
  return { w, h, rgba };
}

/** Most common exact RGB along the border (opaque pixels only). Ties → smallest packed value. */
export function autoKey(img) {
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * img.w + x) * 4;
    if (img.rgba[i + 3] < 128) return;
    const k = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (let x = 0; x < img.w; x++) { add(x, 0); if (img.h > 1) add(x, img.h - 1); }
  for (let y = 1; y < img.h - 1; y++) { add(0, y); if (img.w > 1) add(img.w - 1, y); }
  let best = null, bestN = -1;
  for (const [k, n] of counts) if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
  if (best === null) return null;
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

/**
 * Key the image. Returns { w, h, rgba } with alpha forced to 0/255.
 * opts: { key:[r,g,b], tolerance, floodFill, minIsland }
 */
export function keyImage(img, { key, tolerance = 60, floodFill = true, minIsland = 64 }) {
  const { w, h } = img;
  const n = w * h;
  const rgba = new Uint8Array(img.rgba);
  const tol2 = tolerance * tolerance;
  const isKey = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = i * 4;
    if (rgba[q + 3] < 128) { isKey[i] = 1; continue; } // already transparent counts as background
    const dr = rgba[q] - key[0], dg = rgba[q + 1] - key[1], db = rgba[q + 2] - key[2];
    if (dr * dr + dg * dg + db * db <= tol2) isKey[i] = 1;
  }
  const transparent = new Uint8Array(n);
  if (floodFill) {
    const stack = [];
    const push = (i) => { if (isKey[i] && !transparent[i]) { transparent[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
  } else {
    transparent.set(isKey);
  }
  // Island removal: opaque 4-connected components smaller than minIsland.
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (transparent[s] || seen[s]) continue;
    const comp = [s]; seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], x = i % w, y = (i / w) | 0;
      const nb = [];
      if (x > 0) nb.push(i - 1); if (x < w - 1) nb.push(i + 1);
      if (y > 0) nb.push(i - w); if (y < h - 1) nb.push(i + w);
      for (const j of nb) if (!transparent[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
    }
    if (comp.length < minIsland) for (const i of comp) transparent[i] = 1;
  }
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    rgba[i * 4 + 3] = transparent[i] ? 0 : 255;
    if (!transparent[i]) opaque++;
  }
  if (opaque === 0) throw new Error('ROI is empty after keying');
  return { w, h, rgba };
}
