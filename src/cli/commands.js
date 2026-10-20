// CLI commands: archive, add, rebuild (M2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, decodeImage } from '../core/image.js';
import { encodePng, decodePng } from '../core/png.js';
import { pixelHash } from '../core/config.js';
import { processUnit, placeUnits, encodeCanonical, makeSidecar, PARAM_KEYS, TOOL_VERSION } from '../core/pipeline.js';
import { groupId, parseGroupId, parseName, checkMembership, frameName } from '../core/naming.js';
import { checkUse } from '../core/frame.js';
import { loadConfig, readJson, writeJson, sha256File, sha256Bytes, artPaths, safeJoin } from './store.js';
import { assertNoMarker, loadPlacement } from './cleanstore.js';

const UNIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// ---------------------------------------------------------------- archive (§3.3)
export function cmdArchive(root, file, species) {
  return cmdArchiveBytes(root, new Uint8Array(fs.readFileSync(file)), species);
}

/** §3.3 on in-memory bytes (used by the CLI wrapper above and by serve). */
export function cmdArchiveBytes(root, bytes, species, { allowExisting = false } = {}) {
  const cfg = loadConfig(root);
  const known = Object.values(cfg.stages).some((s) => s.species.includes(species));
  if (!known) throw new Error(`unknown species_id "${species}"`);
  inspect(bytes, cfg.processing.max_source_px); // header checks before decoding
  const img = decodeImage(bytes, cfg.processing.max_source_px); // EXIF orientation applied
  const png = encodePng({ w: img.w, h: img.h, colorType: 6, bitDepth: 8, data: img.rgba }); // metadata-free
  const sha = sha256Bytes(png);
  const dir = artPaths(root, species).source;
  const out = path.join(dir, sha.slice(0, 16) + '.png');
  if (fs.existsSync(out)) {
    if (allowExisting) return { path: path.relative(root, out).split(path.sep).join('/'), sha256: sha, w: img.w, h: img.h, existing: true };
    throw new Error(`already archived: ${path.relative(root, out)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, png);
  return { path: path.relative(root, out).split(path.sep).join('/'), sha256: sha, w: img.w, h: img.h };
}

// ---------------------------------------------------------------- batch helpers
export function batchPath(root, batchId) {
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  return path.join(artPaths(root, g.species).raw, `${batchId}.batch.json`);
}

function loadBatch(root, batchId) {
  const p = batchPath(root, batchId);
  if (fs.existsSync(p)) return readJson(p);
  const g = parseGroupId(batchId);
  return { batch_id: batchId, species: g.species, stage: g.stage, variant: g.variant, dither_anchor: 'canvas', units: [], U: null, T: null, exceeds_box: false };
}

/** Frame names of a unit: positional over its used segments (FR-23). */
function unitNames(batch, unit) {
  const count = unit.strip.use ? unit.strip.use.length : unit.strip.n;
  return Array.from({ length: count }, (_, i) => frameName(batch.species, batch.stage, batch.variant, unit.anim, (unit.frame_start || 0) + i));
}

// ---------------------------------------------------------------- add (FR-11)
/**
 * fragment: { batch_id, species, stage, variant, dither_anchor?, unit: { id, source, source_sha256, dx, dy,
 *             strip:{n,dividers}, anim, frame_start, params:{…PARAM_KEYS} } }
 * Atomic: the merged group is computed in memory first; nothing is written unless it places successfully.
 */
export function cmdAdd(root, fragmentFile, opts = {}) {
  return cmdAddFragment(root, readJson(fragmentFile), opts);
}

/** FR-11 add on an in-memory fragment object (used by the CLI wrapper above and by serve). */
export function cmdAddFragment(root, frag, { yes = false } = {}) {
  const cfg = loadConfig(root);
  const species = frag.species, variant = frag.variant || 'base';
  const stage = Number(frag.stage);
  if (!Number.isInteger(stage)) throw new Error(`stage must be an integer, got ${JSON.stringify(frag.stage)}`);
  const batchId = groupId(species, stage, variant);
  if (frag.batch_id && frag.batch_id !== batchId) throw new Error(`fragment batch_id ${frag.batch_id} ≠ ${batchId}`);
  const err = checkMembership(cfg, species, stage, variant);
  if (err) throw new Error(err);
  if (frag.dither_anchor != null && !['canvas', 'sprite'].includes(frag.dither_anchor)) throw new Error('dither_anchor must be "canvas" or "sprite"');
  const u = frag.unit;
  if (!u || !UNIT_ID_RE.test(u.id || '')) throw new Error('unit.id must match [a-z0-9][a-z0-9-]*');
  if (!/^[a-z0-9]+$/.test(u.anim || '')) throw new Error('unit.anim must match [a-z0-9]+');
  const int = (v, name, lo, hi) => {
    const x = v == null ? 0 : v;
    if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`unit.${name} must be an integer in ${lo}..${hi}, got ${JSON.stringify(v)}`);
    return x;
  };
  const dx = int(u.dx, 'dx', -64, 64), dy = int(u.dy, 'dy', -64, 64), frameStart = int(u.frame_start, 'frame_start', 0, 99);
  const n = int(u.strip && u.strip.n != null ? u.strip.n : 1, 'strip.n', 1, 16);
  // FR-01: source must be an archived PNG with matching SHA.
  const srcAbs = safeJoin(root, u.source, `art/source/${species}`);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${u.source} (run archive first)`);
  const sha = sha256File(srcAbs);
  if (sha !== u.source_sha256) throw new Error(`source SHA mismatch for ${u.source}`);
  const strip = { n, dividers: (u.strip && u.strip.dividers) || null };
  if (u.strip && u.strip.use != null) {
    const use = checkUse(u.strip.use, n);
    if (use.length < n) strip.use = use; // absent = all segments
  }
  if (u.source_name != null && (typeof u.source_name !== 'string' || u.source_name.length > 200 || /[\u0000-\u001f]/.test(u.source_name))) throw new Error('unit.source_name must be a short file name');

  const dirsG = artPaths(root, species);
  assertNoMarker(dirsG.clean, batchId); // FR-15 v3.4: never replace raw under a pending clean command
  const batch = loadBatch(root, batchId);
  const unitDef = { id: u.id, source: u.source, source_sha256: sha, ...(u.source_name ? { source_name: u.source_name } : {}), dx, dy, strip, anim: u.anim, frame_start: frameStart };
  const names = unitNames(batch, unitDef);
  const others = batch.units.filter((x) => x.id !== u.id);
  const owner = new Map(others.flatMap((x) => x.frames.map((f) => [f.name, x])));
  const dup = names.filter((nm) => owner.has(nm));
  if (dup.length) {
    const units = [...new Set(dup.map((nm) => owner.get(nm)))];
    const hints = units.map((x) => `unit "${x.id}" already makes ${x.frames.filter((f) => dup.includes(f.name)).map((f) => f.name).join(', ')} — set Unit id to "${x.id}" to replace it, or set First frame to ${Math.max(...others.filter((o) => o.anim === u.anim).map((o) => (o.frame_start || 0) + o.frames.length))} to append after it`);
    throw new Error(`duplicate output names (fragment rejected): ${hints.join('; ')}`);
  }
  const existing = batch.units.find((x) => x.id === u.id);
  // FR-22 replace rule: a replace may never drop a raw frame name (shrinking = Remove + Add, FR-19)
  if (existing) {
    const dropped = existing.frames.map((f) => f.name).filter((nm) => !names.includes(nm));
    if (dropped.length) throw new Error(`replacing unit "${u.id}" would no longer produce ${dropped.join(', ')}. To make a unit smaller or move it to another animation / first frame, remove the unit (Remove) and add it again.`);
  }
  if (existing && !yes) {
    // name the clean frames that promote would then auto-refresh (untouched followers of this unit's raw frames)
    let follow = [];
    try {
      const { placement } = loadPlacement(dirsG.clean, dirsG.raw, batchId);
      const own = new Set(existing.frames.map((f) => f.name));
      follow = Object.entries(placement.files).filter(([n, e]) => e.origin === 'raw' && own.has(e.raw_name) && e.written_sha256 && fs.existsSync(path.join(dirsG.clean, n)) && sha256File(path.join(dirsG.clean, n)) === e.written_sha256).map(([n]) => n);
    } catch { /* no clean folder yet */ }
    const e = new Error(`unit "${u.id}" exists; replacing affects: ${existing.frames.map((f) => f.name).join(', ')}.${follow.length ? ` Clean frames that were never edited will then be updated to the new raw (old versions kept in .trash/): ${follow.join(', ')}.` : ''} Re-run with --yes to confirm.`);
    e.code = 'CONFIRM';
    throw e;
  }
  const params = Object.fromEntries(PARAM_KEYS.map((k) => [k, u.params ? u.params[k] ?? null : null]));
  // Resolve anything auto-detected (key / grid / thresholds / dividers) once, so rebuild never re-detects.
  const img = decodeImage(new Uint8Array(fs.readFileSync(srcAbs)), cfg.processing.max_source_px);
  const res = processUnit(img, params, strip, cfg);
  params.key = res.resolved.key;
  if (!params.fallback_target_h) params.grid = res.resolved.grid;
  params.thresholds = res.resolved.thresholds;
  strip.dividers = res.resolved.dividers;
  const usedSegs = strip.use || Array.from({ length: n }, (_, s) => s);
  unitDef.frames = names.map((name, i) => ({ name, segment: usedSegs[i], sidecar: `art/raw/${species}/${name.replace(/\.png$/, '.json')}` }));
  const newSidecars = new Map(unitDef.frames.map((f, i) => [f.sidecar, makeSidecar({ batchId, unit: unitDef, params, segment: f.segment, index: i, name: f.name, species, stage, variant, exceedsBox: false, cfg })]));
  const newBatch = { ...batch, units: existing ? batch.units.map((x) => (x.id === u.id ? unitDef : x)) : [...batch.units, unitDef] };
  if (frag.dither_anchor) newBatch.dither_anchor = frag.dither_anchor;

  // Dry run on the merged group — throws before anything touches disk.
  computeGroup(root, newBatch, newSidecars, cfg);

  for (const [rel, sc] of newSidecars) writeJson(path.join(root, rel), sc);
  writeJson(batchPath(root, batchId), newBatch);
  fs.mkdirSync(artPaths(root, species).raw, { recursive: true });
  return cmdRebuild(root, batchId, {});
}

/** Process every unit of a batch and place the group. sidecarOverrides: Map(relPath → sidecar object). */
export function computeGroup(root, batch, sidecarOverrides, cfg) {
  const { species, stage, variant } = batch;
  const units = [];
  const sidecars = new Map();
  for (const u of batch.units) {
    const sc = u.frames.map((f) => {
      const s = sidecarOverrides.has(f.sidecar) ? sidecarOverrides.get(f.sidecar) : readJson(safeJoin(root, f.sidecar, `art/raw/${species}`));
      sidecars.set(f.name, { path: f.sidecar, data: s });
      return s;
    });
    const params = Object.fromEntries(PARAM_KEYS.map((k) => [k, sc[0][k]]));
    for (const s of sc) for (const k of PARAM_KEYS) if (JSON.stringify(s[k]) !== JSON.stringify(params[k])) throw new Error(`sidecars of unit ${u.id} disagree on "${k}"`);
    const srcAbs = safeJoin(root, u.source, `art/source/${species}`);
    if (sha256File(srcAbs) !== u.source_sha256) throw new Error(`source changed: ${u.source}`);
    const img = decodeImage(new Uint8Array(fs.readFileSync(srcAbs)), cfg.processing.max_source_px);
    if (!params.grid && !params.fallback_target_h) throw new Error(`unit ${u.id}: sidecar has no grid — rebuild never re-detects`);
    const res = processUnit(img, params, u.strip, cfg);
    const segs = u.frames.map((f, i) => f.segment ?? i); // a batch frame without `segment` is positional (defensive default)
    if (segs.some((sg) => !Number.isInteger(sg) || sg < 0 || sg >= res.frames.length)) throw new Error(`unit ${u.id}: the batch lists a segment the strip does not have`);
    if (JSON.stringify(segs) !== JSON.stringify(checkUse(u.strip.use, res.frames.length))) throw new Error(`unit ${u.id}: the batch frames (segments ${segs.join(', ')}) disagree with strip.use`);
    units.push({ def: { ...u, use: segs }, frames: res.frames, warnings: res.warnings });
  }
  const placed = placeUnits(units, { species, stage, variant }, cfg);
  if (placed.blocked) throw new Error(placed.blocked);
  return { placed, units, sidecars };
}

// ---------------------------------------------------------------- rebuild (FR-11/12)
/** --check never writes into art/raw: without --out it renders into a temporary directory. */
export function cmdRebuild(root, batchId, { out = null, check = false } = {}) {
  const cfg = loadConfig(root);
  const bp = batchPath(root, batchId);
  if (!fs.existsSync(bp)) throw new Error(`no batch file ${path.relative(root, bp)}`);
  const batch = readJson(bp);
  const rawDir = artPaths(root, batch.species).raw;
  const curHash = pixelHash(cfg);
  const { placed, units, sidecars } = computeGroup(root, batch, new Map(), cfg);
  const report = { batch_id: batchId, U: placed.U, T: placed.T, exceeds_box: placed.exceedsBox, files: [], mismatches: [], warnings: units.flatMap((u) => u.warnings.map((w) => `${u.def.id}: ${w}`)) };
  let tmp = null;
  if (check && !out) tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-check-'));
  const target = tmp || (out ? path.resolve(out) : rawDir);
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const o of placed.outputs) {
      const png = encodeCanonical(o.canvas, cfg);
      const sha = sha256Bytes(png);
      if (check) {
        const committed = path.join(rawDir, o.name);
        if (!fs.existsSync(committed) || sha256File(committed) !== sha) report.mismatches.push(`${o.name}: PNG differs from committed raw`);
      }
      fs.writeFileSync(path.join(target, o.name), png);
      report.files.push({ name: o.name, sha256: sha });
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (check) {
    if (JSON.stringify(batch.U) !== JSON.stringify(placed.U) || JSON.stringify(batch.T) !== JSON.stringify(placed.T)) report.mismatches.push('stored U/T differ from recomputed');
    const stale = [...sidecars.values()].some((s) => s.data.pixel_hash !== curHash);
    if (stale && report.mismatches.length) report.mismatches.unshift('raw stale — run rebuild, review, commit (pixel_hash changed)');
    return report;
  }
  if (!out) {
    // delete raw PNGs of this group that are no longer listed
    const keep = new Set(placed.outputs.map((o) => o.name));
    for (const f of fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []) {
      const p = parseName(f);
      if (p && groupId(p.species, p.stage, p.variant) === batchId && !keep.has(f)) { fs.rmSync(path.join(rawDir, f)); report.deleted = [...(report.deleted || []), f]; }
    }
    batch.U = placed.U; batch.T = placed.T; batch.exceeds_box = placed.exceedsBox;
    batch.pixel_hash = curHash; batch.tool_version = TOOL_VERSION;
    writeJson(bp, batch);
    for (const [, s] of sidecars) {
      s.data.flags = { ...s.data.flags, exceeds_box: placed.exceedsBox };
      s.data.pixel_hash = curHash; s.data.tool_version = TOOL_VERSION;
      writeJson(path.join(root, s.path), s.data);
    }
  }
  return report;
}

export { decodePng };
