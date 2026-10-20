// Spec v3.4: promote auto-refresh with written_sha256 + promote marker (fixture 16), species-add (fixture 17).
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { cmdArchiveBytes, cmdAddFragment } from '../src/cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdValidate, cmdNormalize, hooks } from '../src/cli/commands3.js';
import { cmdCleanSave } from '../src/cli/cleansave.js';
import { cmdSpeciesAdd } from '../src/cli/species.js';
import { loadConfig, readJson, sha256File, PKG_ROOT } from '../src/cli/store.js';

// species-add tests write a private copy of the config (never the real one)
const cfgCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppcfg-')), 'pixelpipe.config.json');
fs.copyFileSync(FIXTURE_CONFIG, cfgCopy);
process.env.PP_CONFIG = cfgCopy;
const { startServer, loadPage } = await import('../src/server/serve.js');

const cfg = loadConfig();
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp34-'));

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
function addUnit(root, { id = 'u1', anim = 'idle', seed = 70, cw = 20, ch = 22, n = 2, dx = 0, yes = false } = {}) {
  const png = stripPng(cw, ch, seed, n);
  let a;
  try { a = cmdArchiveBytes(root, png, 'blob'); } catch { a = cmdArchiveBytes(root, png, 'blob', { allowExisting: true }); }
  return cmdAddFragment(root, { species: 'blob', stage: 1, variant: 'base', unit: { id, source: a.path, source_sha256: a.sha256, anim, dx, strip: { n }, params: {} } }, { yes });
}
const D = (root) => path.join(root, 'art/clean/blob');
const pl = (root) => readJson(path.join(D(root), 'blob_s1.placement.json'));
const read = (root, n) => fs.readFileSync(path.join(D(root), n));
const raw = (root, n) => fs.readFileSync(path.join(root, 'art/raw/blob', n));
function load(root) {
  const p = pl(root), names = fs.readdirSync(D(root)).filter((f) => f.startsWith('blob_s1_') && f.endsWith('.png')).sort();
  return {
    frames: names.map((n) => ({ name: n, from: n, I: Array.from(decodePng(new Uint8Array(read(root, n))).indexed.data), entry: { ...p.files[n] } })),
    loaded: Object.fromEntries(names.map((n) => [n, sha256File(path.join(D(root), n))])),
    loaded_placement_sha256: sha256File(path.join(D(root), 'blob_s1.placement.json')),
  };
}

