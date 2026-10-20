// Spec v3.5: unit-remove (fixture 18), group-remove (fixture 19), species-remove (fixture 20).
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { PKG_ROOT } from '../src/cli/store.js';

const cfgCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppcfg35-')), 'pixelpipe.config.json');
fs.copyFileSync(FIXTURE_CONFIG, cfgCopy);
process.env.PP_CONFIG = cfgCopy;
const { cmdArchiveBytes, cmdAddFragment, cmdRebuild } = await import('../src/cli/commands.js');
const { cmdPromote, cmdValidate, cmdRetranslate } = await import('../src/cli/commands3.js');
const { cmdCleanSave } = await import('../src/cli/cleansave.js');
const { cmdUnitRemove, cmdGroupRemove, cmdSpeciesRemove, hooks } = await import('../src/cli/remove.js');
const { cmdSpeciesAdd } = await import('../src/cli/species.js');
const { loadConfig, readJson, sha256File } = await import('../src/cli/store.js');
const cfg = loadConfig();

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp35-'));
function stripPng(cw, ch, seed, frames = 2, F = 10) {
  const W = frames * (cw + 2) * F, H = (ch + 3) * F;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let k = 0; k < frames; k++) {
    const s = makeSprite(cw, ch, seed + k);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const v = s.I[y * cw + x]; if (v === 4) continue;
      for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 2) * F + py) * W + (k * (cw + 2) + 1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; }
    }
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
function add(root, { species = 'blob', stage = 1, id = 'u1', anim = 'idle', seed = 70, cw = 18, ch = 20, n = 2, start = 0, dx = 0, yes = false } = {}) {
  const png = stripPng(cw, ch, seed, n);
  const a = cmdArchiveBytes(root, png, species, { allowExisting: true });
  return cmdAddFragment(root, { species, stage, variant: 'base', unit: { id, source: a.path, source_sha256: a.sha256, anim, dx, frame_start: start, strip: { n }, params: {} } }, { yes });
}
const C = (root, sp = 'blob') => path.join(root, 'art/clean', sp);
const R = (root, sp = 'blob') => path.join(root, 'art/raw', sp);
const pl = (root) => readJson(path.join(C(root), 'blob_s1.placement.json'));
const editPng = (p) => { const I = decodePng(new Uint8Array(fs.readFileSync(p))).indexed.data.slice(); const k = I.findIndex((v) => v !== 4); I[k] = (I[k] + 1) % 4; fs.writeFileSync(p, encodeCanonical({ w: 64, h: 64, I }, cfg)); };
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.startsWith('.')).sort() : []);

/** blob_s1: u1 idle 00–01, u2 happy 00, u3 idle 02–03 (all promoted). */
function setup() {
  const root = tmpRoot();
  add(root);
  add(root, { id: 'u2', anim: 'happy', seed: 80, n: 1 });
  add(root, { id: 'u3', anim: 'idle', seed: 90, start: 2 });
  cmdPromote(root, 'blob_s1');
  return root;
}

test('fixture 18: remove u2 → raw, sidecars and the untouched clean frame move to _removed with a complete manifest', () => {
  const root = setup();
  assert.throws(() => cmdUnitRemove(root, 'blob_s1', 'u2'), (e) => e.code === 'CONFIRM' && /blob_s1_happy_00\.png/.test(e.message) && /local only/.test(e.message));
  const r = cmdUnitRemove(root, 'blob_s1', 'u2', { yes: true });
  assert.ok(!fs.existsSync(path.join(R(root), 'blob_s1_happy_00.png')));
  assert.ok(!fs.existsSync(path.join(C(root), 'blob_s1_happy_00.png')));
  const dir = path.join(root, r.removed_dir);
  for (const f of ['raw/blob/blob_s1_happy_00.png', 'raw/blob/blob_s1_happy_00.json', 'clean/blob/blob_s1_happy_00.png']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const m = readJson(path.join(dir, 'manifest.json'));
  assert.equal(m.removed_unit.id, 'u2');
  assert.ok(m.dropped_placement_entries['blob_s1_happy_00.png']);
  assert.equal(m.moved.length, 3);
  assert.deepEqual(readJson(path.join(R(root), 'blob_s1.batch.json')).units.map((u) => u.id), ['u1', 'u3']);
  assert.equal(pl(root).files['blob_s1_happy_00.png'], undefined);
  assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0, cmdValidate(root, 'blob_s1').fails.join('\n'));
  assert.ok(!fs.existsSync(path.join(C(root), 'blob_s1.remove.pending.json')));
  const ci = cmdRebuild(root, 'blob_s1', { check: true });
  assert.deepEqual(ci.mismatches, [], 'FR-12 rebuild byte-identical');
});

