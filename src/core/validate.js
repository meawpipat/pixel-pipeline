// FR-14 Validator (pure; the CLI gathers files and metadata).
import { decodePng } from './png.js';
import { hexToRgb, TRANSPARENT } from './config.js';
import { parseName, groupId, checkMembership, budgetWarnings } from './naming.js';
import { outlineRatio } from './frame.js';

export function canonicalPalette(cfg) {
  return cfg.palette.map(hexToRgb).concat([hexToRgb(cfg.transparent.rgb)]);
}

/** Decode and check canonical format. Returns { I, problems[] }. */
export function readCanonical(bytes, cfg) {
  const problems = [];
  let d;
  try { d = decodePng(bytes); } catch (e) { return { I: null, problems: [`not a readable PNG (${e.message})`] }; }
  if (d.w !== cfg.canvas.w || d.h !== cfg.canvas.h) problems.push(`size ${d.w}x${d.h}, expected ${cfg.canvas.w}x${cfg.canvas.h}`);
  if (d.colorType !== 3 || !d.indexed) { problems.push('not an indexed PNG — run normalize'); return { I: null, problems }; }
  const pal = canonicalPalette(cfg);
  const plte = d.indexed.palette || new Uint8Array(0);
  const trns = d.indexed.trns || new Uint8Array(0);
  const palOk = plte.length === 15 && pal.every((c, i) => c[0] === plte[i * 3] && c[1] === plte[i * 3 + 1] && c[2] === plte[i * 3 + 2]);
  const trnsOk = trns.length === 5 && [255, 255, 255, 255, 0].every((v, i) => trns[i] === v);
  if (!palOk || !trnsOk) problems.push('palette/tRNS is not the canonical 5-entry palette — run normalize');
  let bad = 0;
  for (const v of d.indexed.data) if (v > TRANSPARENT) bad++;
  if (bad) problems.push(`${bad} pixel(s) use an index > 4`);
  return { I: d.indexed.data, problems };
}

/**
 * opts: { mode: 'clean'|'raw', batchId, files: [{ name, bytes }], batch, placement?, rawContent?: Map, marker?, notes?: Map, cfg }
 * Returns { fails: [], warns: [], infos: [] }.
 */
/**
 * Clean mode inputs (FR-14, schema 2): placement (migrated), rawContent: Map(raw frame name → content hash)
 * for every raw frame of the batch, marker: true when an interrupted clean-save left its marker.
 */
export function validateGroup({ mode, batchId, files, batch, placement, rawContent = new Map(), marker = false, retranslateMarker = false, promoteMarker = false, removeMarker = false, notes = new Map(), cfg }) {
  const fails = [], warns = [], infos = [];
  const anims = {};
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  const g = batch;
  for (const f of files) {
    const p = parseName(f.name);
    if (!p) { fails.push(`${f.name}: bad filename (expected {species}_s{stage}[-fat]_{anim}_{NN}.png)`); continue; }
    if (groupId(p.species, p.stage, p.variant) !== batchId) continue;
    const m = checkMembership(cfg, p.species, p.stage, p.variant);
    if (m) fails.push(`${f.name}: ${m}`);
    const { I, problems } = readCanonical(f.bytes, cfg);
    for (const pr of problems) fails.push(`${f.name}: ${pr}`);
    (anims[p.anim] ||= []).push(p.frame);
    if (!I || I.length !== cfg.canvas.w * cfg.canvas.h) continue;
    const w = cfg.canvas.w;
    for (let i = 0; i < I.length; i++) if (I[i] < TRANSPARENT) {
      const x = i % w, y = (i / w) | 0;
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
    }
    const ratio = outlineRatio({ w, h: cfg.canvas.h, I });
    if (ratio > cfg.processing.outline_warn_ratio) {
      const n = notes.get(f.name);
      const msg = `${f.name}: open/grey outline (${(ratio * 100).toFixed(0)}% of edge pixels not black)`;
      if (n && n.outline_override === true && n.reason) infos.push(msg + ` — overridden: ${n.reason}`);
      else warns.push(msg);
    }
    if (mode === 'clean' && placement) {
      const e = placement.files[f.name];
      if (!e) fails.push(`${f.name}: no entry in placement.json (hand-copied?) — register it with promote --adopt ${f.name}`);
      else if (g && JSON.stringify(e.T) !== JSON.stringify(g.T)) fails.push(`${f.name}: placed with T=${JSON.stringify(e.T)}, batch T=${JSON.stringify(g.T)} — run retranslate`);
    }
  }
  if (mode === 'clean') {
    if (marker) fails.push(`${batchId}: interrupted save — Restore previous state (Clean Editor, or clean-restore ${batchId})${marker.trash ? `; superseded files are in art/clean/${batch ? batch.species : ''}/${marker.trash}` : ''}`);
    if (removeMarker) fails.push(`${batchId}: interrupted ${removeMarker} — run it again with the same arguments to finish it`);
    if (promoteMarker) fails.push(`${batchId}: interrupted promote — run promote again to finish it`);
    if (retranslateMarker) fails.push(`${batchId}: interrupted retranslate — run retranslate again to finish it`);
    if (!placement) fails.push(`${batchId}.placement.json is missing — run promote`);
    else {
      const present = new Set(files.map((f) => f.name));
      const claimed = new Map();
      for (const [name, e] of Object.entries(placement.files)) {
        if (!present.has(name)) fails.push(`${name}: placement entry without a file (missing clean frame)`);
        if (e.origin !== 'raw') continue;
        claimed.set(e.raw_name, name);
        if (!rawContent.has(e.raw_name)) warns.push(`${name}: orphan clean file (raw frame ${e.raw_name} no longer exists)`);
        else if (e.raw_content_sha256 == null) warns.push(`${name}: no recorded raw content — check it against ${e.raw_name}, then promote --accept-raw ${name}`);
        else if (e.raw_content_sha256 !== rawContent.get(e.raw_name)) warns.push(`${name}: raw changed since promote (${e.raw_name}) — re-check, then promote --accept-raw ${name} or promote --force ${e.raw_name}`);
      }
      const tomb = new Set((placement.tombstones || []).map((t) => t.raw_name));
      for (const rawName of rawContent.keys()) {
        if (claimed.has(rawName) || tomb.has(rawName)) continue;
        if (present.has(rawName)) warns.push(`${rawName}: name taken — a clean file already uses this name, so the raw frame was not promoted (rename it in the Clean Editor, or promote --force ${rawName} --to <clean name>)`);
        else fails.push(`${rawName}: raw frame has no clean counterpart — run promote`);
      }
    }
  }
  for (const [a, frames] of Object.entries(anims)) {
    const s = frames.slice().sort((x, y) => x - y);
    if (s.some((v, i) => v !== i)) fails.push(`anim "${a}": frame numbers not contiguous from 00 (${s.map((v) => String(v).padStart(2, '0')).join(', ')})`);
  }
  if (right >= 0 && g) {
    const box = cfg.stages[String(g.stage)].box;
    const U = { w: right - left + 1, h: bottom - top + 1 };
    if (U.w > box[0] || U.h > box[1]) fails.push(`group union ${U.w}x${U.h} exceeds stage box ${box[0]}x${box[1]}`);
    if (bottom !== cfg.baseline_y) fails.push(`group union bottom row is ${bottom}, expected baseline_y ${cfg.baseline_y}`);
  }
  if (g) for (const w of budgetWarnings(cfg, g.stage, g.variant, anims)) warns.push(w);
  return { fails, warns, infos };
}
