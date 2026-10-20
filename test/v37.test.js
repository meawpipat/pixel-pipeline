// Spec v3.7: species-rename (fixture 25).
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { PKG_ROOT } from '../src/cli/store.js';

const cfgCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppcfg37-')), 'pixelpipe.config.json');
fs.copyFileSync(FIXTURE_CONFIG, cfgCopy);
process.env.PP_CONFIG = cfgCopy;
const { cmdArchiveBytes, cmdAddFragment, cmdRebuild } = await import('../src/cli/commands.js');
const { cmdPromote, cmdValidate, cmdExport } = await import('../src/cli/commands3.js');
const { cmdCleanSave } = await import('../src/cli/cleansave.js');
const { cmdSpeciesRename, assertNoRename, renameFileName, hooks } = await import('../src/cli/rename.js');
const { cmdSpeciesAdd } = await import('../src/cli/species.js');
const { loadConfig, readJson, sha256File } = await import('../src/cli/store.js');
const { startServer } = await import('../src/server/serve.js');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp37-'));
function stripPng(cw, ch, seed, n, F = 10) {
  const W = n * (cw + 2) * F, H = (ch + 3) * F, rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let k = 0; k < n; k++) {
    const s = makeSprite(cw, ch, seed + k);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = s.I[y * cw + x]; if (v === 4) continue; for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 2) * F + py) * W + (k * (cw + 2) + 1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; } }
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
function add(root, sp, stage, variant, { id = 'u1', anim = 'idle', seed = 70, n = 2, start = 0 } = {}) {
  const a = cmdArchiveBytes(root, stripPng(18, 20, seed, n), sp, { allowExisting: true });
  return cmdAddFragment(root, { species: sp, stage, variant, unit: { id, source: a.path, source_sha256: a.sha256, anim, frame_start: start, strip: { n }, params: {} } });
}
const walk = (d, r = '') => (fs.existsSync(d) ? fs.readdirSync(d).sort().flatMap((f) => (fs.statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f), `${r}${f}/`) : [`${r}${f}`])) : []);
const pngShas = (root, sp) => Object.fromEntries(['source', 'raw', 'clean'].flatMap((k) => walk(path.join(root, 'art', k, sp)).filter((f) => f.endsWith('.png')).map((f) => [`${k}/${f}`, sha256File(path.join(root, 'art', k, sp, f))])));

/** puff_s2 (clean with notes, a tombstone, an editor frame, a .trash folder; anim name containing the species id) + puff_s2-fat (exported). */
function setup() {
  const root = tmpRoot();
  add(root, 'puff', 2, 'base');
  add(root, 'puff', 2, 'base', { id: 'u2', anim: 'puffdance', seed: 80, n: 2 });
  add(root, 'puff', 2, 'fat', { seed: 90 });
  cmdPromote(root, 'puff_s2'); cmdPromote(root, 'puff_s2-fat');
  const C = path.join(root, 'art/clean/puff');
  fs.writeFileSync(path.join(C, 'puff_s2_idle_00.notes.json'), '{"outline_override":true,"reason":"r"}');
  // editor save: delete puffdance_01 (tombstone), duplicate idle_00 as idle_02 (editor frame) → .trash
  const p = readJson(path.join(C, 'puff_s2.placement.json'));
  const names = walk(C).filter((f) => f.endsWith('.png') && f.startsWith('puff_s2_'));
  const loaded = Object.fromEntries(names.map((n) => [n, sha256File(path.join(C, n))]));
  const I = (n) => Array.from(decodePng(new Uint8Array(fs.readFileSync(path.join(C, n)))).indexed.data);
  const frames = names.filter((n) => n !== 'puff_s2_puffdance_01.png').map((n) => ({ name: n, from: n, I: I(n), entry: p.files[n] }));
  frames.push({ name: 'puff_s2_idle_02.png', from: null, I: I('puff_s2_idle_00.png'), entry: { T: p.files['puff_s2_idle_00.png'].T, origin: 'editor', raw_name: null, raw_content_sha256: null } });
  cmdCleanSave(root, 'puff_s2', { frames, loaded, loaded_placement_sha256: sha256File(path.join(C, 'puff_s2.placement.json')) }, { yes: true });
  cmdExport(root, 'puff_s2-fat', {});
  return root;
}
const val = (root, g) => { const v = cmdValidate(root, g); return { fails: v.fails.length, warns: v.warns.map((w) => w.replace(/puff|fluffy/g, 'X')).sort() }; };

