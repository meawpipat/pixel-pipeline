// Regression tests for the M6 gate review findings.
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeSprite, LV } from './fixtures.js';
import { encodePng } from '../src/core/png.js';
import { startServer } from '../src/server/serve.js';
import { cmdArchiveBytes, cmdAddFragment } from '../src/cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdValidate } from '../src/cli/commands3.js';
import { readJson } from '../src/cli/store.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pprm6-'));
function spritePng(cw, ch, seed, F = 10) {
  const s = makeSprite(cw, ch, seed), W = (cw + 2) * F, H = (ch + 3) * F, rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = s.I[y * cw + x]; if (v === 4) continue; for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 2) * F + py) * W + (x + 1) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; } }
  return encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba });
}
const frag = (a, species, stage, unit = {}) => ({ species, stage, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', strip: { n: 1 }, params: {}, ...unit } });
const req = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c)); } catch { /* */ } resolve({ status: res.statusCode, json: j }); }); });
  r.on('error', reject); if (data) r.write(data); r.end();
});

function group(root) {
  const a = cmdArchiveBytes(root, spritePng(18, 20, 71), 'blob');
  cmdAddFragment(root, frag(a, 'blob', 1));
  cmdPromote(root, 'blob_s1');
  return a;
}

test('promote --to / --adopt / --accept-raw / --force accept only frame filenames of the group', () => {
  const root = tmpRoot(); group(root);
  for (const bad of ['../../../pwned.png', 'art/raw/blob/blob_s1_idle_00.png', 'other_s1_idle_00.png', 'blob_s1_idle_00.png/..']) {
    assert.throws(() => cmdPromote(root, 'blob_s1', { force: 'blob_s1_idle_00.png', to: bad, yes: true }), /must be a frame filename/);
    assert.throws(() => cmdPromote(root, 'blob_s1', { adopt: bad }), /must be a frame filename/);
  }
  assert.ok(!fs.existsSync(path.join(root, 'pwned.png')));
});

test('--force refuses before touching anything when the raw frame is missing', () => {
  const root = tmpRoot(); group(root);
  fs.renameSync(path.join(root, 'art/raw/blob/blob_s1_idle_00.png'), path.join(root, 'moved.png'));
  assert.throws(() => cmdPromote(root, 'blob_s1', { force: 'blob_s1_idle_00.png', yes: true }), /raw frame missing/);
  assert.ok(fs.existsSync(path.join(root, 'art/clean/blob/blob_s1_idle_00.png')), 'clean file untouched');
  assert.ok(!fs.existsSync(path.join(root, 'art/clean/blob/.trash')));
});

test('retranslate is crash-safe: an interrupted run is finished exactly by the next run', () => {
  const root = tmpRoot();
  const a = cmdArchiveBytes(root, spritePng(18, 20, 72), 'puff');
  cmdAddFragment(root, frag(a, 'puff', 2, { strip: { n: 1 } }));
  const a2 = cmdArchiveBytes(root, spritePng(16, 20, 73), 'puff');
  cmdAddFragment(root, frag(a2, 'puff', 2, { id: 'u2', anim: 'walk' }));
  cmdPromote(root, 'puff_s2');
  const wide = cmdArchiveBytes(root, spritePng(34, 18, 74), 'puff');
  cmdAddFragment(root, frag(wide, 'puff', 2, { id: 'w', anim: 'action', dx: 7 }));
  const clean = path.join(root, 'art/clean/puff');
  const snapshot = () => Object.fromEntries(fs.readdirSync(clean).filter((f) => f.endsWith('.png')).map((f) => [f, fs.readFileSync(path.join(clean, f)).toString('base64')]));
  // reference: an uninterrupted retranslate in a copy
  const ref = tmpRoot(); fs.cpSync(root, ref, { recursive: true });
  cmdRetranslate(ref, 'puff_s2', { yes: true });
  const want = Object.fromEntries(fs.readdirSync(path.join(ref, 'art/clean/puff')).filter((f) => f.endsWith('.png')).map((f) => [f, fs.readFileSync(path.join(ref, 'art/clean/puff', f)).toString('base64')]));
  // crash after the first PNG is written
  const orig = fs.renameSync; let n = 0;
  fs.renameSync = (...args) => { if (String(args[1]).endsWith('.png') && ++n === 2) throw new Error('simulated crash'); return orig(...args); };
  try { assert.throws(() => cmdRetranslate(root, 'puff_s2', { yes: true }), /simulated crash/); } finally { fs.renameSync = orig; }
  assert.ok(fs.existsSync(path.join(clean, 'puff_s2.retranslate.pending.json')));
  assert.ok(cmdValidate(root, 'puff_s2').fails.some((f) => /interrupted retranslate/.test(f)));
  assert.throws(() => cmdPromote(root, 'puff_s2'), /interrupted/);
  const r = cmdRetranslate(root, 'puff_s2', { yes: true });
  assert.equal(r.resumed, true);
  assert.deepEqual(snapshot(), want, 'every frame shifted exactly once');
  assert.ok(!fs.existsSync(path.join(clean, 'puff_s2.retranslate.pending.json')));
  assert.equal(cmdValidate(root, 'puff_s2').fails.filter((f) => /retranslate|placed with/.test(f)).length, 0);
});

test('serve: non-ASCII token → 401; stray batch file does not break /api/state; concurrent adds are serialised', async () => {
  const root = tmpRoot();
  const srv = await startServer({ root, port: 0, page: '<html></html>' });
  try {
    const T = { 'X-PP-Token': srv.token };
    assert.equal((await req(srv.port, 'GET', '/api/state', { 'X-PP-Token': 'é'.repeat(32) })).status, 401);
    fs.mkdirSync(path.join(root, 'art/raw/blob'), { recursive: true });
    fs.writeFileSync(path.join(root, 'art/raw/blob/garbage.batch.json'), '{}');
    assert.equal((await req(srv.port, 'GET', '/api/state', T)).status, 200);
    const a = cmdArchiveBytes(root, spritePng(18, 20, 75), 'puff');
    const b = cmdArchiveBytes(root, spritePng(20, 18, 76), 'puff');
    const [r1, r2] = await Promise.all([
      req(srv.port, 'POST', '/api/add', T, { fragment: frag(a, 'puff', 2) }),
      req(srv.port, 'POST', '/api/add', T, { fragment: frag(b, 'puff', 2, { id: 'u2', anim: 'walk' }) }),
    ]);
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    const batch = readJson(path.join(root, 'art/raw/puff/puff_s2.batch.json'));
    assert.deepEqual(batch.units.map((u) => u.id).sort(), ['u1', 'u2'], 'both adds landed, none lost');
    const pl = readJson(path.join(root, 'art/clean/puff/puff_s2.placement.json'));
    assert.equal(Object.keys(pl.files).length, 2);
    const bad = await req(srv.port, 'POST', '/api/promote', T, { batch_id: 'puff_s2', to: ['x'] });
    assert.equal(bad.status, 400);
  } finally { await srv.close(); }
});
