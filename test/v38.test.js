// v3.7.1: collapsible message panel
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function launch() {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return null; }
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* try next */ }
  }
  return null;
}

test('message panel collapses/expands, keeps a count summary, remembers the state', async (t) => {
  const browser = await launch();
  if (!browser) { t.skip('no Chromium available (set PP_CHROMIUM to run)'); return; }
  try {
    const pageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pppage-')), 'pixel-tool.html');
    execFileSync(process.execPath, [path.join(root, 'src/tool/build.js'), '--config', FIXTURE_CONFIG, '--out', pageFile], { stdio: 'pipe' });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = 'file://' + pageFile;
    await page.goto(url);
    assert.equal(await page.getAttribute('#msgToggle', 'aria-expanded'), 'true');
    assert.ok(await page.isVisible('#messages'));
    assert.equal(await page.textContent('#msgCount'), 'OK');
    const h0 = await page.evaluate(() => document.getElementById('msgPanel').getBoundingClientRect().height);
    await page.click('#msgToggle');
    assert.equal(await page.getAttribute('#msgToggle', 'aria-expanded'), 'false');
    assert.ok(!(await page.isVisible('#messages')));
    assert.ok(await page.isVisible('#msgCount'));
    const h1 = await page.evaluate(() => document.getElementById('msgPanel').getBoundingClientRect().height);
    assert.ok(h1 <= h0, `${h1} <= ${h0}`);
    await page.reload();
    assert.equal(await page.getAttribute('#msgToggle', 'aria-expanded'), 'false', 'state remembered');
    await page.click('#msgToggle');
    assert.ok(await page.isVisible('#messages'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('v3.7.2 composeScreenFine: scale 1 equals the 1-bit export; at scale 3 grey becomes a screen-pixel pattern', async () => {
  const { ditherCanvas, composeScreen, composeScreenFine } = await import('../src/core/dither.js');
  const { loadConfig } = await import('../src/cli/store.js');
  const cfg = loadConfig();
  const I = new Uint8Array(64 * 64).fill(4);
  for (let y = 40; y < 61; y++) for (let x = 20; x < 44; x++) I[y * 64 + x] = (x + y) % 4; // all four levels
  const c = { w: 64, h: 64, I };
  for (const anchor of ['canvas', 'sprite']) {
    const o = { screen: [200, 200], scale: 1, offset: [4, 4] };
    assert.deepEqual(composeScreenFine(c, cfg, { ...o, anchor }), composeScreen(ditherCanvas(c, cfg, anchor), o), anchor);
  }
  const s = composeScreenFine(c, cfg, { screen: [200, 200], scale: 3, offset: [4, 4] });
  const block = (x, y) => { const r = []; for (let py = 0; py < 3; py++) for (let px = 0; px < 3; px++) r.push(s[(4 + y * 3 + py) * 200 + 4 + x * 3 + px]); return r.join(''); };
  // (x+y)%4: (20,40)→0 black, (21,40)→1 dark grey, (22,40)→2 light grey, (23,40)→3 white
  assert.equal(block(20, 40), '111111111');
  assert.equal(block(21, 40).replace(/0/g, '').length >= 4 && block(21, 40).replace(/0/g, '').length <= 5, true);
  assert.ok(/^[01]{9}$/.test(block(22, 40)) && block(22, 40).replace(/0/g, '').length <= 4 && block(22, 40).includes('1'));
  assert.equal(block(23, 40), '000000000');
  // the dark grey block is a checkerboard at screen pixels, not one big 3x3 cell
  const b = block(21, 40); assert.notEqual(b[0], b[1]);
  // dialog overlay still drawn
  const d = composeScreenFine(c, cfg, { screen: [200, 200], scale: 3, offset: [4, 4], dialogHeight: 36 });
  assert.equal(d[164 * 200 + 50], 1); assert.equal(d[180 * 200 + 50], 0);
});
