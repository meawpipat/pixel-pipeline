// FR-17 clean-save and its recovery (Restore previous state).
import fs from 'node:fs';
import path from 'node:path';
import { TRANSPARENT } from '../core/config.js';
import { encodeCanonical } from '../core/pipeline.js';
import { parseName, groupId, parseGroupId, checkMembership } from '../core/naming.js';
import { loadConfig, readJson, sha256File, sha256Bytes, artPaths } from './store.js';
import { loadPlacement, placementPath, markerPath, assertNoMarker, newTrashDir, writeAtomic, groupCleanFiles } from './cleanstore.js';
import { batchPath } from './commands.js';
import { cmdValidate, cmdExport } from './commands3.js';

function confirmErr(msg) { const e = new Error(msg); e.code = 'CONFIRM'; return e; }
function conflictErr(files) {
  const e = new Error(`files changed on disk since they were loaded: ${files.join(', ')}`);
  e.code = 'CONFLICT'; e.conflict = files;
  return e;
}
const notesName = (png) => png.replace(/\.png$/, '.notes.json');
const isTmp = (f) => f.endsWith('.tmp');

/** Group notes files on disk: {batch}_*.notes.json */
function groupNotes(cleanDir, batchId) {
  if (!fs.existsSync(cleanDir)) return [];
  return fs.readdirSync(cleanDir).filter((f) => f.startsWith(batchId + '_') && f.endsWith('.notes.json'));
}

/** Decode the index array of a payload frame: `I` (array) or `I_b64` (base64 of w·h bytes). */
function frameIndex(fr, n) {
  let I;
  if (typeof fr.I_b64 === 'string') I = new Uint8Array(Buffer.from(fr.I_b64, 'base64'));
  else if (Array.isArray(fr.I) || fr.I instanceof Uint8Array) I = Uint8Array.from(fr.I);
  else throw new Error(`${fr.name}: frame needs I or I_b64`);
  if (I.length !== n) throw new Error(`${fr.name}: index array has ${I.length} entries, expected ${n}`);
  if (Array.isArray(fr.I) && !fr.I.every((v) => Number.isInteger(v))) throw new Error(`${fr.name}: index array must hold integers`);
  for (const v of I) if (!(v >= 0 && v <= TRANSPARENT)) throw new Error(`${fr.name}: index ${v} is outside the palette (0..${TRANSPARENT})`);
  return I;
}

function checkEntry(name, e, batchRaw, diskRawNames = new Set()) {
  if (!e || typeof e !== 'object') throw new Error(`${name}: missing entry`);
  if (!Array.isArray(e.T) || e.T.length !== 2 || !e.T.every(Number.isInteger)) throw new Error(`${name}: entry.T must be [int, int]`);
  if (e.origin === 'editor') {
    if (e.raw_name != null || e.raw_content_sha256 != null) throw new Error(`${name}: an editor-made frame has raw_name and raw_content_sha256 = null`);
    return { T: e.T.slice(), origin: 'editor', raw_name: null, raw_content_sha256: null };
  }
  if (e.origin !== 'raw') throw new Error(`${name}: entry.origin must be "raw" or "editor"`);
  // an orphan entry from before the FR-22 replace rule stays editable (FR-14 still WARNs it)
  if (typeof e.raw_name !== 'string' || (!batchRaw.has(e.raw_name) && !diskRawNames.has(e.raw_name))) throw new Error(`${name}: raw_name ${JSON.stringify(e.raw_name)} is not a frame of the batch`);
  if (e.raw_content_sha256 != null && !/^[0-9a-f]{64}$/.test(e.raw_content_sha256)) throw new Error(`${name}: raw_content_sha256 must be a hex SHA-256 or null`);
  return { T: e.T.slice(), origin: 'raw', raw_name: e.raw_name, raw_content_sha256: e.raw_content_sha256 ?? null };
}

/**
 * clean-save <group> <payload>
 * payload: { frames: [{ name, from?, I | I_b64, entry }], loaded: { name: sha256 }, loaded_placement_sha256?: sha|null, export?: bool }
 *   from: the loaded clean filename this frame started as (null for duplicates / blanks); notes files follow it.
 * Returns { written, trashed, trash, placement_written, tombstoned, validator, export? } or { unchanged: true, validator }.
 */
