// v3.8 (D16): 2-bit export, stale-file moves, C reference renderer parity (fixture 26)
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { makeSprite, LV } from './fixtures.js';
import { encodePng } from '../src/core/png.js';

const cfgCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppcfg39-')), 'pixelpipe.config.json');
fs.copyFileSync(FIXTURE_CONFIG, cfgCopy);
process.env.PP_CONFIG = cfgCopy;
const { cmdArchiveBytes, cmdAddFragment } = await import('../src/cli/commands.js');
const { cmdPromote, cmdExport } = await import('../src/cli/commands3.js');
const { toHeader, frameData, isGroupExportFile } = await import('../src/core/exportfmt.js');
const { composeScreenFine, ditherCanvas, composeScreen } = await import('../src/core/dither.js');
const { loadConfig, readJson, sha256Bytes } = await import('../src/cli/store.js');
const cfg = loadConfig();

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp39-'));
function stripPng(cw, ch, seed, n, F = 10) {
  const W = n * (cw + 2) * F, H = (ch + 3) * F, rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let k = 0; k < n; k++) {
    const s = makeSprite(cw, ch, seed + k);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = s.I[y * cw + x]; if (v === 4) continue; for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 2) * F + py) * W + (k * (cw + 2) + 1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; } }
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
function add(root, sp, stage, variant, { id = 'u1', anim = 'idle', seed = 70, n = 2 } = {}) {
  const a = cmdArchiveBytes(root, stripPng(18, 20, seed, n), sp, { allowExisting: true });
  return cmdAddFragment(root, { species: sp, stage, variant, unit: { id, source: a.path, source_sha256: a.sha256, anim, frame_start: 0, strip: { n }, params: {} } });
}

test('isGroupExportFile: literal group match only', () => {
  for (const f of ['blob_s1.h', 'blob_s1_idle_00.bin', 'blob_s1_idle_00.png', 'blob_s1_idle_00_ink.png', 'blob_s1_happy_01_mask.png']) assert.ok(isGroupExportFile(f, 'blob_s1'), f);
  for (const f of ['blob_s1-fat.h', 'blob_s1-fat_idle_00.bin', 'blob_s1x_idle_00.bin', 'blob_s1_idle_0.bin', 'blob_s1_idle_00.txt', 'notes.md', 'blob_s1.h.bak']) assert.ok(!isGroupExportFile(f, 'blob_s1'), f);
  assert.ok(isGroupExportFile('puff_s2-fat_walk_01.bin', 'puff_s2-fat'));
});

test('fixture 26: export over a v3.7 export moves stale files; formats; refusals', () => {
  const root = tmpRoot();
  add(root, 'puff', 2, 'base'); add(root, 'puff', 2, 'fat', { seed: 90 });
  cmdPromote(root, 'puff_s2'); cmdPromote(root, 'puff_s2-fat');
  const ex = path.join(root, 'art/export/puff');
  fs.mkdirSync(ex, { recursive: true });
  // a v3.7 export of puff_s2 + a file of the fat group + an unrelated file
  for (const f of ['puff_s2.h', 'puff_s2_idle_00.bin', 'puff_s2_idle_00_ink.png', 'puff_s2_idle_00_mask.png', 'puff_s2_idle_01_ink.png', 'puff_s2_idle_01_mask.png', 'puff_s2_idle_01.bin', 'puff_s2-fat_idle_00_ink.png', 'README.txt']) fs.writeFileSync(path.join(ex, f), 'old ' + f);
  assert.throws(() => cmdExport(root, 'puff_s2', { formats: 'h,bogus' }), /unknown export format/);
  assert.throws(() => cmdExport(root, 'puff_s2', { formats: '1bit' }), /unknown export format/);
  assert.equal(fs.readFileSync(path.join(ex, 'puff_s2.h'), 'utf8'), 'old puff_s2.h', 'refusal wrote nothing');
  const r = cmdExport(root, 'puff_s2');
  assert.deepEqual(r.moved_stale, ['puff_s2_idle_00_ink.png', 'puff_s2_idle_00_mask.png', 'puff_s2_idle_01_ink.png', 'puff_s2_idle_01_mask.png']);
  assert.deepEqual(fs.readdirSync(ex).sort(), ['README.txt', 'puff_s2-fat_idle_00_ink.png', 'puff_s2.h', 'puff_s2_idle_00.bin', 'puff_s2_idle_00.png', 'puff_s2_idle_01.bin', 'puff_s2_idle_01.png']);
  assert.equal(fs.readFileSync(path.join(ex, 'puff_s2-fat_idle_00_ink.png'), 'utf8'), 'old puff_s2-fat_idle_00_ink.png');
  assert.equal(fs.statSync(path.join(ex, 'puff_s2_idle_00.bin')).size, 1538);
  const man = readJson(path.join(root, r.removed_dir, 'manifest.json'));
  assert.equal(man.moved.length, 4);
  for (const m of man.moved) assert.equal(fs.readFileSync(path.join(root, m.to), 'utf8'), 'old ' + path.basename(m.from));
  assert.match(r.removed_dir, /^art\/_removed\/.+-\d+-export-puff_s2$/);
  // a subset of formats moves the formats not requested; a second identical export moves nothing
  const r2 = cmdExport(root, 'puff_s2', { formats: 'h' });
  assert.deepEqual(r2.moved_stale, ['puff_s2_idle_00.bin', 'puff_s2_idle_00.png', 'puff_s2_idle_01.bin', 'puff_s2_idle_01.png']);
  const r3 = cmdExport(root, 'puff_s2', { formats: 'h' });
  assert.deepEqual(r3.moved_stale, []); assert.equal(r3.removed_dir, null);
  assert.throws(() => execFileSync(process.execPath, [path.resolve('src/cli/index.js'), 'export', 'puff_s2', '--anchor', 'sprite', '--root', root], { stdio: 'pipe', env: { ...process.env, PP_CONFIG: cfgCopy } }), /--anchor was removed/);
});

