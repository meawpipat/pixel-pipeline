// Clean-folder I/O: placement schema 2 (atomic write, migration), .trash/, save marker.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from '../core/png.js';
import { contentHash, migratePlacement } from '../core/placement.js';
import { parseName, groupId } from '../core/naming.js';
import { sha256File } from './store.js';

export const placementPath = (cleanDir, batchId) => path.join(cleanDir, `${batchId}.placement.json`);
export const markerPath = (cleanDir, batchId) => path.join(cleanDir, `${batchId}.clean-save.pending.json`);
export const retranslateMarkerPath = (cleanDir, batchId) => path.join(cleanDir, `${batchId}.retranslate.pending.json`);
export const promoteMarkerPath = (cleanDir, batchId) => path.join(cleanDir, `${batchId}.promote.pending.json`);
export const removeMarkerPath = (cleanDir, batchId) => path.join(cleanDir, `${batchId}.remove.pending.json`);

const MARKERS = [['clean-save', markerPath], ['promote', promoteMarkerPath], ['retranslate', retranslateMarkerPath], ['remove', removeMarkerPath]];
const FIX = { 'clean-save': 'Restore previous state (Clean Editor, or clean-restore)', promote: 'run promote again to finish it', retranslate: 'run retranslate again to finish it', remove: 'run the same unit-remove / group-remove again to finish it' };

/** The pending marker of a group, or null: { kind, path, data }. */
export function pendingMarker(cleanDir, batchId) {
  for (const [kind, fn] of MARKERS) {
    const p = fn(cleanDir, batchId);
    if (fs.existsSync(p)) { let data = null; try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { data = {}; } return { kind: kind === 'remove' ? (data.cmd || 'unit-remove') : kind, path: p, data }; }
  }
  return null;
}

/** Refuse while a marker other than `allow` exists (FR-15 / FR-17 crash safety). */
export function assertNoMarker(cleanDir, batchId, allow = null) {
  for (const [kind, fn] of MARKERS) {
    if (kind === allow) continue;
    if (fs.existsSync(fn(cleanDir, batchId))) { let k = kind; if (kind === 'remove') { try { k = JSON.parse(fs.readFileSync(fn(cleanDir, batchId), 'utf8')).cmd || 'removal'; } catch { k = 'removal'; } } throw new Error(`${batchId}: an interrupted ${k} left its marker — ${FIX[kind]} first`); }
  }
}

/** Content hash of a raw PNG (index image), or null if missing/unreadable. */
export function rawContentHash(rawDir, name) {
  const p = path.join(rawDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    const d = decodePng(new Uint8Array(fs.readFileSync(p)));
    return d.indexed ? contentHash(d.indexed.data, d.w, d.h) : null;
  } catch { return null; }
}

export function loadPlacement(cleanDir, rawDir, batchId) {
  const p = placementPath(cleanDir, batchId);
  const obj = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  const res = migratePlacement(obj, batchId, {
    fileSha: (n) => (fs.existsSync(path.join(rawDir, n)) ? sha256File(path.join(rawDir, n)) : null),
    contentHash: (n) => rawContentHash(rawDir, n),
  });
  return { ...res, exists: !!obj };
}

/** Atomic write: temp file in the same folder, then rename. */
export function writeAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

export function savePlacement(cleanDir, batchId, placement) {
  writeAtomic(placementPath(cleanDir, batchId), JSON.stringify(placement, null, 2) + '\n');
}

/** A new, unique trash folder: .trash/{ISO-ms}-{n}/ (created). */
export function newTrashDir(cleanDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const d = path.join(cleanDir, '.trash', `${stamp}-${n}`);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); return d; }
  }
}

/** Move files (names in cleanDir) into a trash dir; returns the trash dir (or null if nothing moved). */
export function moveToTrash(cleanDir, names, trashDir = null) {
  const existing = names.filter((n) => fs.existsSync(path.join(cleanDir, n)));
  if (!existing.length) return trashDir;
  const t = trashDir || newTrashDir(cleanDir);
  for (const n of existing) fs.renameSync(path.join(cleanDir, n), path.join(t, n));
  return t;
}

/** Clean PNG filenames belonging to a group. */
export function groupCleanFiles(cleanDir, batchId) {
  if (!fs.existsSync(cleanDir)) return [];
  return fs.readdirSync(cleanDir).filter((f) => {
    if (!f.toLowerCase().endsWith('.png')) return false;
    const p = parseName(f);
    return p ? groupId(p.species, p.stage, p.variant) === batchId : f.startsWith(batchId + '_');
  });
}
