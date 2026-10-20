// M7: FR-17 clean-save + restore (fixture 14).
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { cmdArchiveBytes, cmdAddFragment } from '../src/cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdValidate } from '../src/cli/commands3.js';
import { cmdCleanSave, cmdCleanRestore, hooks } from '../src/cli/cleansave.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { loadConfig, readJson, sha256File } from '../src/cli/store.js';
import { startServer } from '../src/server/serve.js';

const cfg = loadConfig();
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp7-'));

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

/** A blob_s1 group with idle_00, idle_01 promoted to clean. */
function setup({ frames = 2, cw = 20, ch = 22, anim = 'idle' } = {}) {
  const root = tmpRoot();
  const a = cmdArchiveBytes(root, stripPng(cw, ch, 70, frames), 'blob');
  cmdAddFragment(root, { species: 'blob', stage: 1, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim, strip: { n: frames }, params: {} } });
  cmdPromote(root, 'blob_s1');
  return root;
}
const cleanDir = (root) => path.join(root, 'art/clean/blob');

/** What the editor holds after loading the group: frames with from = own name. */
function load(root, id = 'blob_s1') {
  const dir = cleanDir(root);
  const pl = readJson(path.join(dir, `${id}.placement.json`));
  const names = fs.readdirSync(dir).filter((f) => f.startsWith(id + '_') && f.endsWith('.png')).sort();
  const loaded = Object.fromEntries(names.map((n) => [n, sha256File(path.join(dir, n))]));
  const frames = names.map((n) => ({ name: n, from: n, I: Array.from(decodePng(new Uint8Array(fs.readFileSync(path.join(dir, n)))).indexed.data), entry: { ...pl.files[n] } }));
  return { frames, loaded, loaded_placement_sha256: sha256File(path.join(dir, `${id}.placement.json`)) };
}
/** Snapshot of the clean folder (excluding .trash). */
function snap(root) {
  const dir = cleanDir(root);
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f !== '.trash').sort().map((f) => [f, sha256File(path.join(dir, f))]));
}
const rename = (fr, name) => ({ ...fr, name });

test('FR-17: a save with no edits writes nothing', () => {
  const root = setup();
  const before = snap(root);
  const r = cmdCleanSave(root, 'blob_s1', load(root));
  assert.equal(r.unchanged, true);
  assert.deepEqual(snap(root), before);
  assert.ok(!fs.existsSync(path.join(cleanDir(root), '.trash')));
});

test('FR-17: duplicate idle_00 → inserted as idle_01 (origin editor, inherits T); old idle_01 becomes idle_02; trash holds the superseded file', () => {
  const root = setup();
  const st = load(root);
  const [f0, f1] = st.frames;
  const old1 = fs.readFileSync(path.join(cleanDir(root), 'blob_s1_idle_01.png'));
  const dup = { name: 'blob_s1_idle_01.png', from: null, I: f0.I.slice(), entry: { T: f0.entry.T, origin: 'editor', raw_name: null, raw_content_sha256: null } };
  const r = cmdCleanSave(root, 'blob_s1', { ...st, frames: [f0, dup, rename(f1, 'blob_s1_idle_02.png')] });
  assert.deepEqual(r.tombstoned, []);
  const d = cleanDir(root);
  assert.deepEqual(fs.readFileSync(path.join(d, 'blob_s1_idle_01.png')), fs.readFileSync(path.join(d, 'blob_s1_idle_00.png')));
  assert.deepEqual(fs.readFileSync(path.join(d, 'blob_s1_idle_02.png')), old1);
  const pl = readJson(path.join(d, 'blob_s1.placement.json'));
  assert.equal(pl.files['blob_s1_idle_01.png'].origin, 'editor');
  assert.deepEqual(pl.files['blob_s1_idle_01.png'].T, f0.entry.T);
  assert.equal(pl.files['blob_s1_idle_02.png'].raw_name, 'blob_s1_idle_01.png', 'renumbered frame keeps its raw_name');
  assert.deepEqual(fs.readFileSync(path.join(root, r.trash, 'blob_s1_idle_01.png')), old1);
  assert.equal(r.validator.fails.length, 0, r.validator.fails.join('\n'));
  // promote afterwards copies nothing (both raw frames are claimed)
  assert.deepEqual(cmdPromote(root, 'blob_s1').copied, []);
  // every saved file equals encodeCanonical of its index array
  for (const n of ['blob_s1_idle_00.png', 'blob_s1_idle_01.png', 'blob_s1_idle_02.png']) {
    const I = decodePng(new Uint8Array(fs.readFileSync(path.join(d, n)))).indexed.data;
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(d, n))), encodeCanonical({ w: 64, h: 64, I }, cfg));
  }
});

