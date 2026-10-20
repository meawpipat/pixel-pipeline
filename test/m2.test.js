import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { makeSprite, LV } from './fixtures.js';
import { encodePng, decodePng } from '../src/core/png.js';
import { inspect } from '../src/core/image.js';
import { cmdArchive, cmdAdd, cmdRebuild } from '../src/cli/commands.js';
import { readJson } from '../src/cli/store.js';

const F = 10; // source px per art pixel
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));

/** Render frames (index images) side by side; each frame occupies `cellW` cells; offsets [dx,dy] in cells. */
function renderStrip(frames, { cellW, cellH, f = F, margin = 30, offsets = [] }) {
  const W = frames.length * cellW * f + 2 * margin, H = cellH * f + 2 * margin;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
  frames.forEach((fr, k) => {
    const [ox, oy] = offsets[k] || [0, 0];
    for (let y = 0; y < fr.h; y++) for (let x = 0; x < fr.w; x++) {
      const v = fr.I[y * fr.w + x];
      if (v === 4) continue;
      const cx = k * cellW + ox + x, cy = oy + y;
      for (let py = 0; py < f; py++) for (let px = 0; px < f; px++) {
        const q = ((margin + cy * f + py) * W + margin + cx * f + px) * 4;
        rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v];
      }
    }
  });
  return { w: W, h: H, rgba };
}

function archiveImg(root, img, species) {
  const file = path.join(root, `in-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(file, encodePng({ w: img.w, h: img.h, colorType: 6, bitDepth: 8, data: img.rgba }));
  return cmdArchive(root, file, species);
}

function writeFrag(root, frag) {
  const p = path.join(root, `frag-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(frag));
  return p;
}