test('fixture 18: edited frames — keep turns them editor-made, trash moves them; a migrated frame identical to raw counts as untouched', () => {
  for (const edited of ['keep', 'trash']) {
    const root = setup();
    editPng(path.join(C(root), 'blob_s1_happy_00.png'));
    const r = cmdUnitRemove(root, 'blob_s1', 'u2', { edited, yes: true });
    if (edited === 'keep') {
      assert.deepEqual(r.kept_as_editor, ['blob_s1_happy_00.png']);
      const e = pl(root).files['blob_s1_happy_00.png'];
      assert.equal(e.origin, 'editor'); assert.equal(e.raw_name, null);
      assert.ok(fs.existsSync(path.join(C(root), 'blob_s1_happy_00.png')));
    } else {
      assert.ok(!fs.existsSync(path.join(C(root), 'blob_s1_happy_00.png')));
      assert.ok(fs.existsSync(path.join(root, r.removed_dir, 'clean/blob/blob_s1_happy_00.png')));
    }
  }
  const root = setup();
  const p = pl(root); delete p.files['blob_s1_happy_00.png'].written_sha256;
  fs.writeFileSync(path.join(C(root), 'blob_s1.placement.json'), JSON.stringify(p));
  const r = cmdUnitRemove(root, 'blob_s1', 'u2', { yes: true });
  assert.deepEqual(r.kept_as_editor, []);
});

test('fixture 18: remove u1 → u3 moves down (raw names, sidecars, raw_name) and its clean frames are renumbered with their notes', () => {
  const root = setup();
  editPng(path.join(C(root), 'blob_s1_idle_03.png')); // human work on u3 must survive
  fs.writeFileSync(path.join(C(root), 'blob_s1_idle_03.notes.json'), '{"outline_override":true,"reason":"r"}');
  const before3 = fs.readFileSync(path.join(C(root), 'blob_s1_idle_03.png'));
  const r = cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true });
  assert.deepEqual(r.renamed_raw, { 'blob_s1_idle_02.png': 'blob_s1_idle_00.png', 'blob_s1_idle_03.png': 'blob_s1_idle_01.png' });
  assert.deepEqual(r.renamed_clean, { 'blob_s1_idle_02.png': 'blob_s1_idle_00.png', 'blob_s1_idle_03.png': 'blob_s1_idle_01.png' });
  const b = readJson(path.join(R(root), 'blob_s1.batch.json'));
  const u3 = b.units.find((u) => u.id === 'u3');
  assert.equal(u3.frame_start, 0);
  assert.deepEqual(u3.frames.map((f) => f.name), ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
  assert.equal(readJson(path.join(R(root), 'blob_s1_idle_01.json')).frame, 1);
  assert.deepEqual(files(R(root)).filter((f) => f.endsWith('.png')), ['blob_s1_happy_00.png', 'blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
  assert.deepEqual(files(C(root)).filter((f) => /idle/.test(f)), ['blob_s1_idle_00.png', 'blob_s1_idle_01.notes.json', 'blob_s1_idle_01.png']);
  assert.equal(pl(root).files['blob_s1_idle_01.png'].raw_name, 'blob_s1_idle_01.png');
  assert.deepEqual(fs.readFileSync(path.join(C(root), 'blob_s1_idle_01.png')), before3, 'edited u3 frame kept, renamed');
  assert.deepEqual(r.name_taken, []);
  assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0, cmdValidate(root, 'blob_s1').fails.join('\n'));
  assert.deepEqual(cmdRebuild(root, 'blob_s1', { check: true }).mismatches, []);
  assert.deepEqual(cmdPromote(root, 'blob_s1').copied, [], 'renamed raw frames stay claimed');
  const m = readJson(path.join(root, r.removed_dir, 'manifest.json'));
  assert.deepEqual(m.renamed_clean, r.renamed_clean);
});