export function cmdCleanSave(root, batchId, payload, { yes = false } = {}) {
  const cfg = loadConfig(root);
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  const bp = batchPath(root, batchId);
  if (!fs.existsSync(bp)) throw new Error(`no batch file for ${batchId}`);
  const batch = readJson(bp);
  const dirs = artPaths(root, g.species);
  const cleanDir = dirs.clean;
  assertNoMarker(cleanDir, batchId);
  if (!payload || !Array.isArray(payload.frames) || typeof payload.loaded !== 'object' || payload.loaded == null) throw new Error('payload needs frames[] and loaded{}');
  if (!('loaded_placement_sha256' in payload) || !(payload.loaded_placement_sha256 === null || /^[0-9a-f]{64}$/.test(payload.loaded_placement_sha256))) throw new Error('payload needs loaded_placement_sha256 (the SHA-256 of placement.json when the frames were loaded, or null)');
  // NFR-06: every name in the payload is a frame filename of this group (no paths)
  const ownFrame = (n) => { const p = typeof n === 'string' ? parseName(n) : null; return !!p && groupId(p.species, p.stage, p.variant) === batchId; };
  for (const n of Object.keys(payload.loaded)) if (!ownFrame(n)) throw new Error(`loaded: ${n} is not a frame filename of ${batchId}`);
  const N = cfg.canvas.w * cfg.canvas.h;
  const batchRaw = new Set(batch.units.flatMap((u) => u.frames.map((f) => f.name)));
  const { placement } = loadPlacement(cleanDir, dirs.raw, batchId);
  const diskRawNames = new Set(Object.values(placement.files).map((e) => e.raw_name).filter(Boolean));

  // 1. checks
  const finals = new Map();
  const rawUsed = new Map();
  const anims = {};
  for (const fr of payload.frames) {
    const name = fr && fr.name;
    const p = typeof name === 'string' ? parseName(name) : null;
    if (!p || groupId(p.species, p.stage, p.variant) !== batchId) throw new Error(`${name}: must be a frame filename of ${batchId}`);
    const m = checkMembership(cfg, p.species, p.stage, p.variant);
    if (m) throw new Error(`${name}: ${m}`);
    if (finals.has(name)) throw new Error(`${name}: appears twice`);
    if (fr.from != null && (typeof fr.from !== 'string' || !ownFrame(fr.from) || !Object.prototype.hasOwnProperty.call(payload.loaded, fr.from))) throw new Error(`${name}: from ${JSON.stringify(fr.from)} is not a loaded file`);
    const entry = checkEntry(name, fr.entry, batchRaw, diskRawNames);
    if (entry.raw_name) {
      if (rawUsed.has(entry.raw_name)) throw new Error(`raw frame ${entry.raw_name} is claimed by both ${rawUsed.get(entry.raw_name)} and ${name}`);
      rawUsed.set(entry.raw_name, name);
    }
    const I = frameIndex(fr, N);
    (anims[p.anim] ||= []).push(p.frame);
    finals.set(name, { name, from: fr.from ?? null, entry, bytes: encodeCanonical({ w: cfg.canvas.w, h: cfg.canvas.h, I }, cfg) });
  }
  for (const [a, fs_] of Object.entries(anims)) {
    const s = fs_.slice().sort((x, y) => x - y);
    if (s.some((v, i) => v !== i)) throw new Error(`anim "${a}": frame numbers must be contiguous from 00 (got ${s.join(', ')})`);
  }
  const froms = [...finals.values()].map((f) => f.from).filter(Boolean);
  if (new Set(froms).size !== froms.length) throw new Error('two final frames name the same "from" file');

  // 2. conflict check (412, never confirmable)
  // files whose names are not valid frame names are left alone (the Validator FAILs them; rename them by hand)
  const onDisk = groupCleanFiles(cleanDir, batchId).filter((f) => !isTmp(f) && parseName(f));
  const conflict = [];
  for (const [n, sha] of Object.entries(payload.loaded)) {
    const p = path.join(cleanDir, n);
    if (!fs.existsSync(p)) conflict.push(`${n} (deleted)`);
    else if (sha256File(p) !== sha) conflict.push(n);
  }
  for (const f of onDisk) if (!Object.prototype.hasOwnProperty.call(payload.loaded, f)) conflict.push(`${f} (new on disk)`);
  const pp = placementPath(cleanDir, batchId);
  const curPlacementSha = fs.existsSync(pp) ? sha256File(pp) : null;
  if (payload.loaded_placement_sha256 !== curPlacementSha) conflict.push(path.basename(pp));
  if (conflict.length) throw conflictErr(conflict);

  // 3. raw frames that disappear → confirm, tombstone
  // v3.4: written_sha256 is derived here, never taken from the payload. It survives only when the saved bytes are
  // exactly what the pipeline last wrote to the frame's `from` file (a rename without pixel edits).
  for (const f of finals.values()) {
    const old = f.from ? placement.files[f.from] : null;
    f.entry.written_sha256 = old && old.written_sha256 && old.written_sha256 === sha256Bytes(f.bytes) ? old.written_sha256 : null;
  }
  const before = new Set(Object.values(placement.files).filter((e) => e.origin === 'raw' && e.raw_name).map((e) => e.raw_name));
  const gone = [...before].filter((rn) => !rawUsed.has(rn));
  if (gone.length && !yes) throw confirmErr(`Saving removes the frame(s) made from raw ${gone.join(', ')}. They will not be promoted again (tombstoned) and the files move to .trash/. Continue?`);

  // 4. final state in memory
  const files = {};
  for (const f of finals.values()) files[f.name] = f.entry;
  const tombs = (placement.tombstones || []).filter((t) => !rawUsed.has(t.raw_name));
  const at = new Date().toISOString();
  for (const rn of gone) if (!tombs.some((t) => t.raw_name === rn)) tombs.push({ raw_name: rn, at });
  const newPlacement = { schema: 2, batch_id: batchId, files, tombstones: tombs };

  const writes = []; // [name, bytes]
  for (const f of finals.values()) {
    const p = path.join(cleanDir, f.name);
    if (!fs.existsSync(p) || sha256File(p) !== sha256Bytes(f.bytes)) writes.push([f.name, f.bytes]);
  }
  // notes: desired state follows `from`
  const desiredNotes = new Map();
  for (const f of finals.values()) {
    if (!f.from) continue;
    const np = path.join(cleanDir, notesName(f.from));
    if (fs.existsSync(np)) desiredNotes.set(notesName(f.name), fs.readFileSync(np));
  }
  // a frame without `from` (duplicate / blank) has no notes; notes of frames that no longer exist go to .trash
  for (const [n, data] of desiredNotes) {
    const p = path.join(cleanDir, n);
    if (!fs.existsSync(p) || sha256File(p) !== sha256Bytes(data)) writes.push([n, data]);
  }
  const writeNames = new Set(writes.map((w) => w[0]));
  const toTrash = [
    ...onDisk.filter((f) => !finals.has(f) || writeNames.has(f)),
    ...groupNotes(cleanDir, batchId).filter((n) => !desiredNotes.has(n) || writeNames.has(n)),
  ];
  const placementJson = JSON.stringify(newPlacement, null, 2) + '\n';
  const curPlacement = fs.existsSync(pp) ? fs.readFileSync(pp, 'utf8') : null;
  const norm = (files) => JSON.stringify(Object.keys(files).sort().map((k) => { const e = files[k]; return [k, e.T, e.origin, e.raw_name ?? null, e.raw_content_sha256 ?? null, e.written_sha256 ?? null]; }));
  const curObj = curPlacement != null ? JSON.parse(curPlacement) : null;
  const sameEntries = curObj != null && curObj.schema === 2 && norm(curObj.files || {}) === norm(newPlacement.files)
    && JSON.stringify(curObj.tombstones || []) === JSON.stringify(newPlacement.tombstones);
  if (!writes.length && !toTrash.length && sameEntries) {
    return { unchanged: true, validator: cmdValidate(root, batchId, {}) };
  }

  // 5. write in order: marker → tmp → trash → rename → placement → remove marker
  fs.mkdirSync(cleanDir, { recursive: true });
  const trash = toTrash.length ? newTrashDir(cleanDir) : null;
  const mp = markerPath(cleanDir, batchId);
  writeAtomic(mp, JSON.stringify({
    batch_id: batchId, at, trash: trash && path.relative(cleanDir, trash).split(path.sep).join('/'),
    trashed: toTrash, writes: writes.map(([n, d]) => ({ name: n, sha256: sha256Bytes(d) })),
    placement_sha256_before: curPlacementSha, placement_sha256_after: sha256Bytes(Buffer.from(placementJson)),
  }, null, 2) + '\n');
  const tmpName = (n) => `${n}.${process.pid}.save.tmp`;
  for (const [n, data] of writes) fs.writeFileSync(path.join(cleanDir, tmpName(n)), data);
  if (hooks.afterTmp) hooks.afterTmp();
  for (const n of toTrash) fs.renameSync(path.join(cleanDir, n), path.join(trash, n));
  for (const [n] of writes) fs.renameSync(path.join(cleanDir, tmpName(n)), path.join(cleanDir, n));
  if (hooks.beforePlacement) hooks.beforePlacement();
  writeAtomic(pp, placementJson);
  fs.rmSync(mp);

  // 6. validate (+ optional export)
  const validator = cmdValidate(root, batchId, {});
  const out = {
    written: writes.map((w) => w[0]), trashed: toTrash,
    trash: trash && path.relative(root, trash).split(path.sep).join('/'),
    tombstoned: gone, validator,
  };
  if (payload.export && validator.ok) out.export = cmdExport(root, batchId, {});
  return out;
}

