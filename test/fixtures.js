// Deterministic synthetic fixtures (§8). Nothing binary is committed.
import jpeg from 'jpeg-js';

export const LV = [0, 85, 170, 255];

/** Tiny deterministic PRNG (tests only). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Ground-truth sprite: cw x ch cells, index image (4 = transparent).
 * Blob silhouette with a closed 1-px black outline, three flat tone patches, two eyes.
 */
export function makeSprite(cw, ch, seed = 1) {
  const r = rng(seed);
  const I = new Uint8Array(cw * ch).fill(4);
  const cx = (cw - 1) / 2, cy = (ch - 1) / 2;
  const inside = (x, y) => ((x - cx) / (cw / 2 - 0.5)) ** 2 + ((y - cy) / (ch / 2 - 0.5)) ** 2 <= 1;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (inside(x, y)) I[y * cw + x] = 3;
  // tone patches (horizontal bands with jitter)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (I[y * cw + x] === 4) continue;
    const band = y / ch + (r() - 0.5) * 0.04;
    I[y * cw + x] = band > 0.72 ? 1 : band > 0.5 ? 2 : 3;
  }
  // outline: opaque pixels touching transparency or border
  const O = I.slice();
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (I[y * cw + x] === 4) continue;
    const t = (xx, yy) => xx < 0 || yy < 0 || xx >= cw || yy >= ch || I[yy * cw + xx] === 4;
    if (t(x - 1, y) || t(x + 1, y) || t(x, y - 1) || t(x, y + 1)) O[y * cw + x] = 0;
  }
  // eyes
  const ey = Math.round(ch * 0.35), ex1 = Math.round(cw * 0.35), ex2 = Math.round(cw * 0.65);
  for (const ex of [ex1, ex2]) { O[ey * cw + ex] = 0; O[(ey + 1) * cw + ex] = 0; }
  return { w: cw, h: ch, I: O };
}

/** Upscale by non-integer factor f onto a key-colored canvas with margin. Returns RGBA + truth info. */
export function renderUpscaled(sprite, f, { margin = 37, key = [0, 255, 0], tones = LV } = {}) {
  const W = Math.ceil(sprite.w * f + 2 * margin), H = Math.ceil(sprite.h * f + 2 * margin);
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = (y * W + x) * 4;
    const sx = Math.floor((x + 0.5 - margin) / f), sy = Math.floor((y + 0.5 - margin) / f);
    let c = key;
    if (sx >= 0 && sy >= 0 && sx < sprite.w && sy < sprite.h) {
      const v = sprite.I[sy * sprite.w + sx];
      if (v !== 4) c = [tones[v], tones[v], tones[v]];
    }
    rgba[q] = c[0]; rgba[q + 1] = c[1]; rgba[q + 2] = c[2]; rgba[q + 3] = 255;
  }
  return { w: W, h: H, rgba, truth: { f, margin } };
}

export function jpegRoundTrip(img, quality = 80) {
  const enc = jpeg.encode({ data: Buffer.from(img.rgba), width: img.w, height: img.h }, quality);
  const dec = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
  return { w: dec.width, h: dec.height, rgba: dec.data, bytes: new Uint8Array(enc.data) };
}
