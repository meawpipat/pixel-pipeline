// Regression tests for the M1–M4 gate review (dev-qa-loop round 1) findings.
import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { detectAxis } from '../src/core/grid.js';
import { validateGroup } from '../src/core/validate.js';
import { checkConfig } from '../src/core/config.js';
import { cmdArchive, cmdAdd, cmdRebuild } from '../src/cli/commands.js';
import { cmdPromote, cmdExport } from '../src/cli/commands3.js';
import { loadConfig, readJson } from '../src/cli/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '../src/cli/index.js');
const cfg = loadConfig();
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'));

function addSprite(root, species, stage, cw, ch, extra = {}) {
  const s = makeSprite(cw, ch, cw * 3 + ch), F = 10, W = (cw + 2) * F, H = (ch + 2) * F;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const v = s.I[y * cw + x]; if (v === 4) continue; for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 1) * F + py) * W + (x + 1) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; } }
  const file = path.join(root, `in-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(file, encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba }));
  const a = cmdArchive(root, file, species);
  const frag = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(frag, JSON.stringify({ species, stage, variant: 'base', ...extra.top, unit: { id: extra.id || 'u1', source: a.path, source_sha256: a.sha256, anim: extra.anim || 'idle', strip: { n: 1 }, params: {}, ...extra.unit } }));
  return () => cmdAdd(root, frag);
}

test('add is atomic: a failing add leaves batch and sidecars untouched', () => {
  const root = tmpRoot();
  addSprite(root, 'apex', 4, 20, 30)();
  const bp = path.join(root, 'art/raw/apex/apex_s4.batch.json');
  const before = fs.readFileSync(bp, 'utf8');
  const files = fs.readdirSync(path.join(root, 'art/raw/apex')).sort();
  assert.throws(addSprite(root, 'apex', 4, 20, 72, { id: 'tall', anim: 'walk' }), /cannot fit/);
  assert.equal(fs.readFileSync(bp, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'art/raw/apex')).sort(), files);
  assert.deepEqual(cmdRebuild(root, 'apex_s4', { check: true, out: path.join(root, 't') }).mismatches, []);
});

test('rebuild --check without --out never writes into art/raw', () => {
  const root = tmpRoot();
  addSprite(root, 'blob', 1, 20, 20)();
  const raw = path.join(root, 'art/raw/blob/blob_s1_idle_00.png');
  fs.writeFileSync(raw, 'tampered');
  const r = cmdRebuild(root, 'blob_s1', { check: true });
  assert.ok(r.mismatches.length > 0);
  assert.equal(fs.readFileSync(raw, 'utf8'), 'tampered');
});

test('dither_anchor from the fragment is stored in the batch and used by export', () => {
  const root = tmpRoot();
  addSprite(root, 'blob', 1, 20, 20, { top: { dither_anchor: 'sprite' } })();
  assert.equal(readJson(path.join(root, 'art/raw/blob/blob_s1.batch.json')).dither_anchor, 'sprite');
  cmdPromote(root, 'blob_s1');
  assert.equal(cmdExport(root, 'blob_s1').anchor, 'sprite');
  assert.throws(addSprite(root, 'blob', 1, 21, 20, { id: 'u9', anim: 'happy', top: { dither_anchor: 'diagonal' } }), /dither_anchor/);
});

test('C header links when included from two translation units', (t) => {
  const gcc = spawnSync('gcc', ['--version']);
  if (gcc.status !== 0) { t.skip('gcc not available'); return; }
  const root = tmpRoot();
  addSprite(root, 'blob', 1, 20, 20)();
  cmdPromote(root, 'blob_s1'); cmdExport(root, 'blob_s1', { formats: 'h' });
  const dir = path.join(root, 'art/export/blob');
  fs.writeFileSync(path.join(dir, 'a.c'), '#include "blob_s1.h"\nint a(void){return blob_s1_idle[0].px[0];}\n');
  fs.writeFileSync(path.join(dir, 'b.c'), '#include "blob_s1.h"\nint a(void);\nint main(void){return a()+blob_s1_idle_00_mask[0]*0+BLOB_S1_IDLE_COUNT*0;}\n');
  execFileSync('gcc', ['-Wall', '-o', path.join(dir, 'prog'), path.join(dir, 'a.c'), path.join(dir, 'b.c')], { stdio: 'pipe' });
});

test('decodePng rejects absurd dimensions before allocating; grid rejects bad periods', () => {
  const ok = encodePng({ w: 1, h: 1, colorType: 0, bitDepth: 8, data: new Uint8Array([0]) });
  const big = new Uint8Array(ok); new DataView(big.buffer).setUint32(16, 900000);
  assert.throws(() => decodePng(big), /outside/);
  const g = new Float64Array(200);
  for (const p of [-5, 0, 0.001, 1.5, 65, NaN]) assert.throws(() => detectAxis(g, { period: p, phase: 0 }), /period/);
  assert.throws(() => detectAxis(g, { period: 10, phase: NaN }), /phase/);
});

test('add rejects non-integer offsets; numeric-string stage accepted', () => {
  const root = tmpRoot();
  assert.throws(addSprite(root, 'blob', 1, 20, 20, { unit: { dx: 1.5 } }), /dx/);
  const r = addSprite(root, 'puff', '2', 20, 20)();
  assert.equal(r.batch_id, 'puff_s2');
});

test('validator reports a wrong-size file without crashing', () => {
  const small = encodePng({ w: 32, h: 32, colorType: 3, bitDepth: 8, data: new Uint8Array(1024).fill(4), palette: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255], [255, 0, 255]], trns: [255, 255, 255, 255, 0] });
  const r = validateGroup({ mode: 'raw', batchId: 'blob_s1', files: [{ name: 'blob_s1_idle_00.png', bytes: small }], batch: { stage: 1, variant: 'base', T: [0, 0] }, cfg });
  assert.ok(r.fails.some((f) => /size 32x32/.test(f)));
});

test('config check refuses luma weights the code does not implement', () => {
  assert.throws(() => checkConfig({ ...cfg, luma: { ...cfg.luma, wr: 300 } }), /luma/);
});

test('CLI: option without value errors; ci ignores stray files in art/raw', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'art/raw'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/raw/.DS_Store'), 'x');
  const r = spawnSync(process.execPath, [cli, 'ci', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const r2 = spawnSync(process.execPath, [cli, 'rebuild', 'blob_s1', '--out'], { encoding: 'utf8' });
  assert.notEqual(r2.status, 0); assert.match(r2.stderr, /--out needs a value/);
});