/** Test-only crash simulation points. */
export const hooks = { afterTmp: null, beforePlacement: null };

/**
 * Restore previous state after an interrupted clean-save: remove what the save wrote (final files and .tmp files),
 * put back everything from its trash folder, drop the marker. placement.json was not replaced yet, so the result is
 * the exact state before the save. If placement.json already holds the new state, the save had completed: only the
 * marker is removed.
 */
export function cmdCleanRestore(root, batchId, { yes = false } = {}) {
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  const cleanDir = artPaths(root, g.species).clean;
  const mp = markerPath(cleanDir, batchId);
  if (!fs.existsSync(mp)) throw new Error(`${batchId}: no interrupted save to restore`);
  const m = readJson(mp);
  const pp = placementPath(cleanDir, batchId);
  const cur = fs.existsSync(pp) ? sha256File(pp) : null;
  const writesDone = m.writes.every((w) => fs.existsSync(path.join(cleanDir, w.name)) && sha256File(path.join(cleanDir, w.name)) === w.sha256);
  const trashedGone = m.trashed.filter((n) => !m.writes.some((w) => w.name === n)).every((n) => !fs.existsSync(path.join(cleanDir, n)));
  if (cur === m.placement_sha256_after && (cur !== m.placement_sha256_before || (writesDone && trashedGone))) {
    fs.rmSync(mp);
    return { completed_save: true, restored: [], removed: [] };
  }
  const trash = m.trash ? path.join(cleanDir, m.trash) : null;
  if (trash && (path.relative(cleanDir, trash).startsWith('..') || !path.relative(cleanDir, trash).startsWith('.trash'))) throw new Error('marker names a trash folder outside .trash/');
  if (!yes) throw confirmErr(`Restore ${batchId} to the state before the interrupted save? Files written by that save are removed and ${m.trashed.length} file(s) come back from ${m.trash || 'nowhere'}.`);
  const removed = [];
  const own = new Set(m.trashed);
  if (trash) fs.mkdirSync(trash, { recursive: true });
  for (const f of fs.readdirSync(cleanDir)) {
    if (isTmp(f) && f.startsWith(batchId + '_') && f.includes('.save.tmp')) { fs.rmSync(path.join(cleanDir, f)); removed.push(f); }
  }
  // move away only files that hold what the save wrote (a file not yet replaced is still the original);
  // they go to the trash folder as *.interrupted, so the edits of the interrupted save are not lost either
  const keepDir = trash || newTrashDir(cleanDir);
  for (const w of m.writes) {
    const p = path.join(cleanDir, w.name);
    if (fs.existsSync(p) && sha256File(p) === w.sha256) { fs.renameSync(p, path.join(keepDir, `${w.name}.interrupted`)); removed.push(w.name); }
  }
  const restored = [];
  if (trash && fs.existsSync(trash)) {
    for (const n of fs.readdirSync(trash)) {
      if (!own.has(n)) continue;
      fs.renameSync(path.join(trash, n), path.join(cleanDir, n));
      restored.push(n);
    }
  }
  fs.rmSync(mp);
  return { completed_save: false, restored, removed };
}
