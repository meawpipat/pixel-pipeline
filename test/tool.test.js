// FR-10 AC: the browser tool's bundled core produces the same sprite as the CLI core,
// checked once in headless Chromium. Skipped when no Chromium is available.
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSprite, LV } from './fixtures.js';
import { encodePng } from '../src/core/png.js';
import { decodeImage } from '../src/core/image.js';
import { processUnit, placeUnits } from '../src/core/pipeline.js';
import { loadConfig } from '../src/cli/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();

async function launch() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return null; }
  const candidates = [process.env.PP_CHROMIUM, undefined];
  for (const executablePath of candidates) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* try next */ }
  }
  return null;
}

function fixturePng() {
  const s = makeSprite(20, 24, 31), F = 9;
  const W = 2 * 22 * F, H = 26 * F, rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let k = 0; k < 2; k++) for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const v = s.I[y * s.w + x]; if (v === 4) continue;
    for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((1 + y + k) * F + py) * W + (k * 22 + 1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; }
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}

test('browser tool: bundled core == CLI core; page renders without errors', async (t) => {
  const browser = await launch();
  if (!browser) { t.skip('no Chromium available (set PP_CHROMIUM to run)'); return; }
  try {
    const pageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pppage-')), 'pixel-tool.html');
    execFileSync(process.execPath, [path.join(root, 'src/tool/build.js'), '--config', FIXTURE_CONFIG, '--out', pageFile], { stdio: 'pipe' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('file://' + pageFile);
    const png = fixturePng();
    const strip = { n: 2 };
    const meta = { species: 'puff', stage: 2, variant: 'base' };
    const params = { tolerance: 60, flood_fill: true, stray_removal: false, auto_outline: false };
    // Node side
    const img = decodeImage(png);
    const res = processUnit(img, params, strip, cfg);
    const node = placeUnits([{ def: { dx: 0, dy: 0, anim: 'walk', frame_start: 0 }, frames: res.frames }], meta, cfg).outputs.map((o) => Array.from(o.canvas.I));
    // Browser side (bundled core)
    const browserOut = await page.evaluate(async ({ bytes, params, strip, meta }) => {
      const P = window.PixelPipe;
      const img = P.decodeImage(new Uint8Array(bytes));
      const res = P.processUnit(img, params, strip, P.cfg, new Map());
      return P.placeUnits([{ def: { dx: 0, dy: 0, anim: 'walk', frame_start: 0 }, frames: res.frames }], meta, P.cfg).outputs.map((o) => Array.from(o.canvas.I));
    }, { bytes: Array.from(png), params, strip, meta });
    assert.deepEqual(browserOut, node);
    // Drive the UI: load the fixture as a file, 2 frames, screenshot.
    await page.evaluate(async (bytes) => { await window.PixelPipe.loadBytes('0123456789abcdef.png', new Uint8Array(bytes)); }, Array.from(png));
    await page.selectOption('#species', 'puff|2');
    await page.fill('#nFrames', '2');
    await page.waitForTimeout(400);
    // FR-10 panel 3 (v3.8, D16): scaled first, then dithered at screen pixels — equals composeScreenFine (= pp_draw, v39)
    const eink = await page.evaluate(() => Array.from(document.getElementById('einkCanvas').getContext('2d').getImageData(0, 0, 200, 200).data.filter((_, i) => i % 4 === 0)));
    const { composeScreenFine } = await import('../src/core/dither.js');
    const want = composeScreenFine({ w: 64, h: 64, I: Uint8Array.from(node[0]) }, cfg, { screen: cfg.preview.screen, scale: cfg.preview.sprite_scale, offset: cfg.preview.sprite_offset });
    assert.deepEqual(eink.map((v) => (v < 128 ? 1 : 0)), Array.from(want));
    await page.click('#modeDialog');
    await page.screenshot({ path: path.join(path.dirname(pageFile), 'tool-screenshot.png') });
    const exportEnabled = await page.isEnabled('#exportBtn');
    assert.ok(exportEnabled, 'export enabled for a valid unit');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