test('fixture 18: an edited u1 frame kept → clean renumbered around it; name_taken when u3 was never promoted', () => {
  const root = tmpRoot();
  add(root); add(root, { id: 'u2', anim: 'happy', seed: 80, n: 1 });
  cmdPromote(root, 'blob_s1');
  add(root, { id: 'u3', anim: 'idle', seed: 90, start: 2 }); // not promoted
  editPng(path.join(C(root), 'blob_s1_idle_00.png'));
  const r = cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true });
  assert.deepEqual(r.kept_as_editor, ['blob_s1_idle_00.png']);
  assert.deepEqual(r.renamed_clean, {});
  assert.deepEqual(r.name_taken, ['blob_s1_idle_00.png']);
  assert.ok(cmdValidate(root, 'blob_s1').warns.some((w) => /name taken/.test(w)));
});

test('fixture 18: the only unit → group removal; T change → retranslate_needed; failing dry run moves nothing; refusals', () => {
  const r1 = tmpRoot();
  add(r1); cmdPromote(r1, 'blob_s1');
  assert.throws(() => cmdUnitRemove(r1, 'blob_s1', 'u1'), (e) => e.code === 'CONFIRM' && /removes the whole group/.test(e.message));
  const g = cmdUnitRemove(r1, 'blob_s1', 'u1', { yes: true });
  assert.equal(g.via_unit_remove, 'u1');
  assert.ok(!fs.existsSync(path.join(R(r1), 'blob_s1.batch.json')));

  const r2 = tmpRoot();
  add(r2); add(r2, { id: 'w', anim: 'happy', seed: 50, cw: 30, ch: 26, n: 1, dx: 6 });
  cmdPromote(r2, 'blob_s1');
  const rr = cmdUnitRemove(r2, 'blob_s1', 'w', { yes: true });
  assert.equal(rr.retranslate_needed, true);
  cmdRetranslate(r2, 'blob_s1', { yes: true });
  assert.equal(cmdValidate(r2, 'blob_s1').fails.length, 0);

  const r3 = setup();
  const src = readJson(path.join(R(r3), 'blob_s1.batch.json')).units.find((u) => u.id === 'u3').source;
  fs.appendFileSync(path.join(r3, src), Buffer.from([0])); // another unit's source changed → dry run fails
  const snapshot = files(R(r3)).join() + files(C(r3)).join();
  assert.throws(() => cmdUnitRemove(r3, 'blob_s1', 'u2', { yes: true }), /source changed/);
  assert.equal(files(R(r3)).join() + files(C(r3)).join(), snapshot);
  assert.ok(!fs.existsSync(path.join(r3, 'art/_removed')));

  const r4 = setup();
  assert.throws(() => cmdUnitRemove(r4, 'blob_s1', 'nope', { yes: true }), /no unit "nope"/);
  assert.throws(() => cmdUnitRemove(r4, 'blob_s1', 'u2', { edited: 'maybe', yes: true }), /keep or trash/);
  fs.writeFileSync(path.join(C(r4), 'blob_s1.retranslate.pending.json'), '{"files":[]}');
  assert.throws(() => cmdUnitRemove(r4, 'blob_s1', 'u2', { yes: true }), /interrupted retranslate/);
});

