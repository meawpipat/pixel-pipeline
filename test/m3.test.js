import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { cmdArchive, cmdAdd } from '../src/cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdNormalize, cmdValidate, cmdExport, normalizeBytes } from '../src/cli/commands3.js';
import { validateGroup } from '../src/core/validate.js';
import { ditherCanvas, unpackPlane } from '../src/core/dither.js';
import { toBin, frameData } from '../src/core/exportfmt.js';
import { encodeCanonical } from '../src/core/pipeline.js';
import { loadConfig, readJson } from '../src/cli/store.js';

const cfg = loadConfig();
const F = 10;
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp3-'));

function strip(frames, cellW, cellH, offsets = []) {
  const W = frames.length * cellW * F, H = cellH * F;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  frames.forEach((fr, k) => {
    const [ox, oy] = offsets[k] || [1, 1];
    for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) {
      const v = fr.I[y * fr.w + x]; if (v === 4) continue;
      for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) {
        const q = (((oy + y) * F + py) * W + (k * cellW + ox + x) * F + px) * 4;
        rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v];
      }
    }
  });
  return { w: W, h: H, rgba };
}
function add(root, species, stage, img, u) {
  const file = path.join(root, `in-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(file, encodePng({ w: img.w, h: img.h, colorType: 6, bitDepth: 8, data: img.rgba }));
  const a = cmdArchive(root, file, species);
  const frag = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(frag, JSON.stringify({ species, stage, variant: 'base', unit: { id: u.id, source: a.path, source_sha256: a.sha256, anim: u.anim, frame_start: 0, strip: { n: u.n || 1 }, dx: u.dx || 0, dy: 0, params: {} } }));
  return cmdAdd(root, frag);
}
const readI = (p) => decodePng(new Uint8Array(fs.readFileSync(p))).indexed.data;

function setupGroup(root) {
  const s = makeSprite(20, 24, 21);
  add(root, 'puff', 2, strip([s, s], 22, 26, [[1, 1], [1, 1]]), { id: 'idle', anim: 'idle', n: 2 });
  return s;
}

test('FR-15: promote/retranslate both orders give identical clean folders; old frames shifted by ΔT', () => {
  const results = [];
  for (const order of [['retranslate', 'promote'], ['promote', 'retranslate']]) {
    const root = tmpRoot();
    setupGroup(root);
    cmdPromote(root, 'puff_s2');
    const cleanDir = path.join(root, 'art/clean/puff');
    // simulate human cleanup: paint one pixel of idle_00 black
    const p0 = path.join(cleanDir, 'puff_s2_idle_00.png');
    const I0 = readI(p0); const k = I0.findIndex((v) => v === 3); I0[k] = 0;
    fs.writeFileSync(p0, encodeCanonical({ w: 64, h: 64, I: I0 }, cfg));
    const T0 = readJson(path.join(root, 'art/raw/puff/puff_s2.batch.json')).T;
    add(root, 'puff', 2, strip([makeSprite(36, 20, 22)], 38, 26), { id: 'act', anim: 'action', dx: 7 }); // wider + offset → T changes
    const T1 = readJson(path.join(root, 'art/raw/puff/puff_s2.batch.json')).T;
    assert.notDeepEqual(T0, T1);
    assert.equal(cmdValidate(root, 'puff_s2').ok, false); // T mismatch + missing counterpart
    for (const c of order) {
      if (c === 'promote') cmdPromote(root, 'puff_s2', { anim: 'action' });
      else {
        assert.throws(() => cmdRetranslate(root, 'puff_s2'), (e) => e.code === 'CONFIRM');
        cmdRetranslate(root, 'puff_s2', { yes: true });
      }
    }
    const after = readI(p0);
    const d = [T1[0] - T0[0], T1[1] - T0[1]];
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const X = x + d[0], Y = y + d[1];
      if (X >= 0 && Y >= 0 && X < 64 && Y < 64) assert.equal(after[Y * 64 + X], I0[y * 64 + x]);
    }
    const v = cmdValidate(root, 'puff_s2');
    assert.deepEqual(v.fails, []);
    results.push(Object.fromEntries(fs.readdirSync(cleanDir).filter((f) => f.endsWith('.png')).map((f) => [f, Buffer.from(fs.readFileSync(path.join(cleanDir, f))).toString('base64')])));
  }
  assert.deepEqual(results[0], results[1]);
});

test('FR-15 promote never overwrites without --force + --yes', () => {
  const root = tmpRoot(); setupGroup(root);
  cmdPromote(root, 'puff_s2');
  const p = path.join(root, 'art/clean/puff/puff_s2_idle_00.png');
  fs.writeFileSync(p, normalizeBytes(fs.readFileSync(p), cfg)); // unchanged content
  const before = fs.readFileSync(p);
  const r = cmdPromote(root, 'puff_s2');
  assert.deepEqual(r.copied, []); assert.equal(r.skipped.length, 2);
  assert.throws(() => cmdPromote(root, 'puff_s2', { force: 'puff_s2_idle_00.png' }), (e) => e.code === 'CONFIRM');
  assert.deepEqual(fs.readFileSync(p), before);
  const f = cmdPromote(root, 'puff_s2', { force: 'puff_s2_idle_00.png', yes: true }).forced[0];
  assert.equal(f.clean, 'puff_s2_idle_00.png');
  assert.ok(fs.existsSync(path.join(root, f.trash, 'puff_s2_idle_00.png')), 'replaced file kept in .trash/');
});

test('FR-15 normalize: Photoshop-style 4-bit reordered palette → canonical, same pixels; refuses off-palette', () => {
  const root = tmpRoot();
  const I = new Uint8Array(64 * 64); for (let i = 0; i < I.length; i++) I[i] = i % 5;
  const order = [3, 4, 0, 2, 1]; // file palette index → canonical index
  const inv = order.map((_, fileIdx) => fileIdx);
  const pal = [[255, 255, 255], [255, 0, 255], [0, 0, 0], [170, 170, 170], [85, 85, 85]];
  const data = I.map((c) => order.indexOf(c));
  const f = path.join(root, 'x.png');
  fs.writeFileSync(f, encodePng({ w: 64, h: 64, colorType: 3, bitDepth: 4, data, palette: pal, trns: [255, 0] }));
  assert.ok(inv.length === 5);
  assert.throws(() => cmdNormalize([f]), (e) => e.code === 'CONFIRM');
  cmdNormalize([f], { yes: true });
  assert.deepEqual(readI(f), I);
  const bad = path.join(root, 'bad.png');
  const rgba = new Uint8Array(64 * 64 * 4).fill(255); rgba[0] = 12;
  fs.writeFileSync(bad, encodePng({ w: 64, h: 64, colorType: 6, bitDepth: 8, data: rgba }));
  assert.throws(() => cmdNormalize([bad], { yes: true }), /not a palette colour/);
});

test('FR-14: fat on stage 1 FAIL, extra anim / 3-frame Ultimate idle WARN, frame gap FAIL, missing placement entry FAIL', () => {
  const canvas = () => { const I = new Uint8Array(4096).fill(4); for (let y = 40; y <= 61; y++) for (let x = 20; x < 40; x++) I[y * 64 + x] = (x === 20 || x === 39 || y === 40 || y === 61) ? 0 : 3; return encodeCanonical({ w: 64, h: 64, I }, cfg); };
  const files = (names) => names.map((name) => ({ name, bytes: canvas() }));
  let r = validateGroup({ mode: 'raw', batchId: 'blob_s1-fat', files: files(['blob_s1-fat_idle_00.png']), batch: { stage: 1, variant: 'fat', T: [0, 0] }, cfg });
  assert.ok(r.fails.some((f) => /fat/.test(f)));
  r = validateGroup({ mode: 'raw', batchId: 'apex_s4', files: files(['apex_s4_idle_00.png', 'apex_s4_idle_01.png', 'apex_s4_idle_02.png', 'apex_s4_dance_00.png']), batch: { stage: 4, variant: 'base', T: [0, 0] }, cfg });
  assert.ok(r.warns.some((w) => /dance/.test(w)));
  assert.ok(r.warns.some((w) => /"idle" has 3 frames/.test(w)));
  r = validateGroup({ mode: 'raw', batchId: 'blob_s1', files: files(['blob_s1_idle_00.png', 'blob_s1_idle_01.png', 'blob_s1_idle_03.png']), batch: { stage: 1, variant: 'base', T: [0, 0] }, cfg });
  assert.ok(r.fails.some((f) => /not contiguous/.test(f)));
  r = validateGroup({ mode: 'clean', batchId: 'blob_s1', files: files(['blob_s1_idle_00.png']), batch: { stage: 1, variant: 'base', T: [0, 0] }, placement: { files: {} }, rawShas: new Map([['blob_s1_idle_00.png', 'x']]), cfg });
  assert.ok(r.fails.some((f) => /no entry in placement/.test(f)));
  // bad filename in folder
  r = validateGroup({ mode: 'raw', batchId: 'blob_s1', files: files(['blob_s1_idle_00 (1).png']), batch: { stage: 1, variant: 'base', T: [0, 0] }, cfg });
  assert.ok(r.fails.some((f) => /bad filename/.test(f)));
});

test('§6 export (v3.8): .bin 1538 B, 4-grey PNG and .h decode to the same px/mask/ref; bit order; sprite anchor bob', () => {
  const root = tmpRoot(); setupGroup(root);
  cmdPromote(root, 'puff_s2');
  const r = cmdExport(root, 'puff_s2');
  const ex = path.join(root, 'art/export/puff');
  const bin = fs.readFileSync(path.join(ex, 'puff_s2_idle_00.bin'));
  assert.equal(bin.length, 1538);
  const clean = fs.readFileSync(path.join(root, 'art/clean/puff/puff_s2_idle_00.png'));
  const png = fs.readFileSync(path.join(ex, 'puff_s2_idle_00.png'));
  assert.deepEqual(png, clean, 'png = canonical clean bytes');
  const I = decodePng(new Uint8Array(png)).indexed.data;
  const mask = unpackPlane(bin.subarray(1024, 1536), 64, 64);
  for (let i = 0; i < 4096; i++) {
    const v = (bin[i >> 2] >> (6 - 2 * (i & 3))) & 3;
    assert.equal(v, I[i] === 4 ? 3 : I[i]);
    assert.equal(mask[i], I[i] === 4 ? 0 : 1);
  }
  const h = fs.readFileSync(path.join(ex, 'puff_s2.h'), 'utf8');
  const arr = (sym, n) => Uint8Array.from(h.match(new RegExp(`${sym}\\[${n}\\] PROGMEM = \\{([^}]*)\\}`))[1].split(',').map((x) => parseInt(x, 16)));
  assert.deepEqual(arr('puff_s2_idle_00_px', 1024), new Uint8Array(bin.subarray(0, 1024)));
  assert.deepEqual(arr('puff_s2_idle_00_mask', 512), new Uint8Array(bin.subarray(1024, 1536)));
  assert.match(h, new RegExp(`puff_s2_idle_00_px, puff_s2_idle_00_mask, ${bin[1536]}, ${bin[1537]} \\}`));
  assert.match(h, /#define PUFF_S2_IDLE_COUNT 2/);
  assert.match(h, /#define PUFF_S2_DITHER_ANCHOR_SPRITE 0/);
  assert.ok(r.written.includes('puff_s2.h'));
  // bit order: (0,0) black + opaque, (1,0) light grey
  const J = new Uint8Array(4096).fill(4); J[0] = 0; J[1] = 2;
  const b = toBin(frameData({ w: 64, h: 64, I: J }));
  assert.equal(b[0] >> 6, 0); assert.equal((b[0] >> 4) & 3, 2); assert.equal(b[0] & 15, 15); assert.ok(b[1024] & 0x80);
  // sprite anchor (oracle at s = 1): 1-px bob → identical pattern shifted by one row
  const blob = (dy) => { const K = new Uint8Array(4096).fill(4); for (let y = 30; y <= 50; y++) for (let x = 20; x < 40; x++) K[(y - dy) * 64 + x] = 1; return { w: 64, h: 64, I: K }; };
  const a0 = ditherCanvas(blob(0), cfg, 'sprite'), a1 = ditherCanvas(blob(1), cfg, 'sprite');
  for (let y = 0; y < 63; y++) for (let x = 0; x < 64; x++) assert.equal(a1.ink[y * 64 + x], a0.ink[(y + 1) * 64 + x]);
  const c0 = ditherCanvas(blob(0), cfg, 'canvas'), c1 = ditherCanvas(blob(1), cfg, 'canvas');
  let differs = false; for (let y = 0; y < 63; y++) for (let x = 0; x < 64; x++) if (c1.ink[y * 64 + x] !== c0.ink[(y + 1) * 64 + x]) differs = true;
  assert.ok(differs, 'canvas anchor shows crawl on odd bob');
});

test('export refuses when validator fails', () => {
  const root = tmpRoot(); setupGroup(root);
  assert.throws(() => cmdExport(root, 'puff_s2'), /validator FAIL/);
});