const unit = (a, extra = {}) => ({ id: extra.id || 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', frame_start: 0, strip: { n: 1 }, dx: 0, dy: 0, params: { tolerance: 60, flood_fill: true, auto_outline: false, stray_removal: false }, ...extra });

function rawCanvas(root, species, name) {
  return decodePng(new Uint8Array(fs.readFileSync(path.join(root, 'art/raw', species, name)))).indexed.data;
}
function bbox(I) {
  let l = 99, t = 99, r = -1, b = -1;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (I[y * 64 + x] !== 4) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
  return { l, t, r, b, w: r - l + 1, h: b - t + 1 };
}

test('FR-07: Egg 24x30 → x0=20, bottom=61; rebuild --check is byte-identical (FR-12)', () => {
  const root = tmpRoot();
  const s = makeSprite(26, 32, 3); // ellipse → opaque 24x30 after trim
  const a = archiveImg(root, renderStrip([s], { cellW: 26, cellH: 32 }), 'egg');
  const r = cmdAdd(root, writeFrag(root, { species: 'egg', stage: 0, variant: 'base', unit: unit(a) }));
  assert.equal(r.U.w, 24); assert.equal(r.U.h, 30);
  const bb = bbox(rawCanvas(root, 'egg', 'egg_s0_idle_00.png'));
  assert.equal(bb.l, 20); assert.equal(bb.b, 61);
  assert.equal(r.exceeds_box, false);
  const chk = cmdRebuild(root, 'egg_s0', { out: path.join(root, 'tmp'), check: true });
  assert.deepEqual(chk.mismatches, []);
  // tamper → mismatch
  fs.writeFileSync(path.join(root, 'art/raw/egg/egg_s0_idle_00.png'), 'x');
  assert.ok(cmdRebuild(root, 'egg_s0', { out: path.join(root, 'tmp2'), check: true }).mismatches.length > 0);
});

test('FR-07: oversize Egg flagged; 63/70 tall blocked; 47 wide → x0=8', () => {
  const root = tmpRoot();
  const big = makeSprite(32, 42, 4); // 30x40 opaque
  const a = archiveImg(root, renderStrip([big], { cellW: 32, cellH: 42 }), 'egg');
  const r = cmdAdd(root, writeFrag(root, { species: 'egg', stage: 0, variant: 'base', unit: unit(a) }));
  assert.equal(r.exceeds_box, true);
  for (const hgt of [65, 72]) { // opaque 63 / 70
    const root2 = tmpRoot();
    const t = makeSprite(30, hgt, 5);
    const b = archiveImg(root2, renderStrip([t], { cellW: 30, cellH: hgt }), 'apex');
    assert.throws(() => cmdAdd(root2, writeFrag(root2, { species: 'apex', stage: 4, variant: 'base', unit: unit(b) })), /cannot fit/);
  }
  const root3 = tmpRoot();
  const w47 = makeSprite(49, 40, 6); // 47 wide opaque
  const c = archiveImg(root3, renderStrip([w47], { cellW: 49, cellH: 40 }), 'fox');
  const r3 = cmdAdd(root3, writeFrag(root3, { species: 'fox', stage: 3, variant: 'base', unit: unit(c) }));
  assert.equal(r3.U.w, 47);
  assert.equal(bbox(rawCanvas(root3, 'fox', 'fox_s3_idle_00.png')).l, 8);
});

test('FR-13: 4-frame strip with 1-px bob; second strip + single pose; order-independent', () => {
  const base = makeSprite(20, 24, 7);
  const happy = makeSprite(26, 22, 8);
  const pose = makeSprite(18, 26, 9);
  const build = (order) => {
    const root = tmpRoot();
    const sA = archiveImg(root, renderStrip([base, base, base, base], { cellW: 24, cellH: 30, offsets: [[2, 4], [2, 3], [2, 4], [2, 4]] }), 'puff');
    const sB = archiveImg(root, renderStrip([happy, happy], { cellW: 30, cellH: 30, offsets: [[1, 5], [2, 5]] }), 'puff');
    const sC = archiveImg(root, renderStrip([pose], { cellW: 22, cellH: 30, offsets: [[2, 2]] }), 'puff');
    const frags = {
      A: { species: 'puff', stage: 2, variant: 'base', unit: unit(sA, { id: 'walk', anim: 'walk', strip: { n: 4 }, params: { roi: { x: 30, y: 0, w: 4 * 24 * F, h: 30 * F + 60 } } }) },
      B: { species: 'puff', stage: 2, variant: 'base', unit: unit(sB, { id: 'act', anim: 'action', strip: { n: 2 }, params: { roi: { x: 30, y: 0, w: 2 * 30 * F, h: 30 * F + 60 } } }) },
      C: { species: 'puff', stage: 2, variant: 'base', unit: unit(sC, { id: 'idle0', anim: 'idle' }) },
    };
    let r;
    for (const k of order) r = cmdAdd(root, writeFrag(root, frags[k]));
    return { root, r };
  };
  const one = build(['A', 'B', 'C']);
  const two = build(['C', 'B', 'A']);
  assert.deepEqual(one.r.U, two.r.U); assert.deepEqual(one.r.T, two.r.T);
  const names = one.r.files.map((f) => f.name).sort();
  assert.deepEqual(names, two.r.files.map((f) => f.name).sort());
  for (const n of names) assert.deepEqual(rawCanvas(one.root, 'puff', n), rawCanvas(two.root, 'puff', n), n);
  // bob: walk_01 is exactly 1 row higher than walk_00, otherwise identical
  const f0 = rawCanvas(one.root, 'puff', 'puff_s2_walk_00.png'), f1 = rawCanvas(one.root, 'puff', 'puff_s2_walk_01.png');
  for (let y = 0; y < 63; y++) for (let x = 0; x < 64; x++) assert.equal(f1[y * 64 + x], f0[(y + 1) * 64 + x]);
  // adding a unit never moves existing frames relative to each other (only ΔT)
  const root = tmpRoot();
  const sA = archiveImg(root, renderStrip([base, base, base, base], { cellW: 24, cellH: 30, offsets: [[2, 4], [2, 3], [2, 4], [2, 4]] }), 'puff');
  const r1 = cmdAdd(root, writeFrag(root, { species: 'puff', stage: 2, variant: 'base', unit: unit(sA, { id: 'walk', anim: 'walk', strip: { n: 4 }, params: { roi: { x: 30, y: 0, w: 4 * 24 * F, h: 30 * F + 60 } } }) }));
  const before = rawCanvas(root, 'puff', 'puff_s2_walk_00.png');
  const sB = archiveImg(root, renderStrip([makeSprite(36, 22, 10)], { cellW: 40, cellH: 30, offsets: [[2, 5]] }), 'puff');
  const r2 = cmdAdd(root, writeFrag(root, { species: 'puff', stage: 2, variant: 'base', unit: unit(sB, { id: 'wide', anim: 'action' }) }));
  const after = rawCanvas(root, 'puff', 'puff_s2_walk_00.png');
  const [dx, dy] = [r2.T[0] - r1.T[0], r2.T[1] - r1.T[1]];
  const b0 = bbox(before), b1 = bbox(after);
  assert.deepEqual([b1.l - b0.l, b1.t - b0.t], [dx, dy]);
});

test('FR-08: auto-outline still sits on baseline', () => {
  const root = tmpRoot();
  const s = makeSprite(20, 20, 11);
  const white = { ...s, I: s.I.map((v) => (v === 4 ? 4 : 3)) }; // no outline
  const a = archiveImg(root, renderStrip([white], { cellW: 20, cellH: 20 }), 'blob');
  const r = cmdAdd(root, writeFrag(root, { species: 'blob', stage: 1, variant: 'base', unit: unit(a, { params: { auto_outline: true } }) }));
  assert.ok(r.warnings.some((w) => /outline/i.test(w)));
  const I = rawCanvas(root, 'blob', 'blob_s1_idle_00.png');
  assert.equal(bbox(I).b, 61);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    if (I[y * 64 + x] === 4) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => I[(y + dy) * 64 + x + dx] === 4);
    if (edge) assert.equal(I[y * 64 + x], 0);
  }
});