test('fixture 16: untouched → refreshed (old file + notes in .trash); hand-edited, shifted, migrated and non-canonical → WARN only', () => {
  const root = tmpRoot();
  addUnit(root);
  const r0 = cmdPromote(root, 'blob_s1');
  assert.deepEqual(r0.copied, ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
  assert.equal(pl(root).files['blob_s1_idle_00.png'].written_sha256, sha256File(path.join(D(root), 'blob_s1_idle_00.png')));
  fs.writeFileSync(path.join(D(root), 'blob_s1_idle_00.notes.json'), '{"outline_override":true,"reason":"x"}');
  // replace the unit: the 409 names the clean frames that will follow
  assert.throws(() => addUnit(root, { seed: 90 }), (e) => e.code === 'CONFIRM' && /never edited will then be updated/.test(e.message) && /blob_s1_idle_00\.png/.test(e.message));
  const old0 = read(root, 'blob_s1_idle_00.png');
  addUnit(root, { seed: 90, yes: true });
  const r = cmdPromote(root, 'blob_s1');
  assert.deepEqual(r.refreshed.sort(), ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
  assert.deepEqual(read(root, 'blob_s1_idle_00.png'), raw(root, 'blob_s1_idle_00.png'));
  assert.deepEqual(fs.readFileSync(path.join(root, r.trash, 'blob_s1_idle_00.png')), old0);
  assert.ok(fs.existsSync(path.join(root, r.trash, 'blob_s1_idle_00.notes.json')), 'notes moved with the old pixels');
  assert.ok(!fs.existsSync(path.join(D(root), 'blob_s1_idle_00.notes.json')));
  assert.ok(!cmdValidate(root, 'blob_s1').warns.some((w) => /raw changed/.test(w)));
  assert.deepEqual(cmdPromote(root, 'blob_s1').refreshed, [], 'idempotent');

  // (c) hand-edit idle_00, (d) shift idle_01 by 1 px — both through clean-save
  const st = load(root);
  st.frames[0].I[0] = 0;
  const s1 = st.frames[1].I, sh = new Array(4096).fill(4);
  for (let i = 0; i < 4096; i++) if (s1[i] !== 4) sh[i + 1] = s1[i];
  st.frames[1].I = sh;
  st.frames[1].entry.written_sha256 = 'f'.repeat(64); // a page cannot forge it: the server derives it
  cmdCleanSave(root, 'blob_s1', st);
  assert.equal(pl(root).files['blob_s1_idle_00.png'].written_sha256, null);
  assert.equal(pl(root).files['blob_s1_idle_01.png'].written_sha256, null);
  const e0 = read(root, 'blob_s1_idle_00.png'), e1 = read(root, 'blob_s1_idle_01.png');
  addUnit(root, { seed: 110, yes: true });
  const r2 = cmdPromote(root, 'blob_s1');
  assert.deepEqual(r2.refreshed, []);
  assert.deepEqual(read(root, 'blob_s1_idle_00.png'), e0, 'hand edit kept');
  assert.deepEqual(read(root, 'blob_s1_idle_01.png'), e1, '1-px shift kept');
  assert.equal(cmdValidate(root, 'blob_s1').warns.filter((w) => /raw changed/.test(w)).length, 2);
});

test('fixture 16: retranslated and renumbered (no pixel edit) followers are refreshed; --anim limits; backfill; migrated and RGBA files are not', () => {
  const root = tmpRoot();
  addUnit(root, { cw: 16, ch: 18 });
  addUnit(root, { id: 'w', anim: 'walk', seed: 40, cw: 16, ch: 18 });
  cmdPromote(root, 'blob_s1');
  // a wider unit moves T → retranslate keeps written_sha256 in step
  addUnit(root, { id: 'h', anim: 'happy', seed: 50, cw: 30, ch: 26, n: 1, dx: 6 });
  cmdPromote(root, 'blob_s1');
  cmdRetranslate(root, 'blob_s1', { yes: true });
  for (const [n, e] of Object.entries(pl(root).files)) assert.equal(e.written_sha256, sha256File(path.join(D(root), n)), n);
  // renumber (swap walk_00 ↔ walk_01) through the editor, no pixel edits
  const st = load(root);
  const w0 = st.frames.find((f) => f.name === 'blob_s1_walk_00.png'), w1 = st.frames.find((f) => f.name === 'blob_s1_walk_01.png');
  w0.name = 'blob_s1_walk_01.png'; w1.name = 'blob_s1_walk_00.png';
  cmdCleanSave(root, 'blob_s1', st);
  assert.ok(pl(root).files['blob_s1_walk_00.png'].written_sha256, 'written_sha256 survives a rename');
  // replace idle and walk; promote --anim idle refreshes only idle
  addUnit(root, { seed: 91, cw: 16, ch: 18, yes: true });
  addUnit(root, { id: 'w', anim: 'walk', seed: 61, cw: 16, ch: 18, yes: true });
  const ri = cmdPromote(root, 'blob_s1', { anim: 'idle' });
  assert.deepEqual(ri.refreshed.sort(), ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
  const rw = cmdPromote(root, 'blob_s1');
  assert.deepEqual(rw.refreshed.sort(), ['blob_s1_walk_00.png', 'blob_s1_walk_01.png']);
  // the swapped follower keeps its filename and takes its own raw frame
  assert.deepEqual(read(root, 'blob_s1_walk_00.png'), raw(root, 'blob_s1_walk_01.png'));

  // (f) a migrated entry without written_sha256: byte-identical to raw → backfilled; otherwise left alone
  const p = pl(root);
  delete p.files['blob_s1_idle_00.png'].written_sha256; p.files['blob_s1_idle_00.png'].raw_content_sha256 = null;
  delete p.files['blob_s1_idle_01.png'].written_sha256;
  fs.writeFileSync(path.join(D(root), 'blob_s1.placement.json'), JSON.stringify(p));
  const I1 = decodePng(new Uint8Array(read(root, 'blob_s1_idle_01.png'))).indexed.data.slice(); I1[0] = 0;
  fs.writeFileSync(path.join(D(root), 'blob_s1_idle_01.png'), encodeCanonical({ w: 64, h: 64, I: I1 }, cfg));
  const rb = cmdPromote(root, 'blob_s1');
  assert.deepEqual(rb.backfilled, ['blob_s1_idle_00.png']);
  assert.ok(pl(root).files['blob_s1_idle_00.png'].raw_content_sha256, 'backfill also records the content hash');
  // (g) an RGBA save of walk_00 (same pixels, not canonical) is never auto-refreshed
  const Iw = decodePng(new Uint8Array(read(root, 'blob_s1_walk_00.png')));
  fs.writeFileSync(path.join(D(root), 'blob_s1_walk_00.png'), encodePng({ w: 64, h: 64, colorType: 6, bitDepth: 8, data: Iw.rgba }));
  const rgbaBytes = read(root, 'blob_s1_walk_00.png');
  addUnit(root, { seed: 93, cw: 16, ch: 18, yes: true });
  addUnit(root, { id: 'w', anim: 'walk', seed: 63, cw: 16, ch: 18, yes: true });
  const rr = cmdPromote(root, 'blob_s1');
  assert.deepEqual(rr.refreshed.sort(), ['blob_s1_idle_00.png', 'blob_s1_walk_01.png']);
  assert.deepEqual(read(root, 'blob_s1_walk_00.png'), rgbaBytes);
});

test('fixture 16: crash after the rename and before placement.json (with a T change) → marker; others refuse; promote finishes exactly', () => {
  const root = tmpRoot();
  addUnit(root);
  cmdPromote(root, 'blob_s1');
  addUnit(root, { seed: 95, cw: 24, ch: 26, dx: 4, yes: true }); // different pixels and a new T
  hooks.promoteBeforePlacement = () => { throw new Error('simulated crash'); };
  try { assert.throws(() => cmdPromote(root, 'blob_s1'), /simulated crash/); } finally { hooks.promoteBeforePlacement = null; }
  assert.ok(fs.existsSync(path.join(D(root), 'blob_s1.promote.pending.json')));
  assert.ok(cmdValidate(root, 'blob_s1').fails.some((f) => /interrupted promote/.test(f)));
  assert.throws(() => cmdRetranslate(root, 'blob_s1', { yes: true }), /interrupted promote/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', load(root)), /interrupted promote/);
  assert.throws(() => cmdPromote(root, 'blob_s1', { force: 'blob_s1_idle_00.png', yes: true }), /interrupted promote/);
  assert.throws(() => addUnit(root, { seed: 96, yes: true }), /interrupted promote/);
  assert.throws(() => cmdNormalize([path.join(D(root), 'blob_s1_idle_00.png')], { yes: true }), /interrupted promote/);
  const r = cmdPromote(root, 'blob_s1', { anim: 'idle' });
  assert.equal(r.resumed, true);
  assert.ok(!fs.existsSync(path.join(D(root), 'blob_s1.promote.pending.json')));
  for (const n of ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']) {
    assert.deepEqual(read(root, n), raw(root, n));
    assert.equal(pl(root).files[n].written_sha256, sha256File(path.join(D(root), n)));
  }
  const v = cmdValidate(root, 'blob_s1');
  assert.ok(!v.fails.some((f) => /run retranslate|interrupted/.test(f)), v.fails.join('\n'));
  assert.deepEqual(cmdRetranslate(root, 'blob_s1', { yes: true }).shifted, [], 'nothing left to shift (no double shift)');
});

test('fixture 16: resume refuses when a file is in neither the old nor the new state', () => {
  const root = tmpRoot();
  addUnit(root);
  cmdPromote(root, 'blob_s1');
  addUnit(root, { seed: 97, yes: true });
  hooks.promoteBeforePlacement = () => { throw new Error('crash'); };
  try { assert.throws(() => cmdPromote(root, 'blob_s1'), /crash/); } finally { hooks.promoteBeforePlacement = null; }
  const I = decodePng(new Uint8Array(read(root, 'blob_s1_idle_00.png'))).indexed.data.slice(); I[0] = 1;
  fs.writeFileSync(path.join(D(root), 'blob_s1_idle_00.png'), encodeCanonical({ w: 64, h: 64, I }, cfg));
  assert.throws(() => cmdPromote(root, 'blob_s1'), /changed since the interrupted promote/);
});

function req(port, token, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(token ? { 'X-PP-Token': token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const b = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('fixture 16: /api/add reports promote.refreshed; a pending clean-save marker makes add refuse (422)', async () => {
  const root = tmpRoot();
  addUnit(root);
  cmdPromote(root, 'blob_s1');
  const png = stripPng(20, 22, 99, 2);
  const a = cmdArchiveBytes(root, png, 'blob');
  const srv = await startServer({ root, port: 0, page: '<html>/*__SERVER__*/null</html>' });
  try {
    const frag = { species: 'blob', stage: 1, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', strip: { n: 2 }, params: {} } };
    const c = await req(srv.port, srv.token, 'POST', '/api/add', { fragment: frag });
    assert.equal(c.status, 409);
    assert.match(c.json.confirm, /never edited will then be updated/);
    const ok = await req(srv.port, srv.token, 'POST', '/api/add', { fragment: frag, yes: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.promote.refreshed.sort(), ['blob_s1_idle_00.png', 'blob_s1_idle_01.png']);
    const g = await req(srv.port, srv.token, 'GET', '/api/group/blob_s1');
    assert.deepEqual(g.json.raw_changed, []);
    assert.equal(g.json.pending, null);
    fs.writeFileSync(path.join(D(root), 'blob_s1.clean-save.pending.json'), JSON.stringify({ trash: '.trash/x' }));
    const blocked = await req(srv.port, srv.token, 'POST', '/api/add', { fragment: frag, yes: true });
    assert.equal(blocked.status, 422);
    assert.match(blocked.json.error, /interrupted clean-save/);
    const g2 = await req(srv.port, srv.token, 'GET', '/api/group/blob_s1');
    assert.equal(g2.json.pending.kind, 'clean-save'); assert.equal(g2.json.pending.trash, '.trash/x');
  } finally { await srv.close(); }
});

test('fixture 17: species-add keeps the file byte-identical except that line; refusals leave the config unchanged', async () => {
  const before = fs.readFileSync(cfgCopy, 'utf8');
  for (const [id, st] of [['egg', 0], ['Bad', 0], ['foo_s1', 0], ['a'.repeat(25), 0], ['ok_id', 9], ['ok_id', '__proto__'], ['ok_id', 'constructor'], ['9lives', 1], ['a__b', 1]]) {
    assert.throws(() => cmdSpeciesAdd(null, id, st), Error, `${id}/${st}`);
    assert.equal(fs.readFileSync(cfgCopy, 'utf8'), before, `${id}/${st} left the config unchanged`);
  }
  const r = cmdSpeciesAdd(null, 'fire_egg', 0);
  assert.equal(r.rewritten, 'line');
  const after = fs.readFileSync(cfgCopy, 'utf8');
  const diff = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.equal(diff.length, 1); assert.match(diff[0], /"egg", "fire_egg"/);
  assert.ok(loadConfig().stages['0'].species.includes('fire_egg'));
  // add accepts the new species
  const root = tmpRoot();
  const png = stripPng(14, 16, 5, 2);
  const a = cmdArchiveBytes(root, png, 'fire_egg');
  const rep = cmdAddFragment(root, { species: 'fire_egg', stage: 0, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', strip: { n: 2 }, params: {} } });
  assert.equal(rep.batch_id, 'fire_egg_s0');
  // a file whose stage line cannot be edited textually → full rewrite, same parsed result
  const odd = { ...JSON.parse(after), notes: { 2: { species: ['not', 'a', 'stage'] } } }; // a second "2": { … "species": [ … ] } match
  const oddPath = path.join(path.dirname(cfgCopy), 'odd.json');
  fs.writeFileSync(oddPath, JSON.stringify(odd, null, 2));
  const r2 = cmdSpeciesAdd(null, 'ice_pup', 2, { configPath: oddPath });
  const parsed = JSON.parse(fs.readFileSync(oddPath, 'utf8'));
  assert.ok(parsed.stages['2'].species.includes('ice_pup'));
  assert.deepEqual(parsed.notes, odd.notes);
  assert.equal(r2.rewritten, 'full');
});

test('fixture 17: /api/species needs the token; the page served by the same run lists the new species', async () => {
  const root = tmpRoot();
  const srv = await startServer({ root, port: 0, page: null });
  try {
    assert.equal((await req(srv.port, null, 'POST', '/api/species', { id: 'storm_egg', stage: 0 })).status, 401);
    const bad = await req(srv.port, srv.token, 'POST', '/api/species', { id: 'x', stage: '__proto__' });
    assert.equal(bad.status, 422);
    const ok = await req(srv.port, srv.token, 'POST', '/api/species', { id: 'storm_egg', stage: 0 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const page = await req(srv.port, null, 'GET', '/');
    const m = /window\.PP_SERVER = (\{.*?\});/s.exec(page.text);
    assert.ok(m, 'server info inlined');
    assert.ok(JSON.parse(m[1]).config.stages['0'].species.includes('storm_egg'));
  } finally { await srv.close(); }
});

test('v3.4 page aids in Chromium: target line, group follows species, Use new raw, + New species, collision hint', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { t.skip('playwright-core missing'); return; }
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ }
  }
  if (!browser) { t.skip('no Chromium'); return; }
  const root = tmpRoot();
  addUnit(root);
  cmdPromote(root, 'blob_s1');
  // a human edit of idle_00, then the unit is replaced → idle_00 stays with "raw changed"; idle_01 follows
  const I = decodePng(new Uint8Array(read(root, 'blob_s1_idle_00.png'))).indexed.data.slice(); I[0] = 0;
  fs.writeFileSync(path.join(D(root), 'blob_s1_idle_00.png'), encodeCanonical({ w: 64, h: 64, I }, cfg));
  addUnit(root, { seed: 120, yes: true });
  assert.deepEqual(cmdPromote(root, 'blob_s1').refreshed, ['blob_s1_idle_01.png']);
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => document.getElementById('groupSel').value === 'blob_s1');
    await page.selectOption('#species', 'blob|1'); // v3.9: the page starts on the first species of the lowest stage (egg)
    assert.equal(await page.textContent('#addTarget'), '→ adds to blob_s1');
    await page.waitForSelector('#rawChanged button');
    assert.match(await page.textContent('#rawChanged'), /blob_s1_idle_00\.png: raw changed/);
    await page.click('#rawChanged button:text("Use new raw")');
    await page.waitForSelector('#confirmDlg[open]');
    assert.match(await page.textContent('#confirmMsg'), /blob_s1_idle_00\.png/);
    await page.click('#confirmOk');
    await page.waitForFunction(() => /now matches the new raw/.test(document.getElementById('messages').textContent));
    assert.deepEqual(read(root, 'blob_s1_idle_00.png'), raw(root, 'blob_s1_idle_00.png'));
    await page.waitForFunction(() => !document.querySelector('#rawChanged button'));
    // species / form drive the target line
    await page.selectOption('#species', 'puff|2');
    assert.equal(await page.textContent('#addTarget'), '→ creates puff_s2');
    // + New species…
    await page.selectOption('#species', '__new__');
    await page.waitForSelector('#speciesDlg[open]');
    await page.fill('#newSpId', 'foo_s1');
    await page.click('#newSpOk');
    await page.waitForFunction(() => /ambiguous/.test(document.getElementById('newSpErr').textContent));
    await page.fill('#newSpId', 'storm_pup');
    await page.click('#newSpOk');
    await page.waitForFunction(() => document.getElementById('species').value === 'storm_pup|2');
    assert.equal(await page.textContent('#addTarget'), '→ creates storm_pup_s2');
    assert.ok(loadConfig().stages['2'].species.includes('storm_pup'));
    // collision hint: same source as unit u1, new unit id
    await page.selectOption('#species', 'blob|1');
    const png = stripPng(20, 22, 120, 2);
    await page.evaluate(async (b) => { await window.PixelPipe.loadBytes('again.png', new Uint8Array(b)); }, Array.from(png));
    await page.fill('#nFrames', '2');
    await page.fill('#unitId', 's2');
    await page.waitForFunction(() => !document.getElementById('addBtn').disabled);
    await page.click('#addBtn');
    await page.waitForFunction(() => /set Unit id to "u1"/.test(document.getElementById('messages').textContent));
    assert.match(await page.textContent('#messages'), /First frame to 2/);
    if (process.env.PP_SHOTS) await page.screenshot({ path: path.join(os.tmpdir(), 'pp-v34.png') });
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); }
});