test('renameFileName parses, never string-replaces', () => {
  assert.equal(renameFileName('puff_s2_puffdance_01.png', 'puff', 'fluffy'), 'fluffy_s2_puffdance_01.png');
  assert.equal(renameFileName('puff_s2-fat.batch.json', 'puff', 'fluffy'), 'fluffy_s2-fat.batch.json');
  assert.equal(renameFileName('puff_s2_idle_00.notes.json', 'puff', 'fluffy'), 'fluffy_s2_idle_00.notes.json');
  assert.equal(renameFileName('puff_s2_idle_00.json', 'puff', 'fluffy'), 'fluffy_s2_idle_00.json');
  assert.equal(renameFileName('blob_a_s1_idle_00.png', 'blob', 'pixel'), null, 'another species that starts with the id');
  assert.equal(renameFileName('0123456789abcdef.png', 'puff', 'fluffy'), null);
});

test('fixture 25: everything renamed, no pixel changes, Validator and rebuild unchanged, fresh export', () => {
  const root = setup();
  const shas = pngShas(root, 'puff');
  const vBefore = [val(root, 'puff_s2'), val(root, 'puff_s2-fat')];
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy'), (e) => e.code === 'CONFIRM' && /puff_s2-fat\.h → fluffy_s2-fat\.h/.test(e.message) && /firmware/.test(e.message));
  const r = cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true });
  assert.equal(r.rebuild_check, 'unchanged');
  assert.deepEqual(r.exported, ['fluffy_s2-fat']);
  // no pixel changes: same bytes under the renamed paths
  const after = pngShas(root, 'fluffy');
  const expect = Object.fromEntries(Object.entries(shas).map(([k, v]) => [k.includes('.trash/') ? k : k.replace(/(^|\/)puff_s2/g, '$1fluffy_s2'), v])); // .trash keeps old names
  assert.deepEqual(after, expect);
  for (const k of ['source', 'raw', 'clean', 'export']) assert.ok(!fs.existsSync(path.join(root, 'art', k, 'puff')), `art/${k}/puff removed`);
  // JSON contents
  const b = readJson(path.join(root, 'art/raw/fluffy/fluffy_s2.batch.json'));
  assert.equal(b.batch_id, 'fluffy_s2'); assert.equal(b.species, 'fluffy');
  assert.ok(b.units.every((u) => u.source.startsWith('art/source/fluffy/') && u.frames.every((f) => f.name.startsWith('fluffy_s2_') && f.sidecar.startsWith('art/raw/fluffy/fluffy_s2_'))));
  const sc = readJson(path.join(root, 'art/raw/fluffy/fluffy_s2_puffdance_00.json'));
  assert.equal(sc.name, 'fluffy_s2_puffdance_00.png'); assert.equal(sc.batch_id, 'fluffy_s2'); assert.equal(sc.species, 'fluffy');
  const pl = readJson(path.join(root, 'art/clean/fluffy/fluffy_s2.placement.json'));
  assert.ok(Object.keys(pl.files).every((k) => k.startsWith('fluffy_s2_')));
  assert.ok(Object.values(pl.files).every((e) => e.raw_name == null || e.raw_name.startsWith('fluffy_s2_')));
  assert.deepEqual(pl.tombstones.map((t) => t.raw_name), ['fluffy_s2_puffdance_01.png']);
  assert.ok(fs.existsSync(path.join(root, 'art/clean/fluffy/fluffy_s2_idle_00.notes.json')));
  assert.ok(walk(path.join(root, 'art/clean/fluffy/.trash')).length > 0, '.trash moved along');
  // config: same position, one line
  const cfgAfter = fs.readFileSync(cfgCopy, 'utf8');
  const diff = cfgAfter.split('\n').filter((l, i) => l !== cfgBefore.split('\n')[i]);
  assert.equal(diff.length, 1); assert.match(diff[0], /"fluffy"/);
  assert.equal(loadConfig().stages['2'].species.indexOf('fluffy'), 1);
  // Validator and rebuild unchanged
  assert.deepEqual([val(root, 'fluffy_s2'), val(root, 'fluffy_s2-fat')], vBefore);
  assert.deepEqual(cmdRebuild(root, 'fluffy_s2', { check: true }).mismatches, []);
  // export: old in _removed, new names
  assert.ok(fs.existsSync(path.join(root, r.removed_dir, 'export/puff/puff_s2-fat.h')));
  assert.match(fs.readFileSync(path.join(root, 'art/export/fluffy/fluffy_s2-fat.h'), 'utf8'), /fluffy_s2_fat_idle\[\]/);
  // rename back restores the original names
  cmdSpeciesRename(root, 'fluffy', 'puff', { yes: true });
  assert.deepEqual(pngShas(root, 'puff'), shas);
  fs.writeFileSync(cfgCopy, cfgBefore);
});