const cc = spawnSync('cc', ['--version']).status === 0 ? 'cc' : null;
function frameWithOddRef() {
  const I = new Uint8Array(4096).fill(4);
  for (let y = 20; y < 62; y++) for (let x = 11; x < 40; x++) I[y * 64 + x] = (x * 7 + y * 3) % 4; // all levels; bbox 11..39 → ref_x 25 (odd)
  return { w: 64, h: 64, I };
}
function bob(c, dy) { const I = new Uint8Array(4096).fill(4); for (let y = 0; y < 64; y++) if (y - dy >= 0 && y - dy < 64) for (let x = 0; x < 64; x++) I[(y - dy) * 64 + x] = c.I[y * 64 + x]; return { w: 64, h: 64, I }; }

test('fixture 26: compiled pp_draw equals the page renderer (×3, ×1, both anchors, negative phase, off-screen) and the 64-px oracle', (t) => {
  if (!cc) { t.skip('no C compiler (cc) — required in CI'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp39c-'));
  const c0 = frameWithOddRef(), c1 = bob(c0, 1);
  const frames = [{ name: 'tst_s1_idle_00.png', anim: 'idle', frame: 0, c: c0 }, { name: 'tst_s1_idle_01.png', anim: 'idle', frame: 1, c: c1 }].map((f) => ({ ...f, fd: frameData(f.c) }));
  assert.equal(frames[0].fd.ref[0] % 2, 1, 'odd ref_x');
  const tilesId = sha256Bytes(Buffer.from(JSON.stringify(cfg.dither.tiles))).slice(0, 8);
  fs.writeFileSync(path.join(dir, 'tst_s1.h'), toHeader('tst_s1', frames, { toolVersion: 't', anchor: 'sprite', tiles: cfg.dither.tiles, tilesId, pixelHash: 'x' }));
  const cases = [[0, 4, 4, 3, 0], [0, 4, 4, 3, 1], [1, 4, 4, 3, 1], [0, 0, 0, 1, 0], [0, 0, 0, 1, 1], [0, 0, 10, 3, 1], [0, -10, 150, 3, 1], [1, -7, -3, 3, 0]];
  fs.writeFileSync(path.join(dir, 'main.c'), `#include <stdio.h>
#include <string.h>
#include "tst_s1.h"
static unsigned char buf[200 * 200], hit[200 * 200];
static void plot(int x, int y, int black) { if (x < 0 || y < 0 || x >= 200 || y >= 200) return; buf[y * 200 + x] = (unsigned char)black; hit[y * 200 + x] = 1; }
int main(void) {
  static const int cs[][5] = { ${cases.map((c) => `{ ${c.join(', ')} }`).join(', ')} };
  for (unsigned k = 0; k < sizeof cs / sizeof cs[0]; k++) {
    memset(buf, 0, sizeof buf); memset(hit, 0, sizeof hit);
    pp_draw(&tst_s1_idle[cs[k][0]], cs[k][1], cs[k][2], cs[k][3], cs[k][4], plot);
    for (int i = 0; i < 200 * 200; i++) putchar(hit[i] ? '0' + buf[i] : '.');
    putchar('\\n');
  }
  return 0;
}
`);
  execFileSync(cc, ['-std=c99', '-Wall', '-Werror', '-o', path.join(dir, 'main'), path.join(dir, 'main.c')], { stdio: 'pipe' });
  const lines = execFileSync(path.join(dir, 'main'), { maxBuffer: 1 << 24 }).toString().trim().split('\n');
  cases.forEach(([fi, x0, y0, s, sa], k) => {
    const c = [c0, c1][fi];
    const ink = composeScreenFine(c, cfg, { screen: [200, 200], scale: s, offset: [x0, y0], anchor: sa ? 'sprite' : 'canvas' });
    let want = '';
    for (let Y = 0; Y < 200; Y++) for (let X = 0; X < 200; X++) {
      const x = Math.floor((X - x0) / s), y = Math.floor((Y - y0) / s);
      const opaque = X >= x0 && Y >= y0 && x < 64 && y < 64 && c.I[y * 64 + x] !== 4;
      want += opaque ? String(ink[Y * 200 + X]) : '.';
    }
    assert.equal(lines[k], want, `case ${k}`);
    if (s === 1 && x0 === 0 && y0 === 0) { // the v3.7 64-px dither is the s = 1 case
      const d = ditherCanvas(c, cfg, sa ? 'sprite' : 'canvas');
      const o = composeScreen(d, { screen: [200, 200], scale: 1, offset: [0, 0] });
      for (let i = 0; i < 64 * 200; i++) if (lines[k][i] !== '.') assert.equal(Number(lines[k][i]), o[i]);
    }
  });
  // sprite anchor at ×3: the 1-px bob draws the same pattern shifted by 3 rows
  const a = lines[1], b = lines[2];
  for (let Y = 0; Y < 197; Y++) assert.equal(b.slice(Y * 200, Y * 200 + 200), a.slice((Y + 3) * 200, (Y + 3) * 200 + 200));
  // two headers with different tiles in one translation unit → #error
  const other = JSON.parse(JSON.stringify(cfg.dither.tiles)); other['2'] = [[0, 1], [0, 0]];
  fs.writeFileSync(path.join(dir, 'oth_s1.h'), toHeader('oth_s1', frames.map((f) => ({ ...f, name: f.name.replace('tst', 'oth') })), { toolVersion: 't', anchor: 'canvas', tiles: other, tilesId: sha256Bytes(Buffer.from(JSON.stringify(other))).slice(0, 8), pixelHash: 'x' }));
  fs.writeFileSync(path.join(dir, 'mix.c'), '#include "tst_s1.h"\n#include "oth_s1.h"\nint main(void){return 0;}\n');
  const mix = spawnSync(cc, ['-std=c99', '-o', path.join(dir, 'mix'), path.join(dir, 'mix.c')]);
  assert.notEqual(mix.status, 0); assert.match(mix.stderr.toString(), /different dither tiles/);
  // same tiles twice is fine
  fs.writeFileSync(path.join(dir, 'same.c'), '#include "tst_s1.h"\nint main(void){return tst_s1_idle[0].px[0] * 0 + TST_S1_IDLE_COUNT * 0 + TST_S1_DITHER_ANCHOR_SPRITE * 0;}\n');
  execFileSync(cc, ['-std=c99', '-Wall', '-Werror', '-o', path.join(dir, 'same'), path.join(dir, 'same.c')], { stdio: 'pipe' });
});

test('Group Preview with no source loaded shows the group in the sprite and device panels (Chromium)', async (t) => {
  let pw; try { pw = await import('playwright-core'); } catch { t.skip('playwright-core missing'); return; }
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) { try { browser = await pw.chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ } }
  if (!browser) { t.skip('no Chromium'); return; }
  const root = tmpRoot();
  add(root, 'puff', 2, 'base'); cmdPromote(root, 'puff_s2');
  const { startServer, loadPage } = await import('../src/server/serve.js');
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => [...document.getElementById('groupSel').options].some((o) => o.value === 'puff_s2'));
    await page.selectOption('#groupSel', 'puff_s2');
    await page.click('#gPreview');
    await page.waitForFunction(() => /Previewing puff_s2/.test(document.getElementById('messages').textContent));
    await page.waitForTimeout(200);
    const black = await page.evaluate(() => Array.from(document.getElementById('einkCanvas').getContext('2d').getImageData(0, 0, 200, 200).data.filter((_, i) => i % 4 === 0)).filter((v) => v < 128).length);
    assert.ok(black > 50, `device panel shows the sprite (${black} black px)`);
    assert.equal(await page.textContent('#frameOut'), '1 / 2');
    assert.match(await page.textContent('#placeInfo'), /Group \d+ × \d+ in box/);
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); }
});
