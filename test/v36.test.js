// Spec v3.6: Edit unit (fixture 21), frame selection (22), settings from another unit (23), Copy to animation (24).
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { cmdArchiveBytes, cmdAddFragment, cmdRebuild } from '../src/cli/commands.js';
import { cmdPromote, cmdValidate, cmdRetranslate } from '../src/cli/commands3.js';
import { cmdCleanSave } from '../src/cli/cleansave.js';
import { cmdUnitRemove } from '../src/cli/remove.js';
import { loadConfig, readJson, sha256File } from '../src/cli/store.js';
import { startServer, loadPage } from '../src/server/serve.js';

const cfg = loadConfig();
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp36-'));
/** A strip of n sprites; `blank` segments left empty. Non-integer scale F so the auto grid has a non-round period. */
function stripPng(cw, ch, seed, n, { F = 10, blank = [] } = {}) {
  const CW = n * (cw + 2), CH = ch + 3; // cell image, then upscaled by F (may be non-integer)
  const cells = new Int16Array(CW * CH).fill(-1);
  for (let k = 0; k < n; k++) {
    if (blank.includes(k)) continue;
    const s = makeSprite(cw - (k % 2), ch, seed + k);
    for (let y = 0; y < ch; y++) for (let x = 0; x < s.w; x++) { const v = s.I[y * s.w + x]; if (v !== 4) cells[(y + 2) * CW + k * (cw + 2) + 1 + x] = v; }
  }
  const W = Math.round(CW * F), H = Math.round(CH * F);
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = cells[Math.min(CH - 1, Math.floor(y / F)) * CW + Math.min(CW - 1, Math.floor(x / F))], q = (y * W + x) * 4;
    if (v < 0) { rgba[q + 1] = 255; } else { rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; }
    rgba[q + 3] = 255;
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
function add(root, { id = 'u1', anim = 'idle', seed = 70, n = 4, use, start = 0, blank = [], yes = false, png, params = {} } = {}) {
  const a = cmdArchiveBytes(root, png || stripPng(16, 18, seed, n, { blank }), 'blob', { allowExisting: true });
  return cmdAddFragment(root, { species: 'blob', stage: 1, variant: 'base', unit: { id, source: a.path, source_sha256: a.sha256, anim, frame_start: start, strip: { n, ...(use ? { use } : {}) }, params } }, { yes });
}
const R = (root) => path.join(root, 'art/raw/blob');
const C = (root) => path.join(root, 'art/clean/blob');
const batch = (root) => readJson(path.join(R(root), 'blob_s1.batch.json'));

test('fixture 22: use [0, 2, 3] → frames 00–02 from segments 0, 2, 3; positional sidecar frame; rebuild byte-identical; U ignores segment 1', () => {
  const root = tmpRoot();
  add(root, { use: [0, 2, 3] });
  const u = batch(root).units[0];
  assert.deepEqual(u.strip.use, [0, 2, 3]);
  assert.deepEqual(u.frames.map((f) => [f.name, f.segment]), [['blob_s1_idle_00.png', 0], ['blob_s1_idle_01.png', 2], ['blob_s1_idle_02.png', 3]]);
  assert.deepEqual([0, 1, 2].map((i) => readJson(path.join(R(root), `blob_s1_idle_0${i}.json`)).frame), [0, 1, 2]);
  assert.equal(readJson(path.join(R(root), 'blob_s1_idle_01.json')).segment, 2);
  assert.deepEqual(cmdRebuild(root, 'blob_s1', { check: true }).mismatches, []);
  // the same strip with all segments: segment 2's frame lands at the same G (canvas position) — leaving 1 out moves nothing in G
  const all = tmpRoot(); add(all);
  const T1 = batch(root).T, T2 = batch(all).T;
  const bb = (p) => { const I = decodePng(new Uint8Array(fs.readFileSync(p))).indexed.data; let x0 = 64, y0 = 64; for (let i = 0; i < 4096; i++) if (I[i] !== 4) { x0 = Math.min(x0, i % 64); y0 = Math.min(y0, (i / 64) | 0); } return [x0, y0]; };
  const a = bb(path.join(R(root), 'blob_s1_idle_01.png')), b = bb(path.join(R(all), 'blob_s1_idle_02.png'));
  assert.deepEqual([a[0] - T1[0], a[1] - T1[1]], [b[0] - T2[0], b[1] - T2[1]], 'same G');
});

test('fixture 22: an empty unused segment is fine; empty segment 0 → anchor message; bad use lists refused', () => {
  const root = tmpRoot();
  add(root, { use: [0, 2, 3], blank: [1] });
  assert.equal(batch(root).units[0].frames.length, 3);
  const r2 = tmpRoot();
  assert.throws(() => add(r2, { use: [1, 2, 3], blank: [0] }), /segment 0 anchors the unit/);
  for (const use of [[], [3, 1], [5], [1, 1]]) assert.throws(() => add(tmpRoot(), { use }), Error, JSON.stringify(use));
});

test('fixture 22: unit-remove moves a later unit with used segments down to contiguous names', () => {
  const root = tmpRoot();
  add(root, { n: 2 });
  add(root, { id: 'u3', seed: 90, n: 3, use: [0, 2], start: 2 });
  cmdPromote(root, 'blob_s1');
  const r = cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true });
  assert.deepEqual(r.renamed_raw, { 'blob_s1_idle_02.png': 'blob_s1_idle_00.png', 'blob_s1_idle_03.png': 'blob_s1_idle_01.png' });
  const u3 = batch(root).units[0];
  assert.deepEqual(u3.frames.map((f) => [f.name, f.segment]), [['blob_s1_idle_00.png', 0], ['blob_s1_idle_01.png', 2]]);
  assert.equal(readJson(path.join(R(root), 'blob_s1_idle_01.json')).frame, 1);
  if (r.retranslate_needed) cmdRetranslate(root, 'blob_s1', { yes: true });
  assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0, cmdValidate(root, 'blob_s1').fails.join('\n'));
  assert.deepEqual(cmdRebuild(root, 'blob_s1', { check: true }).mismatches, []);
});

