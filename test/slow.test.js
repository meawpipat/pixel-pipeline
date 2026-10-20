// Opt-in heavier checks (run with PP_SLOW=1): the 70-case grid sweep, and a real AI
// image that lives in the project root (skipped when absent).
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSprite, renderUpscaled, jpegRoundTrip } from './fixtures.js';
import { autoKey, keyImage } from '../src/core/key.js';
import { detectGrid } from '../src/core/grid.js';
import { sampleCells, trimNative } from '../src/core/sample.js';
import { quantize } from '../src/core/quantize.js';
import { decodeImage } from '../src/core/image.js';
import { processUnit } from '../src/core/pipeline.js';
import { loadConfig } from '../src/cli/store.js';

const slow = process.env.PP_SLOW === '1';
const here = path.dirname(fileURLToPath(import.meta.url));

test('grid sweep: 7 sizes × 10 scales via JPEG q80 (≥98% pixels, all outlines)', { skip: !slow && 'set PP_SLOW=1' }, () => {
  const fails = [];
  for (const cells of [16, 24, 32, 40, 47, 52, 60]) for (const f of [8, 8.6, 9.75, 11.2, 13.3, 16.5, 21.6, 27.1, 33.3, 39.5]) {
    if (cells * f > 3900) continue;
    const t = makeSprite(cells, cells, cells * 7 + Math.round(f * 10));
    const img = jpegRoundTrip(renderUpscaled(t, f), 80);
    const k = keyImage(img, { key: autoKey(img) });
    const g = detectGrid(k);
    const q = quantize(trimNative(sampleCells(k, g.x.lines, g.y.lines)).img, [43, 128, 213]);
    const tL = new Int16Array(t.I.length); t.I.forEach((v, i) => { tL[i] = v === 4 ? -1 : v; });
    const tr = trimNative({ w: cells, h: cells, L: tL }).img;
    let same = 0, outline = 0;
    if (q.w === tr.w && q.h === tr.h) for (let i = 0; i < q.I.length; i++) { const tv = tr.L[i] < 0 ? 4 : tr.L[i]; if (q.I[i] === tv) same++; else if (tv === 0) outline++; }
    if (q.w !== tr.w || q.h !== tr.h || same / q.I.length < 0.98 || outline) fails.push(`${cells}@${f}`);
  }
  assert.deepEqual(fails, []);
});

test('real AI image (PIXELPIPE_SAMPLE_IMAGE): grid found with confidence ≥ 0.6 (period ≈ PIXELPIPE_SAMPLE_PERIOD if set)', (t) => {
  const file = process.env.PIXELPIPE_SAMPLE_IMAGE;
  if (!file || !fs.existsSync(file)) { t.skip('set PIXELPIPE_SAMPLE_IMAGE (optional: PIXELPIPE_SAMPLE_ROI=x,y,w,h, PIXELPIPE_SAMPLE_PERIOD) to run'); return; }
  const cfg = loadConfig();
  const img = decodeImage(new Uint8Array(fs.readFileSync(file)));
  const roiEnv = (process.env.PIXELPIPE_SAMPLE_ROI || '').split(',').map(Number);
  const roi = roiEnv.length === 4 && roiEnv.every(Number.isFinite) ? { x: roiEnv[0], y: roiEnv[1], w: roiEnv[2], h: roiEnv[3] } : null;
  const r = processUnit(img, { roi, key: [255, 0, 255], tolerance: 1, flood_fill: true }, { n: 1 }, cfg); // grid test only
  const want = Number(process.env.PIXELPIPE_SAMPLE_PERIOD);
  if (want) assert.ok(Math.abs(r.resolved.grid.x.period - want) < 0.2 && Math.abs(r.resolved.grid.y.period - want) < 0.2, JSON.stringify(r.resolved.grid));
  assert.ok(r.resolved.confidence >= 0.6, `confidence ${r.resolved.confidence}`);
});