test('FR-17: delete a raw-origin frame → 409 confirm, tombstone, .trash; promote does not bring it back', () => {
  const root = setup();
  const st = load(root);
  const keep = st.frames[1];
  const payload = { ...st, frames: [rename(keep, 'blob_s1_idle_00.png')] };
  assert.throws(() => cmdCleanSave(root, 'blob_s1', payload), (e) => e.code === 'CONFIRM' && /blob_s1_idle_00\.png/.test(e.message));
  const r = cmdCleanSave(root, 'blob_s1', payload, { yes: true });
  assert.deepEqual(r.tombstoned, ['blob_s1_idle_00.png']);
  const pl = readJson(path.join(cleanDir(root), 'blob_s1.placement.json'));
  assert.deepEqual(pl.tombstones.map((t) => t.raw_name), ['blob_s1_idle_00.png']);
  assert.equal(pl.files['blob_s1_idle_00.png'].raw_name, 'blob_s1_idle_01.png');
  assert.deepEqual(cmdPromote(root, 'blob_s1').copied, []);
  assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0);
});

test('FR-17: A↔B swap yields exactly the intended files', () => {
  const root = setup();
  const st = load(root);
  const [a, b] = st.frames;
  const A = fs.readFileSync(path.join(cleanDir(root), a.name)), B = fs.readFileSync(path.join(cleanDir(root), b.name));
  const r = cmdCleanSave(root, 'blob_s1', { ...st, frames: [rename(b, a.name), rename(a, b.name)] });
  assert.deepEqual(fs.readFileSync(path.join(cleanDir(root), a.name)), B);
  assert.deepEqual(fs.readFileSync(path.join(cleanDir(root), b.name)), A);
  assert.deepEqual(r.tombstoned, []);
  assert.deepEqual(r.trashed.sort(), [a.name, b.name]);
});

test('FR-17: insert a duplicate in the middle of a 4-frame anim', () => {
  const root = setup({ frames: 4, anim: 'walk' });
  const st = load(root);
  const fr = st.frames; // walk_00..03
  const dup = { name: 'x', from: null, I: fr[1].I.slice(), entry: { T: fr[1].entry.T, origin: 'editor', raw_name: null, raw_content_sha256: null } };
  const order = [fr[0], fr[1], dup, fr[2], fr[3]].map((f, i) => rename(f, `blob_s1_walk_${String(i).padStart(2, '0')}.png`));
  const prev = Object.fromEntries(fr.map((f) => [f.name, fs.readFileSync(path.join(cleanDir(root), f.name))]));
  cmdCleanSave(root, 'blob_s1', { ...st, frames: order });
  const got = (i) => fs.readFileSync(path.join(cleanDir(root), `blob_s1_walk_0${i}.png`));
  assert.deepEqual(got(0), prev['blob_s1_walk_00.png']);
  assert.deepEqual(got(1), prev['blob_s1_walk_01.png']);
  assert.deepEqual(got(2), prev['blob_s1_walk_01.png']);
  assert.deepEqual(got(3), prev['blob_s1_walk_02.png']);
  assert.deepEqual(got(4), prev['blob_s1_walk_03.png']);
});