test('fixture 21: replace rule — dropping any raw frame name is refused, growing is fine; orphans stay editable', () => {
  const root = tmpRoot();
  add(root);
  cmdPromote(root, 'blob_s1');
  assert.throws(() => add(root, { use: [0, 1, 2], yes: true }), /would no longer produce blob_s1_idle_03\.png.*remove the unit/);
  assert.throws(() => add(root, { anim: 'happy', yes: true }), /would no longer produce/);
  add(root, { use: [0, 1, 3, 2].sort(), seed: 71, yes: true }); // same names, other pixels → allowed
  const r2 = tmpRoot();
  add(r2); // never promoted: shrinking is still Remove + Add
  assert.throws(() => add(r2, { use: [0, 1], yes: true }), /would no longer produce/);
  add(r2, { n: 5, seed: 72, yes: true }); // growing is fine
  assert.equal(batch(r2).units[0].frames.length, 5);
  // a pre-v3.6 orphan entry (raw_name no longer in the batch) does not block clean-save
  const p = readJson(path.join(C(root), 'blob_s1.placement.json'));
  p.files['blob_s1_idle_03.png'].raw_name = 'blob_s1_idle_09.png';
  fs.writeFileSync(path.join(C(root), 'blob_s1.placement.json'), JSON.stringify(p));
  const names = fs.readdirSync(C(root)).filter((f) => f.endsWith('.png')).sort();
  const loaded = Object.fromEntries(names.map((n) => [n, sha256File(path.join(C(root), n))]));
  const frames = names.map((n) => ({ name: n, from: n, I: Array.from(decodePng(new Uint8Array(fs.readFileSync(path.join(C(root), n)))).indexed.data), entry: p.files[n] }));
  frames[0].I[frames[0].I.findIndex((v) => v !== 4)] = 1;
  const r = cmdCleanSave(root, 'blob_s1', { frames, loaded, loaded_placement_sha256: sha256File(path.join(C(root), 'blob_s1.placement.json')) });
  assert.ok(r.written.includes('blob_s1_idle_00.png'));
  assert.ok(cmdValidate(root, 'blob_s1').warns.some((w) => /orphan/.test(w)));
});