test('fixture 25: refusals change nothing; a previously removed id with a leftover .trash is accepted', () => {
  const root = setup();
  const snap = JSON.stringify(walk(path.join(root, 'art')));
  for (const [n, re] of [['Bad', /lowercase/], ['blob', /already exists/], ['foo_s1', /ambiguous/]]) assert.throws(() => cmdSpeciesRename(root, 'puff', n, { yes: true }), re, n);
  assert.throws(() => cmdSpeciesRename(root, 'nope', 'fluffy', { yes: true }), /unknown species/);
  fs.mkdirSync(path.join(root, 'art/raw/fluffy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/raw/fluffy/x.json'), '{}');
  assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true }), /already holds files/);
  fs.rmSync(path.join(root, 'art/raw/fluffy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/clean/puff/puff_s2.retranslate.pending.json'), '{"files":[]}');
  assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true }), /interrupted command/);
  fs.rmSync(path.join(root, 'art/clean/puff/puff_s2.retranslate.pending.json'));
  assert.equal(JSON.stringify(walk(path.join(root, 'art'))), snap);
  // leftover .trash of a removed species under the new id is fine
  fs.mkdirSync(path.join(root, 'art/clean/fluffy/.trash/old-0'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/clean/fluffy/.trash/old-0/x.png'), 'x');
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true });
  assert.ok(fs.existsSync(path.join(root, 'art/clean/fluffy/.trash/old-0/x.png')));
  fs.writeFileSync(cfgCopy, cfgBefore);
});

function post(port, token, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { Host: `127.0.0.1:${port}`, 'X-PP-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString()) })); });
    r.on('error', reject); r.write(data); r.end();
  });
}

test('fixture 25: crashes after half the moves and after the JSON rewrites → marker blocks everything else; the re-run finishes exactly', async () => {
  const ref = setup();
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  cmdSpeciesRename(ref, 'puff', 'fluffy', { yes: true });
  const refShas = pngShas(ref, 'fluffy');
  const refJson = ['art/raw/fluffy/fluffy_s2.batch.json', 'art/clean/fluffy/fluffy_s2.placement.json', 'art/raw/fluffy/fluffy_s2_idle_00.json'].map((p) => fs.readFileSync(path.join(ref, p), 'utf8').replace(/"at": "[^"]+"/g, '"at": "*"'));
  fs.writeFileSync(cfgCopy, cfgBefore);
  for (const point of ['afterHalfMoves', 'afterJson']) {
    const root = setup();
    hooks[point] = () => { throw new Error('crash'); };
    try { assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true }), /crash/); } finally { hooks[point] = null; }
    assert.throws(() => assertNoRename(root), /interrupted species-rename puff → fluffy/);
    assert.throws(() => cmdSpeciesRename(root, 'puff', 'other', { yes: true }), /must be finished first/);
    const srv = await startServer({ root, port: 0, page: '<html>/*__SERVER__*/null</html>' });
    try {
      const r1 = await post(srv.port, srv.token, '/api/species', { id: 'zed', stage: 0 });
      assert.equal(r1.status, 422); assert.match(r1.json.error, /interrupted species-rename/);
      const r2 = await post(srv.port, srv.token, '/api/species/rename', { old: 'puff', new: 'fluffy', yes: true });
      assert.equal(r2.status, 200, JSON.stringify(r2.json));
    } finally { await srv.close(); }
    const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/\.trash\/[^/]+\//, '.trash/*/'), v]));
    assert.deepEqual(norm(pngShas(root, 'fluffy')), norm(refShas), point);
    assert.deepEqual(['art/raw/fluffy/fluffy_s2.batch.json', 'art/clean/fluffy/fluffy_s2.placement.json', 'art/raw/fluffy/fluffy_s2_idle_00.json'].map((p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/"at": "[^"]+"/g, '"at": "*"')), refJson, point);
    assert.ok(!fs.existsSync(path.join(root, 'art/.species-rename.pending.json')));
    fs.writeFileSync(cfgCopy, cfgBefore);
  }
});