test('FR-17: 412 when a loaded file changed on disk (even with yes), when a deleted frame changed, and when a file appeared', () => {
  const root = setup();
  const st = load(root);
  const d = cleanDir(root);
  const edited = { ...st, frames: st.frames.map((f, i) => (i === 0 ? { ...f, I: f.I.map((v, k) => (k === 0 ? 0 : v)) } : f)) };
  // Aseprite modifies idle_01 meanwhile
  const p1 = path.join(d, 'blob_s1_idle_01.png');
  const I = decodePng(new Uint8Array(fs.readFileSync(p1))).indexed.data.slice(); I[1] = 0;
  fs.writeFileSync(p1, encodeCanonical({ w: 64, h: 64, I }, cfg));
  assert.throws(() => cmdCleanSave(root, 'blob_s1', edited, { yes: true }), (e) => e.code === 'CONFLICT' && e.conflict.includes('blob_s1_idle_01.png'));
  // the deleted frame is the one that changed
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [st.frames[0]] }, { yes: true }), (e) => e.code === 'CONFLICT');
  // a new file appeared on disk
  const st2 = load(root);
  fs.copyFileSync(p1, path.join(d, 'blob_s1_idle_02.png'));
  assert.throws(() => cmdCleanSave(root, 'blob_s1', st2), (e) => e.code === 'CONFLICT' && /new on disk/.test(e.conflict.join()));
});

test('FR-17: a crash after renaming temps (renumber) leaves the marker; Validator FAILs; Restore gives back the exact prior state', () => {
  for (const point of ['afterTmp', 'beforePlacement']) {
    const root = setup();
    fs.writeFileSync(path.join(cleanDir(root), 'blob_s1_idle_01.notes.json'), JSON.stringify({ outline_override: true, reason: 'test' }));
    const before = snap(root);
    const st = load(root);
    const [a, b] = st.frames;
    hooks[point] = () => { throw new Error('simulated crash'); };
    try {
      assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [rename(b, a.name), rename(a, b.name)] }), /simulated crash/);
    } finally { hooks[point] = null; }
    const v = cmdValidate(root, 'blob_s1');
    assert.ok(v.fails.some((f) => /interrupted save/.test(f) && /\.trash\//.test(f)), v.fails.join('\n'));
    assert.throws(() => cmdPromote(root, 'blob_s1'), /interrupted clean-save/);
    assert.throws(() => cmdCleanRestore(root, 'blob_s1'), (e) => e.code === 'CONFIRM');
    cmdCleanRestore(root, 'blob_s1', { yes: true });
    assert.deepEqual(snap(root), before, point);
    assert.equal(cmdValidate(root, 'blob_s1').fails.length, 0);
  }
});

test('FR-17: notes files follow renumbered frames; notes of deleted frames go to .trash', () => {
  const root = setup();
  const d = cleanDir(root);
  fs.writeFileSync(path.join(d, 'blob_s1_idle_01.notes.json'), '{"outline_override":true,"reason":"r"}');
  const st = load(root);
  const [a, b] = st.frames;
  cmdCleanSave(root, 'blob_s1', { ...st, frames: [rename(b, a.name), rename(a, b.name)] });
  assert.equal(fs.readFileSync(path.join(d, 'blob_s1_idle_00.notes.json'), 'utf8'), '{"outline_override":true,"reason":"r"}');
  assert.ok(!fs.existsSync(path.join(d, 'blob_s1_idle_01.notes.json')));
  const st2 = load(root);
  const r = cmdCleanSave(root, 'blob_s1', { ...st2, frames: [rename(st2.frames[1], 'blob_s1_idle_00.png')] }, { yes: true });
  assert.ok(!fs.existsSync(path.join(d, 'blob_s1_idle_01.notes.json')));
  assert.ok(r.trashed.includes('blob_s1_idle_00.notes.json'));
});

