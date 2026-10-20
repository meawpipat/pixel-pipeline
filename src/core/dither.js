// §2.4 dither tiles + anchors (composeScreenFine = the D16 screen-pixel rule; ditherCanvas/composeScreen = the s = 1 test oracle), §6 mask packing.
import { TRANSPARENT } from './config.js';

const mod2 = (v) => ((v % 2) + 2) % 2;

/** Reference point of a canvas frame: bottom-centre of its opaque bbox. */
export function canvasReference(c) {
  let l = Infinity, r = -1, b = -1;
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (c.I[y * c.w + x] !== TRANSPARENT) {
    if (x < l) l = x; if (x > r) r = x; if (y > b) b = y;
  }
  return r < 0 ? [0, 0] : [Math.floor((l + r) / 2), b];
}

/**
 * Index canvas → { ink, mask } as Uint8Array(w*h) of 0/1 bits.
 * anchor: 'canvas' → (0,0); 'sprite' → frame reference point.
 */
export function ditherCanvas(c, cfg, anchor = 'canvas') {
  const [ax, ay] = anchor === 'sprite' ? canvasReference(c) : [0, 0];
  const tiles = cfg.dither.tiles;
  const ink = new Uint8Array(c.w * c.h), mask = new Uint8Array(c.w * c.h);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const i = y * c.w + x, v = c.I[i];
    if (v === TRANSPARENT) continue;
    mask[i] = 1;
    ink[i] = tiles[String(v)][mod2(y - ay)][mod2(x - ax)];
  }
  return { w: c.w, h: c.h, ink, mask };
}

/** Pack a 0/1 plane: row-major, 8 px per byte, MSB = leftmost. */
export function packPlane(bits, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  return out;
}

export function unpackPlane(bytes, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = (bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  return bits;
}

/** Compose a 1-bit sprite onto a white screen (preview only, §2.5). Returns Uint8Array(sw*sh) of ink bits. */
export function composeScreen(d, { screen = [200, 200], scale = 3, offset = [4, 4], dialogHeight = 0 } = {}) {
  const [sw, sh] = screen;
  const out = new Uint8Array(sw * sh);
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    const i = y * d.w + x;
    if (!d.mask[i]) continue;
    for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) {
      const X = offset[0] + x * scale + px, Y = offset[1] + y * scale + py;
      if (X >= 0 && Y >= 0 && X < sw && Y < sh) out[Y * sw + X] = d.ink[i];
    }
  }
  return drawDialog(out, sw, sh, dialogHeight);
}

function drawDialog(out, sw, sh, dialogHeight) {
  if (dialogHeight > 0) { // style A (D9): white box, 1-px black outline, bottom overlay
    const top = sh - dialogHeight;
    for (let Y = top; Y < sh; Y++) for (let X = 0; X < sw; X++) out[Y * sw + X] = Y === top || Y === sh - 1 || X === 0 || X === sw - 1 ? 1 : 0;
  }
  return out;
}

/**
 * §2.4 (v3.8, D16): scale the 4-level index canvas first, then dither each screen pixel with the §2.4 tiles, phase relative
 * to the sprite origin — the same rule as pp_draw in the exported C header. Used by the E-Ink preview.
 * anchor 'sprite' shifts the tile phase by the frame reference point (scaled), like ditherCanvas.
 */
export function composeScreenFine(c, cfg, { screen = [200, 200], scale = 3, offset = [4, 4], dialogHeight = 0, anchor = 'canvas' } = {}) {
  const [sw, sh] = screen;
  const [ax, ay] = anchor === 'sprite' ? canvasReference(c) : [0, 0];
  const tiles = cfg.dither.tiles;
  const out = new Uint8Array(sw * sh);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const v = c.I[y * c.w + x];
    if (v === TRANSPARENT) continue;
    const t = tiles[String(v)];
    for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) {
      const X = offset[0] + x * scale + px, Y = offset[1] + y * scale + py;
      if (X >= 0 && Y >= 0 && X < sw && Y < sh) out[Y * sw + X] = t[mod2((y - ay) * scale + py)][mod2((x - ax) * scale + px)];
    }
  }
  return drawDialog(out, sw, sh, dialogHeight);
}