test('fixture 25 (gate fixes): .trash collision refused before any change; identical duplicate dropped; export failure keeps the marker; stray temp files cleaned', () => {
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  let root = setup();
  const T = (sp) => path.join(root, `art/clean/${sp}/.trash/same-0`);
  fs.mkdirSync(T('fluffy'), { recursive: true }); fs.mkdirSync(T('puff'), { recursive: true });
  fs.writeFileSync(path.join(T('fluffy'), 'a.png'), 'NEW'); fs.writeFileSync(path.join(T('puff'), 'a.png'), 'OLD');
  const snap = JSON.stringify(walk(path.join(root, 'art')));
  assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true }), /already exists with other content/);
  assert.equal(JSON.stringify(walk(path.join(root, 'art'))), snap);
  assert.equal(fs.readFileSync(cfgCopy, 'utf8'), cfgBefore);
  fs.writeFileSync(path.join(T('puff'), 'a.png'), 'NEW'); // identical → fine, and the old copy is dropped
  cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true });
  assert.ok(!fs.existsSync(path.join(root, 'art/clean/puff')));
  assert.equal(fs.readFileSync(path.join(T('fluffy'), 'a.png'), 'utf8'), 'NEW');
  fs.writeFileSync(cfgCopy, cfgBefore);
  // export failure: marker stays, the re-run finishes with the export
  root = setup();
  hooks.beforeExport = () => { throw new Error('disk full'); };
  try { assert.throws(() => cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true }), /export of fluffy_s2-fat failed \(disk full\)/); } finally { hooks.beforeExport = null; }
  assert.ok(fs.existsSync(path.join(root, 'art/.species-rename.pending.json')));
  // a crash inside writeAtomic leaves a temp file next to a planned JSON file
  fs.writeFileSync(path.join(root, 'art/raw/fluffy/fluffy_s2.batch.json.123.456.tmp'), 'x');
  fs.writeFileSync(path.join(root, 'art/.species-rename.pending.json.1.2.tmp'), 'x');
  const r = cmdSpeciesRename(root, 'puff', 'fluffy', { yes: true });
  assert.deepEqual(r.exported, ['fluffy_s2-fat']);
  assert.ok(fs.existsSync(path.join(root, 'art/export/fluffy/fluffy_s2-fat.h')));
  assert.deepEqual(walk(path.join(root, 'art')).filter((f) => f.endsWith('.tmp')), []);
  fs.writeFileSync(cfgCopy, cfgBefore);
});

test('fixture 25: blob → blob_a (the new id starts with the old one)', () => {
  const root = tmpRoot();
  add(root, 'blob', 1, 'base');
  cmdPromote(root, 'blob_s1');
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  const shas = pngShas(root, 'blob');
  cmdSpeciesRename(root, 'blob', 'blob_a', { yes: true });
  assert.deepEqual(Object.values(pngShas(root, 'blob_a')).sort(), Object.values(shas).sort());
  assert.ok(loadConfig().stages['1'].species.includes('blob_a') && !loadConfig().stages['1'].species.includes('blob'));
  assert.equal(cmdValidate(root, 'blob_a_s1').fails.length, 0);
  fs.writeFileSync(cfgCopy, cfgBefore);
});

test('fixture 25 in Chromium: ✎ Rename species… renames and the page follows', async (t) => {
  let pw; try { pw = await import('playwright-core'); } catch { t.skip('playwright-core missing'); return; }
  const root = setup();
  const cfgBefore = fs.readFileSync(cfgCopy, 'utf8');
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) { try { browser = await pw.chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ } }
  if (!browser) { t.skip('no Chromium'); return; }
  const { loadPage } = await import('../src/server/serve.js');
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => document.getElementById('groupSel').options.length > 1);
    await page.selectOption('#species', 'puff|2');
    await page.selectOption('#species', '__rename__');
    await page.waitForSelector('#speciesRnDlg[open]');
    assert.equal(await page.inputValue('#rnSpOld'), 'puff');
    await page.fill('#rnSpNew', 'fluffy');
    await page.click('#rnSpOk');
    await page.waitForSelector('#confirmDlg[open]');
    assert.match(await page.textContent('#confirmMsg'), /fluffy_s2-fat\.h/);
    await page.click('#confirmOk');
    await page.waitForFunction(() => /Renamed species "puff" to "fluffy"/.test(document.getElementById('messages').textContent));
    assert.equal(await page.inputValue('#species'), 'fluffy|2');
    await page.waitForFunction(() => [...document.getElementById('groupSel').options].some((o) => o.value === 'fluffy_s2'));
    assert.ok(fs.existsSync(path.join(root, 'art/raw/fluffy/fluffy_s2.batch.json')));
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); fs.writeFileSync(cfgCopy, cfgBefore); }
});