test('FR-17: a duplicate made while T is behind is saved, and retranslate shifts it with its source', () => {
  const root = setup({ cw: 18, ch: 20 });
  const st = load(root);
  // a wider unit moves the group
  const a2 = cmdArchiveBytes(root, stripPng(30, 28, 90, 1), 'blob');
  cmdAddFragment(root, { species: 'blob', stage: 1, variant: 'base', unit: { id: 'u2', source: a2.path, source_sha256: a2.sha256, anim: 'happy', dx: 8, strip: { n: 1 }, params: {} } });
  const T = readJson(path.join(root, 'art/raw/blob/blob_s1.batch.json')).T;
  assert.notDeepEqual(T, st.frames[0].entry.T, 'T moved');
  const dup = { name: 'blob_s1_idle_02.png', from: null, I: st.frames[0].I.slice(), entry: { T: st.frames[0].entry.T, origin: 'editor', raw_name: null, raw_content_sha256: null } };
  cmdCleanSave(root, 'blob_s1', { ...load(root), frames: [...load(root).frames, dup] });
  cmdRetranslate(root, 'blob_s1', { yes: true });
  const d = cleanDir(root);
  assert.deepEqual(fs.readFileSync(path.join(d, 'blob_s1_idle_02.png')), fs.readFileSync(path.join(d, 'blob_s1_idle_00.png')));
  const pl = readJson(path.join(d, 'blob_s1.placement.json'));
  assert.deepEqual(pl.files['blob_s1_idle_02.png'].T, T);
});

test('FR-17: payload checks — off-palette index, bad names, gaps, double raw claim, foreign group', () => {
  const root = setup();
  const st = load(root);
  const [a, b] = st.frames;
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [{ ...a, I: a.I.map((v, i) => (i ? v : 7)) }, b] }), /outside the palette/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, rename(b, 'blob_s1_idle_02.png')] }), /contiguous/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, rename(b, '../x.png')] }), /frame filename/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, rename(b, 'puff_s2_idle_01.png')] }), /frame filename/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, { ...b, entry: { ...b.entry, raw_name: a.entry.raw_name } }] }), /claimed by both/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, { ...b, entry: { ...b.entry, raw_name: 'blob_s1_zzz_00.png' } }] }), /not a frame of the batch/);
});

function post(port, token, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { Host: `127.0.0.1:${port}`, 'X-PP-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString()) }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

test('FR-17: clean-save gives identical results from the CLI and /api/clean/save; 412 is not confirmable over HTTP', async () => {
  const r1 = setup(), r2 = setup();
  const mk = (root) => { const st = load(root); const [a, b] = st.frames; return { ...st, frames: [rename(b, a.name), rename(a, b.name)] }; };
  cmdCleanSave(r1, 'blob_s1', mk(r1));
  const srv = await startServer({ root: r2, port: 0, page: '<html></html>' });
  try {
    const payload = mk(r2);
    const res = await post(srv.port, srv.token, '/api/clean/save', { batch_id: 'blob_s1', payload });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.endsWith('placement.json')));
    assert.deepEqual(strip(snap(r2)), strip(snap(r1)));
    const pl = (r) => { const p = readJson(path.join(cleanDir(r), 'blob_s1.placement.json')); for (const t of p.tombstones) delete t.at; return p; };
    assert.deepEqual(pl(r2), pl(r1));
    const stale = await post(srv.port, srv.token, '/api/clean/save', { batch_id: 'blob_s1', payload, yes: true });
    assert.equal(stale.status, 412);
    assert.ok(stale.json.conflict.length);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- editor e2e in Chromium
async function chromiumOrSkip(t) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { t.skip('playwright-core missing'); return null; }
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* next */ }
  }
  t.skip('no Chromium'); return null;
}

