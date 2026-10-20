// FR-15 placement.json schema 2 (pure helpers; the CLI does the file I/O).
import { sha256 } from './sha256.js';
import { TRANSPARENT } from './config.js';

/**
 * Position-independent content hash of an index image: SHA-256 over "w x h" of the
 * opaque bbox followed by the cropped index bytes. A pure translation keeps the hash.
 */
export function contentHash(I, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (I[y * w + x] !== TRANSPARENT) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return sha256('empty');
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const head = new TextEncoder().encode(`${cw}x${ch}:`);
  const buf = new Uint8Array(head.length + cw * ch);
  buf.set(head);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) buf[head.length + y * cw + x] = I[(y0 + y) * w + x0 + x];
  return sha256(buf);
}

export function emptyPlacement(batchId) {
  return { schema: 2, batch_id: batchId, files: {}, tombstones: [] };
}

/**
 * Read any placement object as schema 2.
 * raw: { fileSha(name) → sha | null, contentHash(name) → hash | null } for the current raw files.
 * Returns { placement, migrated: boolean }.
 */
export function migratePlacement(obj, batchId, raw) {
  if (!obj) return { placement: emptyPlacement(batchId), migrated: false };
  if (obj.schema === 2) {
    return { placement: { schema: 2, batch_id: obj.batch_id || batchId, files: obj.files || {}, tombstones: obj.tombstones || [] }, migrated: false };
  }
  const files = {};
  for (const [name, e] of Object.entries(obj.files || {})) {
    const same = e.raw_sha256 && raw.fileSha(name) === e.raw_sha256;
    files[name] = { T: e.T, origin: 'raw', raw_name: name, raw_content_sha256: same ? raw.contentHash(name) : null };
  }
  return { placement: { schema: 2, batch_id: obj.batch_id || batchId, files, tombstones: [] }, migrated: true };
}

/** raw_name → clean filename claiming it. */
export function claimants(placement) {
  const m = new Map();
  for (const [name, e] of Object.entries(placement.files)) if (e.origin === 'raw' && e.raw_name) m.set(e.raw_name, name);
  return m;
}

export const tombstoned = (placement) => new Set((placement.tombstones || []).map((t) => t.raw_name));