/** blob_s1 with u1 idle 00–01 and u3 idle of n3 frames from 02, all promoted; optionally an edited u3 frame with notes. */
function setupChain(n3, { editU3 = false } = {}) {
  const root = tmpRoot();
  add(root);
  add(root, { id: 'u2', anim: 'happy', seed: 80, n: 1 });
  add(root, { id: 'u3', anim: 'idle', seed: 90, start: 2, n: n3 });
  cmdPromote(root, 'blob_s1');
  if (editU3) { editPng(path.join(C(root), 'blob_s1_idle_02.png')); fs.writeFileSync(path.join(C(root), 'blob_s1_idle_02.notes.json'), '{"outline_override":true,"reason":"r"}'); }
  return root;
}
const shaMap = (d) => Object.fromEntries(files(d).map((f) => [f, sha256File(path.join(d, f))]));
const removedShas = (root, dir) => { const out = {}; const walk = (p, r) => { for (const f of fs.readdirSync(p)) { const q = path.join(p, f); if (fs.statSync(q).isDirectory()) walk(q, `${r}${f}/`); else if (f !== 'manifest.json') out[`${r}${f}`] = sha256File(q); } }; walk(path.join(root, dir), ''); return out; };

test('fixture 18: crashes at every step → marker, Validator FAIL, others refuse; the re-run gives exactly the no-crash result (clean, placement, _removed)', () => {
  for (const [n3, editU3] of [[2, false], [3, false], [3, true]]) {
    const ref = setupChain(n3, { editU3 });
    const rr = cmdUnitRemove(ref, 'blob_s1', 'u1', { yes: true });
    const refClean = shaMap(C(ref)), refRemoved = removedShas(ref, rr.removed_dir);
    const refPl = pl(ref);
    assert.equal(cmdValidate(ref, 'blob_s1').fails.length, 0, `${n3}/${editU3}: ${cmdValidate(ref, 'blob_s1').fails.join('; ')}`);
    for (const point of ['afterClean', 'afterRawMove']) {
      const root = setupChain(n3, { editU3 });
      hooks[point] = () => { throw new Error('crash'); };
      try { assert.throws(() => cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true }), /crash/); } finally { hooks[point] = null; }
      assert.ok(cmdValidate(root, 'blob_s1').fails.some((f) => /interrupted unit-remove/.test(f)), point);
      assert.throws(() => cmdPromote(root, 'blob_s1'), /interrupted unit-remove/);
      assert.throws(() => cmdUnitRemove(root, 'blob_s1', 'u2', { yes: true }), /must be finished first/);
      const r = cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true });
      const tag = `${n3}/${editU3}/${point}`;
      assert.deepEqual(shaMap(C(root)), refClean, tag);
      assert.deepEqual(removedShas(root, r.removed_dir), refRemoved, tag);
      const p = pl(root);
      assert.deepEqual(p.files, refPl.files, tag);
      assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0, tag);
      assert.deepEqual(cmdRebuild(root, 'blob_s1', { check: true }).mismatches, [], tag);
    }
  }
});

test('M8 review: a step never overwrites — an unexpected file at a target refuses', () => {
  const root = setupChain(2);
  hooks.afterClean = () => { throw new Error('crash'); };
  try { assert.throws(() => cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true }), /crash/); } finally { hooks.afterClean = null; }
  const m = readJson(path.join(C(root), 'blob_s1.remove.pending.json'));
  const rawStep = m.raw_steps[0];
  fs.mkdirSync(path.dirname(path.join(root, rawStep.to)), { recursive: true });
  fs.writeFileSync(path.join(root, rawStep.to), 'something else');
  assert.throws(() => cmdUnitRemove(root, 'blob_s1', 'u1', { yes: true }), /already exists with other content/);
  assert.equal(fs.readFileSync(path.join(root, rawStep.to), 'utf8'), 'something else');
});