test('Clean Editor in the browser: draw, duplicate, undo/redo, save; 412 offers choices; file mode is a sandbox', async (t) => {
  const browser = await chromiumOrSkip(t); if (!browser) return;
  const { loadPage } = await import('../src/server/serve.js');
  const root = setup();
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => document.getElementById('groupSel').value === 'blob_s1');
    await page.click('#gClean');
    await page.waitForFunction(() => document.body.classList.contains('editor-mode') && document.querySelectorAll('#edFrames .thumb').length === 2);
    // pencil, black, click pixel (5, 6)
    await page.keyboard.press('b'); await page.keyboard.press('1');
    const at = async (x, y) => { const box = await page.locator('#edCanvas').boundingBox(); return [box.x + (x + 0.5) * box.width / 64, box.y + (y + 0.5) * box.height / 64]; };
    await page.mouse.click(...(await at(5, 6)));
    await page.click('#edDup');
    assert.equal(await page.locator('#edFrames .thumb').count(), 3);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('#edFrames .thumb').count(), 2);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.locator('#edFrames .thumb').count(), 3);
    // shift refused when pixels would leave the canvas? (sprite is centred, so a 1-px shift is fine) → shift right then left = no-op
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
    const d = cleanDir(root);
    const old1 = fs.readFileSync(path.join(d, 'blob_s1_idle_01.png'));
    await page.click('#edSave');
    await page.waitForFunction(() => /Saved blob_s1/.test(document.getElementById('messages').textContent));
    const I0 = decodePng(new Uint8Array(fs.readFileSync(path.join(d, 'blob_s1_idle_00.png')))).indexed.data;
    assert.equal(I0[6 * 64 + 5], 0, 'drawn pixel saved');
    assert.deepEqual(fs.readFileSync(path.join(d, 'blob_s1_idle_01.png')), fs.readFileSync(path.join(d, 'blob_s1_idle_00.png')), 'duplicate');
    assert.deepEqual(fs.readFileSync(path.join(d, 'blob_s1_idle_02.png')), old1, 'renumbered');
    assert.equal(readJson(path.join(d, 'blob_s1.placement.json')).files['blob_s1_idle_01.png'].origin, 'editor');
    // conflict: Aseprite changes idle_02 while the page has an edit
    await page.mouse.click(...(await at(7, 6)));
    const p2 = path.join(d, 'blob_s1_idle_02.png');
    const I2 = decodePng(new Uint8Array(fs.readFileSync(p2))).indexed.data.slice(); I2[0] = 0;
    fs.writeFileSync(p2, encodeCanonical({ w: 64, h: 64, I: I2 }, cfg));
    await page.click('#edSave');
    await page.waitForSelector('#choiceDlg[open]');
    assert.match(await page.textContent('#choiceMsg'), /blob_s1_idle_02\.png/);
    await page.click('#choiceBtns button[data-value="merge"]');
    await page.waitForFunction(() => /Merged/.test(document.getElementById('messages').textContent));
    await page.click('#edSave');
    await page.waitForFunction(() => /Saved blob_s1/.test(document.getElementById('messages').textContent) && !document.querySelector('#edGroup').textContent.includes('unsaved'));
    assert.deepEqual(fs.readFileSync(p2), Buffer.from(encodeCanonical({ w: 64, h: 64, I: I2 }, cfg)), 'disk version of the frame I did not edit is kept');
    const I1b = decodePng(new Uint8Array(fs.readFileSync(path.join(d, 'blob_s1_idle_01.png')))).indexed.data;
    assert.equal(I1b[6 * 64 + 7], 0, 'my edit (on the active frame, idle_01, kept across the save) is kept');
    if (process.env.PP_SHOTS) await page.screenshot({ path: path.join(os.tmpdir(), 'pp-editor.png') });
    // an interrupted save: the editor shows Restore previous state
    fs.writeFileSync(path.join(d, 'blob_s1.clean-save.pending.json'), JSON.stringify({ batch_id: 'blob_s1', trash: '.trash/x-0', trashed: [], writes: [], placement_sha256_before: sha256File(path.join(d, 'blob_s1.placement.json')), placement_sha256_after: 'f'.repeat(64) }));
    await page.click('#edReload');
    await page.waitForSelector('#edRestore');
    assert.equal(await page.isDisabled('#edSave'), true);
    await page.click('#edRestore');
    await page.waitForSelector('#confirmDlg[open]');
    await page.click('#confirmOk');
    await page.waitForFunction(() => /restored 0 file/.test(document.getElementById('messages').textContent));
    assert.ok(!fs.existsSync(path.join(d, 'blob_s1.clean-save.pending.json')));
    assert.deepEqual(errors, []);

    // file mode: the same page file opened from disk is a sandbox
    const fpage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const ferr = []; fpage.on('pageerror', (e) => ferr.push(e.message));
    await fpage.goto('file://' + path.resolve('dist/pixel-tool.html'));
    const bytes = Array.from(fs.readFileSync(path.join(d, 'blob_s1_idle_00.png')));
    await fpage.evaluate((b) => { window.PixelPipe.editor.openFiles([{ name: 'blob_s1_idle_00.png', bytes: new Uint8Array(b) }]); }, bytes);
    assert.equal(await fpage.isDisabled('#edSave'), true);
    assert.match(await fpage.textContent('#edSaveHint'), /pixelpipe serve/);
    const bad = Array.from(encodePng({ w: 64, h: 64, colorType: 6, bitDepth: 8, data: new Uint8Array(64 * 64 * 4).fill(200) }));
    const msg = await fpage.evaluate((b) => { try { window.PixelPipe.editor.openFiles([{ name: 'blob_s1_idle_00.png', bytes: new Uint8Array(b) }]); return 'opened'; } catch (e) { return e.message; } }, bad);
    assert.match(msg, /partial alpha|not a palette colour/);
    assert.deepEqual(ferr, []);
  } finally { await srv.close(); await browser.close(); }
});