test('FR-11 add: bad anim, .. path, wrong species, duplicates, replace needs --yes', () => {
  const root = tmpRoot();
  const a = archiveImg(root, renderStrip([makeSprite(20, 20, 12)], { cellW: 20, cellH: 20 }), 'blob');
  const fr = (u, sp = 'blob', st = 1) => writeFrag(root, { species: sp, stage: st, variant: 'base', unit: u });
  assert.throws(() => cmdAdd(root, fr(unit(a, { anim: 'idle_walk' }))), /anim/);
  assert.throws(() => cmdAdd(root, fr(unit({ ...a, path: 'art/source/blob/../../../etc/x.png' }))), /unsafe path/);
  assert.throws(() => cmdAdd(root, fr(unit(a), 'blob', 2)), /does not belong/);
  assert.throws(() => cmdAdd(root, writeFrag(root, { species: 'blob', stage: 1, variant: 'fat', unit: unit(a) })), /fat/);
  cmdAdd(root, fr(unit(a)));
  assert.throws(() => cmdAdd(root, fr(unit(a, { id: 'u2' }))), /duplicate output names/);
  assert.throws(() => cmdAdd(root, fr(unit(a))), (e) => e.code === 'CONFIRM');
  cmdAdd(root, fr(unit(a)), { yes: true });
  const batch = readJson(path.join(root, 'art/raw/blob/blob_s1.batch.json'));
  assert.equal(batch.units.length, 1);
  const sc = readJson(path.join(root, batch.units[0].frames[0].sidecar));
  assert.ok(sc.grid && sc.grid.x.period > 9 && sc.grid.x.period < 11);
});

test('§3.3 archive: header guard, animated reject, EXIF orientation baked + metadata stripped', () => {
  const root = tmpRoot();
  // 5000px header (no pixel data needed)
  const ih = encodePng({ w: 1, h: 1, colorType: 0, bitDepth: 8, data: new Uint8Array([0]) });
  const dv = new DataView(ih.buffer); dv.setUint32(16, 5000); dv.setUint32(20, 10);
  assert.throws(() => inspect(ih), /exceeds/);
  // APNG
  const apng = new Uint8Array(ih.length + 20); apng.set(ih.subarray(0, 33)); apng.set([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 33); apng.set(ih.subarray(33), 53);
  assert.throws(() => inspect(apng), /animated/);
  // JPEG 40x20 with EXIF orientation 6 + a GPS pointer
  const W = 40, H = 20, d = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) for (let x = 0; x < 10; x++) d.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
  const enc = jpeg.encode({ data: d, width: W, height: H }, 95).data;
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, tiff.length + 8]), Buffer.from('Exif\0\0'), tiff]);
  const withExif = Buffer.concat([enc.subarray(0, 2), app1, enc.subarray(2)]);
  const file = path.join(root, 'photo.jpg'); fs.writeFileSync(file, withExif);
  const a = cmdArchive(root, file, 'blob');
  assert.equal(a.w, 20); assert.equal(a.h, 40); // rotated
  const png = fs.readFileSync(path.join(root, a.path));
  const types = []; for (let o = 8; o < png.length;) { const len = png.readUInt32BE(o); types.push(png.toString('latin1', o + 4, o + 8)); o += 12 + len; }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.throws(() => cmdArchive(root, file, 'blob'), /already archived/);
});