test('fixture 19: group-remove moves everything of the group; crash halfway → still listed, re-run finishes', () => {
  const root = setup();
  fs.writeFileSync(path.join(C(root), 'blob_s1_idle_00.notes.json'), '{"outline_override":true,"reason":"x"}');
  fs.mkdirSync(path.join(root, 'art/export/blob'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/export/blob/blob_s1.h'), '// h');
  fs.writeFileSync(path.join(root, 'art/export/blob/blob_s1_idle_00.bin'), 'x');
  const srcs = new Set(readJson(path.join(R(root), 'blob_s1.batch.json')).units.map((u) => u.source));
  hooks.afterHalfGroup = () => { throw new Error('crash'); };
  try { assert.throws(() => cmdGroupRemove(root, 'blob_s1', { yes: true }), /crash/); } finally { hooks.afterHalfGroup = null; }
  assert.ok(fs.existsSync(path.join(R(root), 'blob_s1.batch.json')), 'still listed');
  assert.ok(cmdValidate(root, 'blob_s1').fails.some((f) => /interrupted group-remove/.test(f)));
  const r = cmdGroupRemove(root, 'blob_s1', { yes: true });
  assert.deepEqual(files(R(root)), []);
  assert.deepEqual(files(C(root)), []);
  assert.deepEqual(files(path.join(root, 'art/export/blob')), []);
  for (const s of srcs) assert.ok(!fs.existsSync(path.join(root, s)));
  const m = readJson(path.join(root, r.removed_dir, 'manifest.json'));
  for (const it of m.moved) assert.ok(fs.existsSync(path.join(root, it.to)), it.to);
  assert.ok(m.moved.some((it) => it.from.endsWith('blob_s1.batch.json')));
  assert.ok(m.moved.some((it) => it.from.endsWith('blob_s1_idle_00.notes.json')));
});

test('fixture 19: a crash after the batch moved, before the marker is removed → re-run finishes; the group is still listed', async () => {
  const root = setup();
  const real = fs.rmSync;
  let n = 0;
  fs.rmSync = (p, ...a) => { if (String(p).endsWith('.remove.pending.json') && n++ === 0) throw new Error('crash'); return real(p, ...a); };
  try { assert.throws(() => cmdGroupRemove(root, 'blob_s1', { yes: true }), /crash/); } finally { fs.rmSync = real; }
  assert.ok(!fs.existsSync(path.join(R(root), 'blob_s1.batch.json')));
  const { startServer } = await import('../src/server/serve.js');
  const srv = await startServer({ root, port: 0, page: '<html>/*__SERVER__*/null</html>' });
  try {
    const http = await import('node:http');
    const st = await new Promise((res) => http.get({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { Host: `127.0.0.1:${srv.port}`, 'X-PP-Token': srv.token } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(JSON.parse(Buffer.concat(c)))); }));
    assert.ok(st.groups.some((g) => g.batch_id === 'blob_s1'), 'still listed');
  } finally { await srv.close(); }
  cmdGroupRemove(root, 'blob_s1', { yes: true });
  assert.ok(!fs.existsSync(path.join(C(root), 'blob_s1.remove.pending.json')));
});

test('fixture 19: a source shared with another group of the species stays', () => {
  const root = tmpRoot();
  add(root, { species: 'puff', stage: 2 });
  const src = readJson(path.join(R(root, 'puff'), 'puff_s2.batch.json')).units[0].source;
  cmdAddFragment(root, { species: 'puff', stage: 2, variant: 'fat', unit: { id: 'u1', source: src, source_sha256: sha256File(path.join(root, src)), anim: 'idle', strip: { n: 2 }, params: {} } });
  cmdGroupRemove(root, 'puff_s2', { yes: true });
  assert.ok(fs.existsSync(path.join(root, src)), 'shared source stays');
  assert.ok(fs.existsSync(path.join(R(root, 'puff'), 'puff_s2-fat.batch.json')), 'other group untouched');
  assert.ok(!fs.existsSync(path.join(R(root, 'puff'), 'puff_s2.batch.json')));
});

test('fixture 20: species-remove refuses with groups; after group-remove it moves leftovers and edits one config line', () => {
  const root = tmpRoot();
  cmdSpeciesAdd(null, 'fire_egg', 0);
  add(root, { species: 'fire_egg', stage: 0, cw: 14, ch: 16 });
  add(root, { species: 'fire_egg', stage: 0, id: 'u2', anim: 'idle', seed: 99, cw: 14, ch: 16, start: 2 });
  assert.throws(() => cmdSpeciesRemove(root, 'fire_egg', { yes: true }), /still has group\(s\) fire_egg_s0/);
  const r = cmdUnitRemove(root, 'fire_egg_s0', 'u2', { yes: true });
  assert.ok(r.source_unused, 'its source is reported unused');
  cmdGroupRemove(root, 'fire_egg_s0', { yes: true });
  assert.equal(files(path.join(root, 'art/source/fire_egg')).length, 1, 'the source left by unit-remove remains');
  const before = fs.readFileSync(cfgCopy, 'utf8');
  assert.throws(() => cmdSpeciesRemove(root, 'fire_egg'), (e) => e.code === 'CONFIRM' && /art\/source\/fire_egg\//.test(e.message));
  const sr = cmdSpeciesRemove(root, 'fire_egg', { yes: true });
  assert.equal(sr.rewritten, 'line');
  assert.equal(files(path.join(root, 'art/source/fire_egg')).length, 0);
  assert.ok(fs.existsSync(path.join(root, sr.removed_dir, 'manifest.json')));
  const after = fs.readFileSync(cfgCopy, 'utf8');
  const diff = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.equal(diff.length, 1); assert.match(diff[0], /"species": \["egg"\]/);
  assert.ok(!loadConfig().stages['0'].species.includes('fire_egg'));
  assert.throws(() => cmdSpeciesRemove(root, 'nope', { yes: true }), /unknown species/);
});

test('v3.5 page: Remove (units list, with edited-frame choice), Remove group…, − Remove species…', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { t.skip('playwright-core missing'); return; }
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ }
  }
  if (!browser) { t.skip('no Chromium'); return; }
  const { startServer, loadPage } = await import('../src/server/serve.js');
  const root = setup();
  editPng(path.join(C(root), 'blob_s1_happy_00.png'));
  cmdSpeciesAdd(null, 'storm_egg', 0);
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => document.getElementById('groupSel').value === 'blob_s1');
    await page.waitForSelector('#unitList .unit');
    await page.locator('#unitList .unit', { hasText: 'u2' }).locator('button', { hasText: 'Remove' }).click();
    await page.waitForFunction(() => /You edited blob_s1_happy_00\.png/.test(document.getElementById('choiceMsg').textContent) && document.getElementById('choiceDlg').open);
    await page.click('#choiceBtns button[data-value="keep"]');
    await page.waitForSelector('#confirmDlg[open]');
    assert.match(await page.textContent('#confirmMsg'), /stay as editor-made/);
    await page.click('#confirmOk');
    await page.waitForFunction(() => /Removed unit "u2"/.test(document.getElementById('messages').textContent));
    assert.equal(readJson(path.join(C(root), 'blob_s1.placement.json')).files['blob_s1_happy_00.png'].origin, 'editor');
    await page.click('#gRemoveGroup');
    await page.waitForSelector('#confirmDlg[open]');
    assert.match(await page.textContent('#confirmMsg'), /local only/);
    await page.click('#confirmOk');
    await page.waitForFunction(() => /Removed blob_s1/.test(document.getElementById('messages').textContent));
    assert.ok(!fs.existsSync(path.join(R(root), 'blob_s1.batch.json')));
    await page.selectOption('#species', '__remove__');
    await page.waitForSelector('#speciesRmDlg[open]');
    await page.selectOption('#rmSpId', 'storm_egg');
    await page.click('#rmSpOk');
    await page.waitForSelector('#confirmDlg[open]');
    await page.click('#confirmOk');
    await page.waitForFunction(() => /Removed species "storm_egg"/.test(document.getElementById('messages').textContent));
    assert.ok(!loadConfig().stages['0'].species.includes('storm_egg'));
    assert.equal(await page.locator('#species option[value="storm_egg|0"]').count(), 0);
    if (process.env.PP_SHOTS) await page.screenshot({ path: path.join(os.tmpdir(), 'pp-v35.png') });
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); }
});