async function chromium(t) {
  let pw; try { pw = await import('playwright-core'); } catch { t.skip('playwright-core missing'); return null; }
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { return await pw.chromium.launch(executablePath ? { executablePath } : {}); } catch { /* next */ }
  }
  t.skip('no Chromium'); return null;
}

test('fixtures 21, 23, 24 in Chromium: Edit unit is byte-identical; Add unchanged rewrites nothing; settings from; Copy to animation', async (t) => {
  const root = tmpRoot();
  add(root, { png: stripPng(16, 18, 70, 4, { F: 9.7 }) }); // auto grid with a non-round period
  add(root, { id: 'u2', anim: 'happy', n: 3, use: [0, 2], seed: 50, png: stripPng(16, 18, 50, 3, { F: 9.7 }) });
  add(root, { id: 'u5', anim: 'happy', n: 1, start: 2, seed: 20, png: stripPng(16, 18, 20, 1, { F: 9.7 }), params: { fallback_target_h: 17 } });
  add(root, { id: 'u6', anim: 'happy', n: 1, start: 3, seed: 21, png: stripPng(16, 18, 21, 1, { F: 9.7 }), params: { grid: { x: { period: 9.7, phase: 0.35, snapping: false }, y: { period: 9.7, phase: 0.2, snapping: false } }, tolerance: 40 } });
  cmdPromote(root, 'blob_s1');
  const rawBefore = Object.fromEntries(fs.readdirSync(R(root)).filter((f) => f.endsWith('.png')).map((f) => [f, sha256File(path.join(R(root), f))]));
  const browser = await chromium(t); if (!browser) return;
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForSelector('#unitList .unit');
    assert.match(await page.textContent('#unitList'), /u2happy 00–01 \(frames 1, 3 of 3\)/);
    for (const unit of ['u1', 'u5', 'u6', 'u2']) {
      await page.locator('#unitList .unit', { hasText: unit }).locator('button', { hasText: 'Edit unit' }).click();
      await page.waitForFunction((u) => document.getElementById('editLabel').textContent.includes(`unit ${u}`) && !document.getElementById('addBtn').disabled, unit);
      assert.equal(await page.isDisabled('#species'), true);
      assert.equal(await page.isDisabled('#dx'), true, 'Offset locked in edit mode');
      // the preview frames equal the raw frames byte for byte
      const outs = await page.evaluate(() => { const S = window.PixelPipe.state; return S.placed.outputs.filter((o) => o.unitIndex === S.placed.currentIndex).map((o) => ({ name: o.name, I: Array.from(o.canvas.I) })); });
      for (const o of outs) assert.deepEqual(o.I, Array.from(decodePng(new Uint8Array(fs.readFileSync(path.join(R(root), o.name)))).indexed.data), `${unit} ${o.name}`);
    }
    // Add with nothing changed (still editing u2) → no raw file changes
    await page.click('#addBtn');
    await page.waitForSelector('#confirmDlg[open]');
    await page.click('#confirmOk');
    await page.waitForFunction(() => /Added unit "u2"/.test(document.getElementById('messages').textContent));
    const rawAfter = Object.fromEntries(fs.readdirSync(R(root)).filter((f) => f.endsWith('.png')).map((f) => [f, sha256File(path.join(R(root), f))]));
    assert.deepEqual(rawAfter, rawBefore, 'Add after Edit unit with nothing changed rewrites no raw bytes');
    assert.equal(await page.isHidden('#editBanner'), true);
    // settings from another unit
    await page.waitForFunction(() => document.body.classList.contains('editor-mode')); // Add opens the editor
    await page.click('#viewConv');
    await page.evaluate(async (b) => { await window.PixelPipe.loadBytes('new_pose.png', new Uint8Array(b)); }, Array.from(stripPng(16, 18, 33, 1, { F: 9.7 })));
    const nBefore = await page.evaluate(() => window.PixelPipe.state.strip.n);
    await page.click('#settingsFrom');
    await page.waitForSelector('#choiceDlg[open]');
    await page.click('#choiceBtns button[data-value="blob_s1/u1"]');
    await page.waitForFunction(() => /Using the settings of blob_s1\/u1/.test(document.getElementById('messages').textContent));
    const st = await page.evaluate(() => ({ mode: window.PixelPipe.state.gridMode, grid: window.PixelPipe.state.params.grid, th: window.PixelPipe.state.params.thresholds, n: window.PixelPipe.state.strip.n }));
    const sc = readJson(path.join(R(root), 'blob_s1_idle_00.json'));
    assert.equal(st.mode, 'manual'); assert.deepEqual(st.grid, sc.grid); assert.deepEqual(st.th, sc.thresholds); assert.equal(st.n, nBefore, 'frame count not copied');
    // Copy to animation in the Clean Editor
    await page.selectOption('#groupSel', 'blob_s1');
    await page.click('#gClean');
    await page.waitForFunction(() => document.body.classList.contains('editor-mode') && document.querySelectorAll('#edFrames .thumb').length > 0);
    await page.click('#edCopyTo');
    await page.waitForSelector('#choiceDlg[open]');
    await page.click('#choiceBtns button[data-value="__all"]');
    await page.waitForFunction(() => /Copied blob_s1_idle_00\.png/.test(document.getElementById('messages').textContent));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.PixelPipe.editor.E.anims.get('happy').length), 4, 'one undo reverts every target');
    await page.keyboard.press('Control+Shift+z');
    await page.click('#edSave');
    await page.waitForFunction(() => /Saved blob_s1/.test(document.getElementById('messages').textContent));
    const pl = readJson(path.join(C(root), 'blob_s1.placement.json'));
    assert.equal(pl.files['blob_s1_happy_00.png'].origin, 'editor');
    assert.deepEqual(fs.readFileSync(path.join(C(root), 'blob_s1_happy_00.png')), fs.readFileSync(path.join(C(root), 'blob_s1_idle_00.png')));
    assert.ok(fs.existsSync(path.join(C(root), 'blob_s1_happy_04.png')), 'the old happy frames moved up');
    assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0, cmdValidate(root, 'blob_s1').fails.join('\n'));
    // Stop editing moves Unit id to the next free id
    await page.click('#viewConv');
    await page.locator('#unitList .unit', { hasText: 'u1' }).locator('button', { hasText: 'Edit unit' }).click();
    await page.waitForFunction(() => document.getElementById('editLabel').textContent.includes('unit u1'));
    await page.click('#stopEdit');
    assert.equal(await page.inputValue('#unitId'), 'u3');
    assert.equal(await page.inputValue('#frameStart'), '4', 'after u1 idle 00–03');
    assert.equal(await page.isDisabled('#unitId'), false);
    if (process.env.PP_SHOTS) await page.screenshot({ path: path.join(os.tmpdir(), 'pp-v36.png') });
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); }
});

test('M9 review: a batch whose frames have no segment field (defensive) still rebuilds, adds and removes', () => {
  const root = tmpRoot();
  add(root);
  add(root, { id: 'u3', seed: 90, start: 4, n: 2 });
  const bp = path.join(R(root), 'blob_s1.batch.json');
  const b = readJson(bp);
  for (const u of b.units) for (const f of u.frames) delete f.segment;
  fs.writeFileSync(bp, JSON.stringify(b, null, 2));
  assert.deepEqual(cmdRebuild(root, 'blob_s1', { check: true }).mismatches, []);
  add(root, { id: 'u4', anim: 'happy', n: 1, seed: 40 });
  cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true });
  assert.deepEqual(batch(root).units.find((u) => u.id === 'u3').frames.map((f) => f.name), ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
});
