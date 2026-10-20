import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSprite, renderUpscaled, jpegRoundTrip, rng } from './fixtures.js';
import { autoKey, keyImage } from '../src/core/key.js';
import { detectGrid } from '../src/core/grid.js';
import { sampleCells, trimNative } from '../src/core/sample.js';
import { quantize, autoThresholds, thresholdsFromClusters, ditherRatio } from '../src/core/quantize.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { luma } from '../src/core/config.js';
import { sha256 } from '../src/core/sha256.js';
import { createHash } from 'node:crypto';

function runPixelSteps(img) {
  const key = autoKey(img);
  const keyed = keyImage(img, { key, tolerance: 60, floodFill: true, minIsland: 64 });
  const grid = detectGrid(keyed);
  const nat = sampleCells(keyed, grid.x.lines, grid.y.lines);
  const q = quantize(trimNative(nat).img, [43, 128, 213]);
  return { keyed, grid, q };
}

const CASES = [[24, 9.75], [47, 13.3], [60, 21.6], [32, 8]];

for (const [cells, f] of CASES) {
  test(`FR-04/05/06: ${cells} cells x${f} JPEG q80`, () => {
    const truthSprite = makeSprite(cells, cells, cells);
    const up = renderUpscaled(truthSprite, f);
    const img = jpegRoundTrip(up, 80);
    const { grid, q } = runPixelSteps(img);
    // grid accuracy: every true cell centre lies in a detected cell whose centre is within period/8
    for (const [axis, lines] of [['x', grid.x.lines], ['y', grid.y.lines]]) {
      for (let k = 0; k < cells; k++) {
        const tc = 37 + (k + 0.5) * f;
        const j = lines.findIndex((l, i) => i + 1 < lines.length && l <= tc && tc < lines[i + 1]);
        assert.ok(j >= 0, `${axis} cell ${k} not covered`);
        const dc = (lines[j] + lines[j + 1]) / 2;
        assert.ok(Math.abs(dc - tc) <= f / 8, `${axis} cell ${k}: centre off by ${(dc - tc).toFixed(2)} > ${f / 8}`);
      }
    }
    // pixel match after quantization
    const tL = new Int16Array(truthSprite.I.length);
    truthSprite.I.forEach((v, i) => { tL[i] = v === 4 ? -1 : v; });
    const truth = trimNative({ w: cells, h: cells, L: tL }).img;
    assert.equal(q.w, truth.w); assert.equal(q.h, truth.h);
    let same = 0, outlineBad = 0;
    for (let i = 0; i < q.I.length; i++) {
      const t = truth.L[i] < 0 ? 4 : truth.L[i];
      if (q.I[i] === t) same++;
      else if (t === 0) outlineBad++;
    }
    assert.ok(same / q.I.length >= 0.98, `match ${(100 * same / q.I.length).toFixed(1)}%`);
    assert.equal(outlineBad, 0, 'outline pixels must all match');
  });
}

test('FR-03: key-colored eye survives flood fill; 5x5 speck removed; empty ROI errors', () => {
  const W = 120, H = 120, rgba = new Uint8Array(W * H * 4);
  const set = (x, y, c) => { const q = (y * W + x) * 4; rgba[q] = c[0]; rgba[q + 1] = c[1]; rgba[q + 2] = c[2]; rgba[q + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [0, 255, 0]);
  for (let y = 30; y < 90; y++) for (let x = 30; x < 90; x++) set(x, y, [255, 255, 255]);
  for (let y = 50; y < 60; y++) for (let x = 50; x < 60; x++) set(x, y, [0, 250, 5]); // key-colored eye inside
  for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) set(x, y, [0, 0, 0]); // speck
  const k = keyImage({ w: W, h: H, rgba }, { key: [0, 255, 0], tolerance: 60, floodFill: true, minIsland: 64 });
  assert.equal(k.rgba[(55 * W + 55) * 4 + 3], 255, 'eye stays opaque');
  assert.equal(k.rgba[(7 * W + 7) * 4 + 3], 0, 'speck removed');
  const empty = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { empty[i * 4 + 1] = 255; empty[i * 4 + 3] = 255; }
  assert.throws(() => keyImage({ w: W, h: H, rgba: empty }, { key: [0, 255, 0] }), /ROI is empty after keying/);
});

test('FR-06 Auto: 3 tones → {0,2,3}; clusters 100/120 → 85/170', () => {
  const L = new Int16Array(300);
  for (let i = 0; i < 300; i++) L[i] = i < 100 ? 3 : i < 200 ? 168 : 250;
  const nat = { w: 300, h: 1, L };
  const a = autoThresholds(nat);
  const q = quantize(nat, a.thresholds);
  assert.deepEqual([...new Set(q.I)].sort(), [0, 2, 3]);
  assert.deepEqual(thresholdsFromClusters([100, 120]).levels, [85, 170]);
});

test('FR-06 detector: checker + dot lattice trigger, flat does not', () => {
  const mk = (fn) => { const w = 16, h = 16, I = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[y * w + x] = fn(x, y); return { w, h, I }; };
  assert.ok(ditherRatio(mk((x, y) => ((x + y) & 1 ? 0 : 3))) > 0.05);
  assert.ok(ditherRatio(mk((x, y) => (x % 2 === 0 && y % 2 === 0 ? 0 : 3))) > 0.05);
  assert.equal(ditherRatio(mk(() => 2)), 0);
});

test('luma = exact half-up rounding', () => {
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 3) for (let b = 0; b < 256; b += 51) {
    const exact = (299 * r + 587 * g + 114 * b) / 1000;
    assert.equal(luma(r, g, b), Math.floor(exact + 0.5));
  }
});

test('PNG codec: canonical indexed round-trip + deterministic bytes', () => {
  const w = 64, h = 64, I = new Uint8Array(w * h);
  for (let i = 0; i < I.length; i++) I[i] = (i * 7) % 5;
  const opts = { w, h, colorType: 3, bitDepth: 8, data: I, palette: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255], [255, 0, 255]], trns: [255, 255, 255, 255, 0] };
  const a = encodePng(opts), b = encodePng(opts);
  assert.deepEqual(a, b);
  const d = decodePng(a);
  assert.deepEqual(d.indexed.data, I);
  assert.equal(I[2], 4); assert.equal(d.rgba[2 * 4 + 3], 0); // index 4 → transparent
});

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000)]) assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'));
});

test('FR-04: generator rendered at half size then upscaled x2 (2-px lattice) still finds the art grid', () => {
  const s = makeSprite(30, 30, 41);
  const half = renderUpscaled(s, 4.875, { margin: 19 });
  const r = rng(7); // render noise ±12 that the x2 upscale turns into a 2-px lattice
  for (let i = 0; i < half.w * half.h; i++) { const n = Math.round((r() - 0.5) * 24); for (let c = 0; c < 3; c++) half.rgba[i * 4 + c] = Math.max(0, Math.min(255, half.rgba[i * 4 + c] + n)); }
  const W = half.w * 2, H = half.h * 2, rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set(half.rgba.subarray(((y >> 1) * half.w + (x >> 1)) * 4, ((y >> 1) * half.w + (x >> 1)) * 4 + 4), (y * W + x) * 4);
  const img = jpegRoundTrip({ w: W, h: H, rgba }, 85);
  const { grid, q } = runPixelSteps(img);
  assert.ok(Math.abs(grid.x.period - 9.75) < 0.1 && Math.abs(grid.y.period - 9.75) < 0.1, `period ${grid.x.period} / ${grid.y.period}`);
  assert.ok(grid.confidence >= 0.6);
  assert.ok(q.w >= 26 && q.w <= 30);
});