test('M7 review: bad-name files are left alone; a new frame does not inherit notes; payload names and indices are checked; restore keeps the interrupted edits', () => {
  const root = setup();
  const d = cleanDir(root);
  fs.copyFileSync(path.join(d, 'blob_s1_idle_00.png'), path.join(d, 'blob_s1_idle_1.png')); // an Aseprite-style name
  fs.writeFileSync(path.join(d, 'blob_s1_idle_01.notes.json'), '{"outline_override":true,"reason":"r"}');
  const st = load(root);
  delete st.loaded['blob_s1_idle_1.png'];
  st.frames = st.frames.filter((f) => f.name !== 'blob_s1_idle_1.png');
  const [a] = st.frames;
  // delete idle_01, duplicate idle_00 into its place
  const dup = { name: 'blob_s1_idle_01.png', from: null, I: a.I.slice(), entry: { T: a.entry.T, origin: 'editor', raw_name: null, raw_content_sha256: null } };
  const r = cmdCleanSave(root, 'blob_s1', { ...st, frames: [a, dup] }, { yes: true });
  assert.ok(fs.existsSync(path.join(d, 'blob_s1_idle_1.png')), 'bad-name file untouched');
  assert.ok(!fs.existsSync(path.join(d, 'blob_s1_idle_01.notes.json')), 'notes not inherited by the new frame');
  assert.ok(r.trashed.includes('blob_s1_idle_01.notes.json'));
  const st2 = load(root);
  delete st2.loaded['blob_s1_idle_1.png']; st2.frames = st2.frames.filter((f) => f.name !== 'blob_s1_idle_1.png');
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st2, loaded: { ...st2.loaded, '../../raw/blob/blob_s1_idle_00.png': 'x' } }), /not a frame filename/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st2, frames: [st2.frames[0], { ...st2.frames[1], from: '../x.png' }] }), /not a loaded file/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { ...st2, frames: [{ ...st2.frames[0], I: st2.frames[0].I.map((v, i) => (i ? v : 2.9)) }, st2.frames[1]] }), /integers/);
  assert.throws(() => cmdCleanSave(root, 'blob_s1', { frames: st2.frames, loaded: st2.loaded }), /loaded_placement_sha256/);
  // an interrupted save's own edits survive a restore (as *.interrupted in the trash folder)
  const edited = { ...st2, frames: [{ ...st2.frames[0], I: st2.frames[0].I.map((v, i) => (i === 0 ? 0 : v)) }, st2.frames[1]] };
  hooks.beforePlacement = () => { throw new Error('crash'); };
  try { assert.throws(() => cmdCleanSave(root, 'blob_s1', edited), /crash/); } finally { hooks.beforePlacement = null; }
  const m = readJson(path.join(d, 'blob_s1.clean-save.pending.json'));
  cmdCleanRestore(root, 'blob_s1', { yes: true });
  assert.ok(fs.existsSync(path.join(d, m.trash, 'blob_s1_idle_00.png.interrupted')));
});
