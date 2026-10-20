// CLI commands (M3): promote, retranslate, normalize, validate, export.
import fs from 'node:fs';
import path from 'node:path';
import { TRANSPARENT, pixelHash } from '../core/config.js';
import { encodeCanonical, TOOL_VERSION } from '../core/pipeline.js';
import { parseGroupId, parseName, groupId } from '../core/naming.js';
import { validateGroup, readCanonical } from '../core/validate.js';
import { frameData, toBin, toHeader, isGroupExportFile, FORMATS } from '../core/exportfmt.js';
import { loadConfig, readJson, sha256File, sha256Bytes, artPaths } from './store.js';
import { loadPlacement, savePlacement, writeAtomic, moveToTrash, newTrashDir, markerPath, retranslateMarkerPath, promoteMarkerPath, removeMarkerPath, assertNoMarker, rawContentHash, groupCleanFiles } from './cleanstore.js';
import { claimants, tombstoned } from '../core/placement.js';
import { normalizeToIndex } from '../core/normalize.js';
import { batchPath } from './commands.js';
import { newRemovedDir, writeManifest, step } from './remove.js';

function confirmErr(msg) { const e = new Error(msg); e.code = 'CONFIRM'; return e; }

function ctx(root, batchId) {
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  const bp = batchPath(root, batchId);
  if (!fs.existsSync(bp)) throw new Error(`no batch file for ${batchId} — run add first`);
  const batch = readJson(bp);
  const dirs = artPaths(root, g.species);
  const placementPath = path.join(dirs.clean, `${batchId}.placement.json`);
  return { g, batch, dirs, placementPath };
}

const rawNames = (batch) => batch.units.flatMap((u) => u.frames.map((f) => f.name));

// ---------------------------------------------------------------- promote (FR-15, schema 2)
function placementCtx(root, batchId, { allow = null } = {}) {
  const c = ctx(root, batchId);
  assertNoMarker(c.dirs.clean, batchId, allow);
  const { placement, migrated, exists } = loadPlacement(c.dirs.clean, c.dirs.raw, batchId);
  return { ...c, placement, migrated, exists };
}

/**
 * Write a promote plan with crash safety (FR-15 v3.4): marker → per file (.promote.tmp, copy old to trash,
 * move notes to trash, rename) → placement.json → remove marker.
 * plan item: { file, raw_name, sha_before (null = new file), sha_after, raw_hash, entry, notes }
 */
function executePromotePlan(root, dirs, batchId, placement, plan, report) {
  if (!plan.length) return;
  const mp = promoteMarkerPath(dirs.clean, batchId);
  const needsTrash = plan.some((it) => it.sha_before);
  const trash = needsTrash ? newTrashDir(dirs.clean) : null;
  writeAtomic(mp, JSON.stringify({ batch_id: batchId, trash: trash && path.relative(dirs.clean, trash).split(path.sep).join('/'), files: plan }, null, 2) + '\n');
  applyPromotePlan(dirs, batchId, placement, { trash: trash && path.relative(dirs.clean, trash), files: plan });
  if (hooks.promoteBeforePlacement) hooks.promoteBeforePlacement();
  savePlacement(dirs.clean, batchId, placement);
  fs.rmSync(mp);
  if (trash) report.trash = path.relative(root, trash).split(path.sep).join('/');
}

