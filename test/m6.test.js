// M6: FR-16 serve (fixture 13), FR-15 placement schema 2 (fixture 15), server-mode browser flow.
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { startServer, loadPage } from '../src/server/serve.js';
import { cmdArchiveBytes, cmdAddFragment, cmdRebuild } from '../src/cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdValidate } from '../src/cli/commands3.js';
import { contentHash } from '../src/core/placement.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { loadConfig, readJson, sha256File } from '../src/cli/store.js';

const cfg = loadConfig();
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp6-'));

function spritePng(cw, ch, seed, { frames = 1, F = 10, shiftUp = [] } = {}) {
  const s = makeSprite(cw, ch, seed), W = frames * (cw + 2) * F, H = (ch + 3) * F;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let k = 0; k < frames; k++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = s.I[y * cw + x]; if (v === 4) continue;
    const oy = 2 - (shiftUp.includes(k) ? 1 : 0);
    for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + oy) * F + py) * W + (k * (cw + 2) + 1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; }
  }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
const frag = (a, species, stage, unit) => ({ species, stage, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', strip: { n: 1 }, params: {}, ...unit } });

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); let j = null; try { j = JSON.parse(b.toString()); } catch { /* binary */ } resolve({ status: res.statusCode, json: j, body: b, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('FR-16 / NFR-06: token, Host, Origin and path checks', async () => {
  const root = tmpRoot();
  const srv = await startServer({ root, port: 0, page: '<html><script>window.PP_SERVER = /*__SERVER__*/null;</script></html>' });
  try {
    const P = srv.port, T = { 'X-PP-Token': srv.token };
    const page = await request(P);
    assert.equal(page.status, 200); assert.match(page.body.toString(), new RegExp(srv.token));
    assert.equal((await request(P, { path: '/api/state' })).status, 401);
    assert.equal((await request(P, { path: '/api/state', headers: { 'X-PP-Token': 'x'.repeat(32) } })).status, 401);
    assert.equal((await request(P, { path: '/api/state', headers: { ...T, Host: 'evil.example:80' } })).status, 403);
    assert.equal((await request(P, { path: '/', headers: { Host: `attacker.test:${P}` } })).status, 403, 'DNS rebinding blocked on the page too');
    assert.equal((await request(P, { method: 'POST', path: '/api/validate', headers: { ...T, Origin: 'https://evil.example' }, body: {} })).status, 403);
    assert.equal((await request(P, { method: 'POST', path: '/api/validate', headers: { ...T, Origin: 'null' }, body: {} })).status, 403);
    assert.equal((await request(P, { path: '/api/state', headers: { ...T, Origin: `http://localhost:${P}` } })).status, 200);
    assert.equal((await request(P, { path: '/api/state', headers: { ...T, Host: `localhost:${P}` } })).status, 200);
    const trav = await request(P, { path: '/api/file?path=' + encodeURIComponent('art/../../etc/passwd'), headers: T });
    assert.equal(trav.status, 422); assert.match(trav.json.error, /unsafe path/);
    const outside = await request(P, { path: '/api/file?path=' + encodeURIComponent('package.json'), headers: T });
    assert.equal(outside.status, 422);
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS');
  } finally { await srv.close(); }
});

test('FR-16: /api/add equals CLI add byte-for-byte; 409 confirm then yes; writes are serialised', async () => {
  const png = spritePng(20, 22, 61);
  const viaCli = tmpRoot(), viaApi = tmpRoot();
  const a1 = cmdArchiveBytes(viaCli, png, 'blob');
  cmdAddFragment(viaCli, frag(a1, 'blob', 1));
  const srv = await startServer({ root: viaApi, port: 0, page: '<html></html>' });
  try {
    const T = { 'X-PP-Token': srv.token };
    const a2 = (await request(srv.port, { method: 'POST', path: '/api/archive', headers: T, body: { species: 'blob', bytes_b64: Buffer.from(png).toString('base64') } })).json;
    assert.equal(a2.path, a1.path);
    const again = (await request(srv.port, { method: 'POST', path: '/api/archive', headers: T, body: { species: 'blob', bytes_b64: Buffer.from(png).toString('base64') } })).json;
    assert.equal(again.existing, true);
    const r = await request(srv.port, { method: 'POST', path: '/api/add', headers: T, body: { fragment: frag(a2, 'blob', 1) } });
    assert.equal(r.status, 200); assert.equal(r.json.promote.copied.length, 1);
    for (const rel of ['art/raw/blob/blob_s1_idle_00.png', 'art/raw/blob/blob_s1.batch.json', 'art/raw/blob/blob_s1_idle_00.json']) {
      const A = fs.readFileSync(path.join(viaCli, rel)), B = fs.readFileSync(path.join(viaApi, rel));
      if (rel.endsWith('.png')) assert.deepEqual(A, B, rel);
      else assert.deepEqual(JSON.parse(A), JSON.parse(B), rel);
    }
    const conf = await request(srv.port, { method: 'POST', path: '/api/add', headers: T, body: { fragment: frag(a2, 'blob', 1) } });
    assert.equal(conf.status, 409); assert.match(conf.json.confirm, /--yes/);
    const ok = await request(srv.port, { method: 'POST', path: '/api/add', headers: T, body: { fragment: frag(a2, 'blob', 1), yes: true } });
    assert.equal(ok.status, 200);
    // serialisation: 6 concurrent validates + a promote all succeed, none interleave into an error
    const rs = await Promise.all([...Array(6)].map(() => request(srv.port, { method: 'POST', path: '/api/validate', headers: T, body: { batch_id: 'blob_s1' } })).concat([request(srv.port, { method: 'POST', path: '/api/promote', headers: T, body: { batch_id: 'blob_s1' } })]));
    assert.ok(rs.every((x) => x.status === 200), JSON.stringify(rs.map((x) => x.status)));
    const st = await request(srv.port, { path: '/api/state', headers: T });
    assert.equal(st.json.groups[0].batch_id, 'blob_s1');
    const big = await request(srv.port, { method: 'POST', path: '/api/archive', headers: T, body: 'x'.repeat(65 * 1024 * 1024) });
    assert.equal(big.status, 413);
  } finally { await srv.close(); }
});

test('FR-16: adding a wider unit reports retranslate_needed; retranslate fixes the group', async () => {
  const root = tmpRoot();
  const srv = await startServer({ root, port: 0, page: '<html></html>' });
  try {
    const T = { 'X-PP-Token': srv.token };
    const post = (p, body) => request(srv.port, { method: 'POST', path: p, headers: T, body });
    const a = (await post('/api/archive', { species: 'puff', bytes_b64: Buffer.from(spritePng(18, 22, 62)).toString('base64') })).json;
    assert.equal((await post('/api/add', { fragment: frag(a, 'puff', 2) })).json.retranslate_needed, false);
    const b = (await post('/api/archive', { species: 'puff', bytes_b64: Buffer.from(spritePng(34, 20, 63)).toString('base64') })).json;
    const r = (await post('/api/add', { fragment: frag(b, 'puff', 2, { id: 'wide', anim: 'action', dx: 7 }) })).json;
    assert.equal(r.retranslate_needed, true);
    assert.equal(cmdValidate(root, 'puff_s2').ok, false);
    const c = await post('/api/retranslate', { batch_id: 'puff_s2' });
    assert.equal(c.status, 409);
    assert.equal((await post('/api/retranslate', { batch_id: 'puff_s2', yes: true })).status, 200);
    assert.deepEqual(cmdValidate(root, 'puff_s2').fails, []);
  } finally { await srv.close(); }
});

test('FR-15 schema 2: migration, content hash survives T change, name taken, --force after renumber, --adopt, --accept-raw', () => {
  const root = tmpRoot();
  const a = cmdArchiveBytes(root, spritePng(18, 22, 64, { frames: 2, shiftUp: [1] }), 'puff');
  cmdAddFragment(root, frag(a, 'puff', 2, { strip: { n: 2 } }));
  const clean = path.join(root, 'art/clean/puff'), raw = path.join(root, 'art/raw/puff');
  fs.mkdirSync(clean, { recursive: true });
  // a schema-1 placement as written by v3.2 tools
  const T0 = readJson(path.join(raw, 'puff_s2.batch.json')).T;
  const files = {};
  for (const n of ['puff_s2_idle_00.png', 'puff_s2_idle_01.png']) { fs.copyFileSync(path.join(raw, n), path.join(clean, n)); files[n] = { T: T0, raw_sha256: sha256File(path.join(raw, n)) }; }
  fs.writeFileSync(path.join(clean, 'puff_s2.placement.json'), JSON.stringify({ batch_id: 'puff_s2', files }));
  assert.deepEqual(cmdValidate(root, 'puff_s2').fails, []);
  cmdPromote(root, 'puff_s2'); // any write migrates
  const pl = readJson(path.join(clean, 'puff_s2.placement.json'));
  assert.equal(pl.schema, 2); assert.deepEqual(pl.tombstones, []);
  assert.equal(pl.files['puff_s2_idle_00.png'].origin, 'raw');
  assert.ok(pl.files['puff_s2_idle_00.png'].raw_content_sha256);
  // wider unit: every raw file rewritten at a new T → no "raw changed" WARN after retranslate
  const b = cmdArchiveBytes(root, spritePng(34, 20, 65), 'puff');
  cmdAddFragment(root, frag(b, 'puff', 2, { id: 'wide', anim: 'action', dx: 7 }));
  cmdRetranslate(root, 'puff_s2', { yes: true });
  cmdPromote(root, 'puff_s2');
  let v = cmdValidate(root, 'puff_s2');
  assert.deepEqual(v.fails, []); assert.ok(!v.warns.some((w) => /raw changed/.test(w)), v.warns.join('\n'));
  // content hash is translation-invariant
  const I = new Uint8Array(4096).fill(4); I[100] = 0; I[101] = 2;
  const J = new Uint8Array(4096).fill(4); J[100 + 64 * 3 + 5] = 0; J[101 + 64 * 3 + 5] = 2;
  assert.equal(contentHash(I, 64, 64), contentHash(J, 64, 64));
  // simulate the Clean Editor: delete raw-origin idle_00, renumber idle_01 → idle_00, tombstone idle_00
  const p = readJson(path.join(clean, 'puff_s2.placement.json'));
  fs.renameSync(path.join(clean, 'puff_s2_idle_01.png'), path.join(clean, 'puff_s2_idle_00.png'));
  p.files['puff_s2_idle_00.png'] = p.files['puff_s2_idle_01.png']; delete p.files['puff_s2_idle_01.png'];
  p.tombstones.push({ raw_name: 'puff_s2_idle_00.png', at: 'test' });
  fs.writeFileSync(path.join(clean, 'puff_s2.placement.json'), JSON.stringify(p));
  v = cmdValidate(root, 'puff_s2');
  assert.deepEqual(v.fails, []);
  // promote: raw idle_01 is claimed (by clean idle_00), raw idle_00 tombstoned → nothing copied, nothing overwritten
  const before = fs.readFileSync(path.join(clean, 'puff_s2_idle_00.png'));
  const pr = cmdPromote(root, 'puff_s2');
  assert.deepEqual(pr.copied, []);
  assert.deepEqual(fs.readFileSync(path.join(clean, 'puff_s2_idle_00.png')), before);
  // --force on the claimed raw frame replaces only its claimant and names it
  assert.throws(() => cmdPromote(root, 'puff_s2', { force: 'puff_s2_idle_01.png' }), (e) => e.code === 'CONFIRM' && /puff_s2_idle_00\.png/.test(e.message));
  // --force on the tombstoned raw frame: target name is taken by a frame claimed by another raw → refused without --to
  assert.throws(() => cmdPromote(root, 'puff_s2', { force: 'puff_s2_idle_00.png', yes: true }), /claimed by raw frame/);
  // hand-copied file: promote leaves it alone, Validator FAILs, --adopt registers it
  const hand = 'puff_s2_idle_01.png';
  fs.writeFileSync(path.join(clean, hand), encodeCanonical({ w: 64, h: 64, I: decodePng(new Uint8Array(before)).indexed.data }, cfg));
  const hb = fs.readFileSync(path.join(clean, hand));
  cmdPromote(root, 'puff_s2');
  assert.deepEqual(fs.readFileSync(path.join(clean, hand)), hb, 'never overwrites an existing filename');
  assert.ok(cmdValidate(root, 'puff_s2').fails.some((f) => /--adopt/.test(f)));
  cmdPromote(root, 'puff_s2', { adopt: hand });
  const e = readJson(path.join(clean, 'puff_s2.placement.json')).files[hand];
  assert.equal(e.origin, 'editor', 'raw idle_01 is already claimed, so the adopted file is editor-origin');
  // --accept-raw refreshes the content hash
  const pl2 = readJson(path.join(clean, 'puff_s2.placement.json'));
  pl2.files['puff_s2_idle_00.png'].raw_content_sha256 = 'stale';
  fs.writeFileSync(path.join(clean, 'puff_s2.placement.json'), JSON.stringify(pl2));
  assert.ok(cmdValidate(root, 'puff_s2').warns.some((w) => /raw changed/.test(w)));
  cmdPromote(root, 'puff_s2', { acceptRaw: 'puff_s2_idle_00.png' });
  assert.ok(!cmdValidate(root, 'puff_s2').warns.some((w) => /raw changed/.test(w)));
});

test('FR-14: marker and missing-file FAILs; name taken is a WARN, not a FAIL', () => {
  const root = tmpRoot();
  const a = cmdArchiveBytes(root, spritePng(18, 22, 66), 'blob');
  cmdAddFragment(root, frag(a, 'blob', 1));
  const clean = path.join(root, 'art/clean/blob');
  fs.mkdirSync(clean, { recursive: true });
  // an editor-made frame took the raw frame's name before promote
  fs.copyFileSync(path.join(root, 'art/raw/blob/blob_s1_idle_00.png'), path.join(clean, 'blob_s1_idle_00.png'));
  fs.writeFileSync(path.join(clean, 'blob_s1.placement.json'), JSON.stringify({ schema: 2, batch_id: 'blob_s1', files: { 'blob_s1_idle_00.png': { T: readJson(path.join(root, 'art/raw/blob/blob_s1.batch.json')).T, origin: 'editor', raw_name: null, raw_content_sha256: null } }, tombstones: [] }));
  let v = cmdValidate(root, 'blob_s1');
  assert.ok(v.warns.some((w) => /name taken/.test(w))); assert.ok(!v.fails.some((f) => /no clean counterpart/.test(f)));
  assert.deepEqual(cmdPromote(root, 'blob_s1').name_taken, ['blob_s1_idle_00.png']);
  fs.writeFileSync(path.join(clean, 'blob_s1.clean-save.pending.json'), '{}');
  assert.ok(cmdValidate(root, 'blob_s1').fails.some((f) => /interrupted save/.test(f)));
  assert.throws(() => cmdPromote(root, 'blob_s1'), /interrupted/);
  fs.renameSync(path.join(clean, 'blob_s1.clean-save.pending.json'), path.join(root, 'gone.json'));
  fs.renameSync(path.join(clean, 'blob_s1_idle_00.png'), path.join(root, 'gone.png'));
  assert.ok(cmdValidate(root, 'blob_s1').fails.some((f) => /entry without a file/.test(f)));
});

test('server mode in the browser: drop a raw image → auto-archive → Add to group → Validate', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { t.skip('playwright-core missing'); return; }
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ }
  }
  if (!browser) { t.skip('no Chromium'); return; }
  const root = tmpRoot();
  const srv = await startServer({ root, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => document.body.classList.contains('server-mode'));
    await page.selectOption('#species', 'blob|1');
    const png = spritePng(20, 20, 67);
    await page.evaluate(async (bytes) => { await window.PixelPipe.loadBytes('my_drawing.png', new Uint8Array(bytes)); }, Array.from(png));
    await page.waitForFunction(() => !document.getElementById('addBtn').disabled);
    await page.click('#addBtn');
    await page.waitForFunction(() => /Added unit/.test(document.getElementById('messages').textContent));
    assert.ok(fs.existsSync(path.join(root, 'art/clean/blob/blob_s1_idle_00.png')), 'promoted into clean');
    assert.equal(fs.readdirSync(path.join(root, 'art/source/blob')).length, 1, 'archived once');
    await page.selectOption('#groupSel', 'blob_s1');
    await page.click('#gValidate');
    await page.waitForFunction(() => /Validator blob_s1/.test(document.getElementById('messages').textContent));
    await page.click('#gExport');
    await page.waitForFunction(() => /Exported blob_s1/.test(document.getElementById('messages').textContent));
    assert.ok(fs.existsSync(path.join(root, 'art/export/blob/blob_s1.h')));
    if (process.env.PP_SHOTS) await page.screenshot({ path: path.join(os.tmpdir(), 'pp-serve-screenshot.png') });
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); }
});