/** Apply (or resume) a marker's plan to the clean folder; updates `placement` in memory. Refuses unknown states. */
function applyPromotePlan(dirs, batchId, placement, m) {
  const trash = m.trash ? path.join(dirs.clean, m.trash) : null;
  for (const it of m.files) {
    const p = path.join(dirs.clean, it.file), rp = path.join(dirs.raw, it.raw_name);
    if (!fs.existsSync(rp) || rawContentHash(dirs.raw, it.raw_name) !== it.raw_hash) throw new Error(`${it.raw_name} changed since the interrupted promote — restore ${it.file} by hand, then delete ${path.basename(promoteMarkerPath(dirs.clean, batchId))}`);
    const cur = fs.existsSync(p) ? sha256File(p) : null;
    if (cur === it.sha_before) {
      const bytes = fs.readFileSync(rp);
      if (sha256Bytes(bytes) !== it.sha_after) throw new Error(`${it.raw_name} bytes differ from the planned ones — restore ${it.file} by hand, then delete the promote marker`);
      if (cur && trash) { fs.mkdirSync(trash, { recursive: true }); if (!fs.existsSync(path.join(trash, it.file))) fs.copyFileSync(p, path.join(trash, it.file)); }
      const tmp = `${p}.promote.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, p);
    } else if (cur !== it.sha_after) {
      throw new Error(`${it.file} changed since the interrupted promote — restore it by hand, then delete ${path.basename(promoteMarkerPath(dirs.clean, batchId))}`);
    }
    const np = p.replace(/\.png$/, '.notes.json');
    if (it.sha_before && trash && fs.existsSync(np)) { fs.mkdirSync(trash, { recursive: true }); fs.renameSync(np, path.join(trash, path.basename(np))); }
    placement.files[it.file] = it.entry;
  }
}

/** Test-only crash simulation points. */
export const hooks = { promoteBeforePlacement: null };

/**
 * promote <group> [--anim A]                     copy unclaimed, non-tombstoned raw frames whose filename is free
 * promote <group> --force <raw> [--to <clean>]   replace the claimant (or --to / same-named file); confirm names it
 * promote <group> --adopt <clean file>           register a clean file that has no entry (pixels untouched)
 * promote <group> --accept-raw <clean file>      refresh raw_content_sha256 after a "raw changed" check
 */
export function cmdPromote(root, batchId, { anim = null, force = null, to = null, adopt = null, acceptRaw = null, yes = false } = {}) {
  const plain = force == null && adopt == null && acceptRaw == null;
  const c = placementCtx(root, batchId, { allow: plain ? 'promote' : null });
  const { batch, dirs } = c;
  let { placement } = c;
  const raws = rawNames(batch);
  // NFR-06 / FR-15: every file argument must be a plain frame filename of this group (no paths).
  const ownName = (x, flag) => {
    const p = typeof x === 'string' ? parseName(x) : null;
    if (!p || groupId(p.species, p.stage, p.variant) !== batchId) throw new Error(`${flag} ${x}: must be a frame filename of ${batchId} (e.g. ${batchId}_idle_00.png)`);
    return x;
  };
  if (to != null) ownName(to, '--to');
  if (adopt != null) ownName(adopt, '--adopt');
  if (acceptRaw != null) ownName(acceptRaw, '--accept-raw');
  if (force != null) ownName(force, '--force');
  const report = { copied: [], skipped: [], name_taken: [], forced: [], adopted: [], accepted: [], refreshed: [], backfilled: [], resumed: false, trash: null };
  fs.mkdirSync(dirs.clean, { recursive: true });
  const rawEntry = (rn, written) => ({ T: batch.T, origin: 'raw', raw_name: rn, raw_content_sha256: rawContentHash(dirs.raw, rn), written_sha256: written });

  // Resume an interrupted promote first (any plain form, with or without --anim), then continue normally.
  const mp = promoteMarkerPath(dirs.clean, batchId);
  if (plain && fs.existsSync(mp)) {
    const m = readJson(mp);
    applyPromotePlan(dirs, batchId, placement, m);
    savePlacement(dirs.clean, batchId, placement);
    fs.rmSync(mp);
    for (const f of fs.readdirSync(dirs.clean)) if (f.startsWith(batchId + '_') && f.endsWith('.promote.tmp')) fs.rmSync(path.join(dirs.clean, f));
    report.resumed = true;
    placement = loadPlacement(dirs.clean, dirs.raw, batchId).placement;
  }
  const claim = claimants(placement), tomb = tombstoned(placement);

  if (adopt) {
    if (!fs.existsSync(path.join(dirs.clean, adopt))) throw new Error(`--adopt ${adopt}: no such clean file`);
    if (placement.files[adopt]) throw new Error(`--adopt ${adopt}: already has a placement entry`);
    const isRaw = raws.includes(adopt) && !claim.has(adopt);
    placement.files[adopt] = isRaw ? { T: batch.T, origin: 'raw', raw_name: adopt, raw_content_sha256: null, written_sha256: null } : { T: batch.T, origin: 'editor', raw_name: null, raw_content_sha256: null, written_sha256: null };
    report.adopted.push(adopt);
  } else if (acceptRaw) {
    const e = placement.files[acceptRaw];
    if (!e || e.origin !== 'raw') throw new Error(`--accept-raw ${acceptRaw}: not a raw-origin clean frame`);
    e.raw_content_sha256 = rawContentHash(dirs.raw, e.raw_name);
    report.accepted.push(acceptRaw);
  } else if (force) {
    if (!raws.includes(force)) throw new Error(`--force ${force}: not a raw frame of ${batchId}`);
    if (!fs.existsSync(path.join(dirs.raw, force))) throw new Error(`raw frame missing: ${force} — run rebuild`);
    if (claim.has(force) && to && to !== claim.get(force)) throw new Error(`--force ${force}: it is already claimed by ${claim.get(force)}, which is the file that would be replaced; drop --to or use --to ${claim.get(force)}`);
    const target = claim.get(force) || to || force;
    const te = placement.files[target];
    if (!claim.has(force) && !to && te && (te.origin === 'editor' || (te.raw_name && te.raw_name !== force))) {
      throw new Error(`--force ${force}: ${target} is ${te.origin === 'editor' ? 'an editor-made frame' : `claimed by raw frame ${te.raw_name}`}; name it explicitly with --to ${target} to replace it`);
    }
    const exists = fs.existsSync(path.join(dirs.clean, target));
    if (!yes) throw confirmErr(`promote --force ${force} will ${exists ? `replace the clean file ${target} (moved to .trash/ first)` : `write ${target}`}. Re-run with --yes to confirm.`);
    const trash = exists ? moveToTrash(dirs.clean, [target]) : null;
    fs.copyFileSync(path.join(dirs.raw, force), path.join(dirs.clean, target));
    // the old claimant entry (if any) moves to target; another entry for target is replaced
    placement.files[target] = rawEntry(force, sha256File(path.join(dirs.clean, target)));
    placement.tombstones = (placement.tombstones || []).filter((t) => t.raw_name !== force);
    report.forced.push({ raw: force, clean: target, trash: trash && path.relative(root, trash) });
  } else {
    const plan = [];
    for (const rn of raws.filter((n) => !anim || parseName(n).anim === anim)) {
      const rp = path.join(dirs.raw, rn);
      if (!fs.existsSync(rp)) throw new Error(`raw frame missing: ${rn} — run rebuild`);
      const rawSha = sha256File(rp), rawHash = rawContentHash(dirs.raw, rn);
      if (claim.has(rn)) {
        const cf = claim.get(rn), e = placement.files[cf], cp = path.join(dirs.clean, cf);
        if (!fs.existsSync(cp)) { report.skipped.push(rn); continue; } // the Validator reports the missing file
        const fileSha = sha256File(cp);
        if (e.written_sha256 == null && fileSha === rawSha) { // backfill (no pixels change)
          e.written_sha256 = fileSha;
          e.raw_content_sha256 = rawHash; // byte-identical to raw ⇒ content-identical
          report.backfilled.push(cf); report.skipped.push(rn); continue;
        }
        if (e.written_sha256 && fileSha === e.written_sha256 && rawHash && rawHash !== e.raw_content_sha256) { // untouched follower, raw replaced
          plan.push({ file: cf, raw_name: rn, sha_before: fileSha, sha_after: rawSha, raw_hash: rawHash, entry: { T: batch.T, origin: 'raw', raw_name: rn, raw_content_sha256: rawHash, written_sha256: rawSha } });
          report.refreshed.push(cf); continue;
        }
        report.skipped.push(rn); continue;
      }
      if (tomb.has(rn)) { report.skipped.push(rn); continue; }
      if (fs.existsSync(path.join(dirs.clean, rn))) { report.name_taken.push(rn); continue; } // never write an existing clean filename
      plan.push({ file: rn, raw_name: rn, sha_before: null, sha_after: rawSha, raw_hash: rawHash, entry: { T: batch.T, origin: 'raw', raw_name: rn, raw_content_sha256: rawHash, written_sha256: rawSha } });
      report.copied.push(rn);
    }
    executePromotePlan(root, dirs, batchId, placement, plan, report);
  }
  savePlacement(dirs.clean, batchId, placement); // always last
  return report;
}

// ---------------------------------------------------------------- retranslate (FR-15)
export function cmdRetranslate(root, batchId, { yes = false } = {}) {
  const cfg = loadConfig(root);
  const { batch, dirs, placement, exists } = placementCtx(root, batchId, { allow: 'retranslate' });
  if (!exists) throw new Error('no placement.json — run promote first');
  const mPath = retranslateMarkerPath(dirs.clean, batchId);
  const report = { shifted: [], unchanged: [], skipped_no_entry: [], refused: [], resumed: false };
  const W = cfg.canvas.w, H = cfg.canvas.h;
  const shift = (I, d) => {
    const out = new Uint8Array(W * H).fill(TRANSPARENT), outside = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = I[y * W + x];
      if (v === TRANSPARENT) continue;
      const X = x + d[0], Y = y + d[1];
      if (X < 0 || Y < 0 || X >= W || Y >= H) outside.push(`(${x},${y})`); else out[Y * W + X] = v;
    }
    return { out, outside };
  };
  const readIdx = (f) => {
    const { I, problems } = readCanonical(new Uint8Array(fs.readFileSync(path.join(dirs.clean, f))), cfg);
    if (problems.length || !I) throw new Error(`${f}: ${problems.join('; ')} — run normalize first`);
    return I;
  };

  // Resume an interrupted retranslate: each file is either still at sha_before (shift it) or already at sha_after.
  if (fs.existsSync(mPath)) {
    const m = readJson(mPath);
    for (const it of m.files) {
      const cur = sha256File(path.join(dirs.clean, it.file));
      if (cur === it.sha_before) {
        writeAtomic(path.join(dirs.clean, it.file), encodeCanonical({ w: W, h: H, I: shift(readIdx(it.file), it.d).out }, cfg));
        report.shifted.push(`${it.file} by ${JSON.stringify(it.d)} (resumed)`);
      } else if (cur !== it.sha_after) {
        throw new Error(`${it.file} changed since the interrupted retranslate — restore it by hand, then delete ${path.basename(mPath)}`);
      }
      placement.files[it.file].T = it.to;
      if (it.written) placement.files[it.file].written_sha256 = it.sha_after;
    }
    savePlacement(dirs.clean, batchId, placement);
    fs.rmSync(mPath);
    report.resumed = true;
    return report;
  }

  const plan = [];
  for (const f of groupCleanFiles(dirs.clean, batchId)) {
    const e = placement.files[f];
    if (!e) { report.skipped_no_entry.push(f); continue; }
    const d = [batch.T[0] - e.T[0], batch.T[1] - e.T[1]];
    if (!d[0] && !d[1]) { report.unchanged.push(f); continue; }
    const { out, outside } = shift(readIdx(f), d);
    if (outside.length) { report.refused.push(`${f}: shift ${JSON.stringify(d)} would push pixels off-canvas at ${outside.slice(0, 5).join(' ')}${outside.length > 5 ? '…' : ''} — trim in the editor and re-run`); continue; }
    const bytes = encodeCanonical({ w: W, h: H, I: out }, cfg);
    const shaBefore = sha256File(path.join(dirs.clean, f));
    plan.push({ f, d, bytes, sha_before: shaBefore, sha_after: sha256Bytes(bytes), written: !!e.written_sha256 && e.written_sha256 === shaBefore });
  }
  if (report.refused.length) return report;
  if (plan.length && !yes) throw confirmErr(`retranslate will shift ${plan.length} clean file(s): ${plan.map((p) => `${p.f} by ${JSON.stringify(p.d)}`).join(', ')}. Re-run with --yes.`);
  if (!plan.length) return report;
  // Marker first (crash safety): lists every file with its before/after SHA, so a re-run finishes the job exactly.
  writeAtomic(mPath, JSON.stringify({ batch_id: batchId, to: batch.T, files: plan.map((p) => ({ file: p.f, d: p.d, to: batch.T, sha_before: p.sha_before, sha_after: p.sha_after, written: p.written })) }, null, 2) + '\n');
  for (const p of plan) {
    writeAtomic(path.join(dirs.clean, p.f), p.bytes);
    placement.files[p.f].T = batch.T;
    if (p.written) placement.files[p.f].written_sha256 = p.sha_after;
    report.shifted.push(`${p.f} by ${JSON.stringify(p.d)}`);
  }
  savePlacement(dirs.clean, batchId, placement);
  fs.rmSync(mPath);
  return report;
}

// ---------------------------------------------------------------- normalize (FR-15)
export function normalizeBytes(bytes, cfg) {
  return encodeCanonical(normalizeToIndex(bytes, cfg), cfg);
}

export function cmdNormalize(files, { yes = false, root = null } = {}) {
  const cfg = loadConfig(root);
  const out = [];
  for (const f of files) {
    const pn = parseName(path.basename(f));
    if (pn) assertNoMarker(path.dirname(path.resolve(f)), groupId(pn.species, pn.stage, pn.variant));
    const before = fs.readFileSync(f);
    const after = normalizeBytes(new Uint8Array(before), cfg); // throws (refuses) on any mismatch
    out.push({ f, after, changed: sha256Bytes(before) !== sha256Bytes(after) });
  }
  const changed = out.filter((o) => o.changed);
  if (changed.length && !yes) throw confirmErr(`normalize will rewrite: ${changed.map((o) => o.f).join(', ')}. Re-run with --yes.`);
  for (const o of changed) fs.writeFileSync(o.f, o.after);
  return { rewritten: changed.map((o) => o.f), already_canonical: out.filter((o) => !o.changed).map((o) => o.f) };
}

// ---------------------------------------------------------------- validate (FR-14)
export function cmdValidate(root, batchId, { raw = false } = {}) {
  const cfg = loadConfig(root);
  const { batch, dirs } = ctx(root, batchId);
  const dir = raw ? dirs.raw : dirs.clean;
  const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.toLowerCase().endsWith('.png') && f.startsWith(batchId + '_'))
    .map((name) => ({ name, bytes: new Uint8Array(fs.readFileSync(path.join(dir, name))) }));
  const rawContent = new Map(rawNames(batch).filter((n) => fs.existsSync(path.join(dirs.raw, n))).map((n) => [n, rawContentHash(dirs.raw, n)]));
  const notes = new Map();
  for (const f of files) {
    const np = path.join(dir, f.name.replace(/\.png$/, '.notes.json'));
    if (fs.existsSync(np)) notes.set(f.name, readJson(np));
  }
  let placement = null, marker = false, retranslateMarker = false, promoteMarker = false, removeMarker = false;
  if (!raw) {
    const lp = loadPlacement(dirs.clean, dirs.raw, batchId);
    placement = lp.exists ? lp.placement : null;
    const mp = markerPath(dirs.clean, batchId);
    if (fs.existsSync(mp)) { try { marker = readJson(mp); } catch { marker = { trash: null }; } }
    retranslateMarker = fs.existsSync(retranslateMarkerPath(dirs.clean, batchId));
    promoteMarker = fs.existsSync(promoteMarkerPath(dirs.clean, batchId));
    const rp = removeMarkerPath(dirs.clean, batchId);
    if (fs.existsSync(rp)) { try { removeMarker = readJson(rp).cmd || 'removal'; } catch { removeMarker = 'removal'; } }
  }
  const res = validateGroup({ mode: raw ? 'raw' : 'clean', batchId, files, batch, placement, rawContent, marker, retranslateMarker, promoteMarker, removeMarker, notes, cfg });
  return { batch_id: batchId, mode: raw ? 'raw' : 'clean', files: files.length, ...res, ok: res.fails.length === 0 };
}

// ---------------------------------------------------------------- export (§6)
export function cmdExport(root, batchId, { formats = 'h,bin,png' } = {}) {
  const cfg = loadConfig(root);
  const fmts = new Set(String(formats).split(',').map((f) => f.trim()).filter(Boolean));
  const bad = [...fmts].filter((f) => !FORMATS.includes(f));
  if (bad.length || !fmts.size) throw new Error(`unknown export format(s): ${bad.join(', ') || '(none)'} — use a comma list of ${FORMATS.join(', ')}`);
  const v = cmdValidate(root, batchId, {});
  if (!v.ok) throw new Error(`validator FAIL — fix before export:\n  ${v.fails.join('\n  ')}`);
  const { batch, dirs } = ctx(root, batchId);
  const anc = batch.dither_anchor || cfg.dither.anchor_default;
  if (!['canvas', 'sprite'].includes(anc)) throw new Error('anchor must be canvas or sprite');
  const names = fs.readdirSync(dirs.clean).filter((f) => { const p = parseName(f); return p && groupId(p.species, p.stage, p.variant) === batchId; });
  const frames = names.map((name) => {
    const p = parseName(name);
    const { I } = readCanonical(new Uint8Array(fs.readFileSync(path.join(dirs.clean, name))), cfg);
    const c = { w: cfg.canvas.w, h: cfg.canvas.h, I };
    return { name, anim: p.anim, frame: p.frame, c, fd: frameData(c) };
  }).sort((a, b) => (a.anim < b.anim ? -1 : a.anim > b.anim ? 1 : a.frame - b.frame));
  if (!frames.length) throw new Error(`${batchId} has no clean frames — nothing to export`);
  // what this run writes (all bytes built before anything moves)
  const plan = new Map();
  for (const f of frames) {
    const base = f.name.replace(/\.png$/, '');
    if (fmts.has('bin')) plan.set(`${base}.bin`, toBin(f.fd));
    if (fmts.has('png')) plan.set(`${base}.png`, encodeCanonical(f.c, cfg));
  }
  if (fmts.has('h')) {
    const tilesId = sha256Bytes(Buffer.from(JSON.stringify(cfg.dither.tiles))).slice(0, 8);
    plan.set(`${batchId}.h`, toHeader(batchId, frames, { toolVersion: TOOL_VERSION, anchor: anc, tiles: cfg.dither.tiles, tilesId, pixelHash: pixelHash(cfg) }));
  }
  fs.mkdirSync(dirs.export, { recursive: true });
  // §6 stale files: files of the group this run will not write → art/_removed (FR-19 step rule: SHA-tagged, never overwrites)
  const stale = fs.readdirSync(dirs.export).filter((f) => isGroupExportFile(f, batchId) && !plan.has(f)).sort();
  let removedDir = null;
  if (stale.length) {
    removedDir = newRemovedDir(root, 'export', batchId);
    const sp = path.relative(root, dirs.export).split(path.sep).join('/');
    const moves = stale.map((f) => ({ from: `${sp}/${f}`, to: `${removedDir}/${sp.replace(/^art\//, '')}/${f}`, sha: sha256File(path.join(dirs.export, f)) }));
    const man = { command: `export ${batchId}`, at: new Date().toISOString(), reason: 'files of the group this export does not write (§6)', planned: moves, restore: 'Derived files: export again instead of restoring; to restore anyway, move the files back to the from paths.' };
    writeManifest(root, removedDir, man);
    for (const m of moves) step(root, m);
    writeManifest(root, removedDir, { ...man, moved: moves }); // rewritten after the moves: `moved` only once they happened
  }
  const written = [];
  for (const [n, bytes] of plan) { writeAtomic(path.join(dirs.export, n), bytes); written.push(n); }
  return { batch_id: batchId, anchor: anc, warnings: v.warns, written, moved_stale: stale, removed_dir: removedDir };
}

export async function run(cmd, root, args, opt, print) {
  switch (cmd) {
    case 'promote': print(cmdPromote(root, args[0], { anim: opt.anim || null, force: typeof opt.force === 'string' ? opt.force : null, to: opt.to || null, adopt: opt.adopt || null, acceptRaw: opt['accept-raw'] || null, yes: !!opt.yes })); return 0;
    case 'retranslate': { const r = cmdRetranslate(root, args[0], { yes: !!opt.yes }); print(r); return r.refused.length ? 1 : 0; }
    case 'normalize': print(cmdNormalize(args, { yes: !!opt.yes, root })); return 0;
    case 'validate': { const r = cmdValidate(root, args[0], { raw: !!opt.raw }); print(r); return r.ok ? 0 : 1; }
    case 'export': if (opt.anchor) throw new Error('--anchor was removed in v3.8: the export uses the group\'s dither_anchor from its batch file'); print(cmdExport(root, args[0], { formats: opt.formats || 'h,bin,png' })); return 0;
  }
  return 2;
}
