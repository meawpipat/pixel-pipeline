// FR-26 species-rename: move and rename every file of a species and rewrite every JSON reference, without changing
// a single pixel. Crash-safe through art/.species-rename.pending.json (the whole plan; a re-run finishes it).
import fs from 'node:fs';
import path from 'node:path';
import { parseName, parseGroupId, groupId } from '../core/naming.js';
import { isGroupExportFile } from '../core/exportfmt.js';
import { checkConfig } from '../core/config.js';
import { readJson, sha256File, sha256Bytes, artPaths, safeJoin, configPath as projectConfigPath } from './store.js';
import { writeAtomic } from './cleanstore.js';
import { checkSpeciesId } from './species.js';
import { newRemovedDir, step, writeManifest, listBatches } from './remove.js';
import { cmdRebuild } from './commands.js';
import { cmdValidate, cmdExport } from './commands3.js';

function confirmErr(msg) { const e = new Error(msg); e.code = 'CONFIRM'; return e; }
export const renameMarkerPath = (root) => path.join(root, 'art', '.species-rename.pending.json');

/** Central refusal while a rename is pending (FR-26): used by the CLI dispatcher and serve's write wrapper. */
export function assertNoRename(root) {
  const p = renameMarkerPath(root);
  if (!fs.existsSync(p)) return;
  let m = {};
  try { m = readJson(p); } catch { /* unreadable: still refuse */ }
  throw new Error(`an interrupted species-rename ${m.old || '?'} → ${m.new || '?'} must be finished first — run species-rename ${m.old || '<old>'} ${m.new || '<new>'} again`);
}

/** Rename a file name of species `old` (parsed, never string-replaced); null = not a group file (moves unchanged). */
export function renameFileName(f, oldId, newId) {
  const swapGroup = (gid) => { const g = parseGroupId(gid); return g && g.species === oldId ? groupId(newId, g.stage, g.variant) : null; };
  const swapFrame = (frame) => { const p = parseName(frame); if (!p || p.species !== oldId) return null; return frame.replace(`${groupId(oldId, p.stage, p.variant)}_`, `${groupId(newId, p.stage, p.variant)}_`); };
  let m;
  if ((m = /^(.+)\.(batch|placement)\.json$/.exec(f))) { const g = swapGroup(m[1]); return g ? `${g}.${m[2]}.json` : null; }
  if ((m = /^(.+\.png)$/.exec(f))) return swapFrame(m[1]);
  if ((m = /^(.+)\.notes\.json$/.exec(f))) { const r = swapFrame(`${m[1]}.png`); return r ? r.replace(/\.png$/, '.notes.json') : null; }
  if ((m = /^(.+)\.json$/.exec(f))) { const r = swapFrame(`${m[1]}.png`); return r ? r.replace(/\.png$/, '.json') : null; }
  return null;
}

/** All files under a directory, relative paths with '/' (recursively). */
function walk(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link — species-rename does not follow links; replace it by the real files first`);
    if (st.isDirectory()) out.push(...walk(p, `${rel}${f}/`)); else out.push(`${rel}${f}`);
  }
  return out;
}
const onlyIgnorable = (files, kind) => files.every((f) => f.endsWith('.DS_Store') || (kind === 'clean' && f.startsWith('.trash/')));

/** JSON content rewrites (FR-26 step 4). Returns the new object, or null if the file is not one we rewrite. */
function rewriteJson(obj, kind, oldId, newId) {
  const g = (id) => { const p = parseGroupId(id); return p && p.species === oldId ? groupId(newId, p.stage, p.variant) : id; };
  const fr = (n) => renameFileName(n, oldId, newId) || n;
  const src = (s) => (typeof s === 'string' && s.startsWith(`art/source/${oldId}/`) ? `art/source/${newId}/${s.slice(`art/source/${oldId}/`.length)}` : s);
  if (kind === 'batch') return { ...obj, batch_id: g(obj.batch_id), species: obj.species === oldId ? newId : obj.species, units: obj.units.map((u) => ({ ...u, source: src(u.source), frames: u.frames.map((f) => ({ ...f, name: fr(f.name), sidecar: f.sidecar.replace(/[^/]+$/, (b) => fr(b)).replace(`art/raw/${oldId}/`, `art/raw/${newId}/`) })) })) };
  if (kind === 'sidecar') return { ...obj, batch_id: g(obj.batch_id), species: obj.species === oldId ? newId : obj.species, name: fr(obj.name), source: src(obj.source) };
  if (kind === 'placement') {
    const files = {};
    for (const [k, e] of Object.entries(obj.files || {})) files[fr(k)] = e && e.raw_name ? { ...e, raw_name: fr(e.raw_name) } : e;
    return { ...obj, ...(obj.batch_id ? { batch_id: g(obj.batch_id) } : {}), files, ...(obj.tombstones ? { tombstones: obj.tombstones.map((t) => ({ ...t, raw_name: fr(t.raw_name) })) } : {}) };
  }
  return null;
}

/** Config text with `old` replaced by `new` in place (whole JSON tokens), verified by parsing; full rewrite fallback. */
function renameInConfig(text, oldId, newId) {
  const want = JSON.parse(text);
  const st = Object.keys(want.stages).find((k) => want.stages[k].species.includes(oldId));
  want.stages[st].species = want.stages[st].species.map((x) => (x === oldId ? newId : x));
  checkConfig(want);
  const re = new RegExp(`("${st}"\\s*:\\s*\\{[^{}]*?"species"\\s*:\\s*\\[)([^\\]]*)(\\])`, 'g');
  const hits = [...text.matchAll(re)];
  if (hits.length === 1) {
    const h = hits[0];
    const inner = h[2].replace(new RegExp(`"${oldId}"(?=\\s*(,|$))`), JSON.stringify(newId));
    const cand = text.slice(0, h.index) + h[1] + inner + h[3] + text.slice(h.index + h[0].length);
    try { if (JSON.stringify(JSON.parse(cand)) === JSON.stringify(want)) return { text: cand, mode: 'line', stage: st }; } catch { /* fall back */ }
  }
  return { text: JSON.stringify(want, null, 2) + '\n', mode: 'full', stage: st };
}

/** Test-only crash points. */
export const hooks = { afterHalfMoves: null, afterJson: null, beforeExport: null };

/**
 * species-rename <old> <new>
 * Returns { old, new, groups, moved, rewritten, config, exported, export_not_regenerated, symbols, rebuild_check, removed_dir }.
 */
export function cmdSpeciesRename(root, oldId, newId, { yes = false, configPath = projectConfigPath(root) } = {}) {
  const mp = renameMarkerPath(root);
  let m = fs.existsSync(mp) ? readJson(mp) : null;
  if (m && (m.old !== oldId || m.new !== newId)) throw new Error(`an interrupted species-rename ${m.old} → ${m.new} must be finished first`);
  if (!m) {
    const text = fs.readFileSync(configPath, 'utf8');
    const cfg = checkConfig(JSON.parse(text));
    if (typeof oldId !== 'string' || !Object.values(cfg.stages).some((s) => s.species.includes(oldId))) throw new Error(`unknown species "${oldId}"`);
    const err = checkSpeciesId(newId, cfg);
    if (err) throw new Error(err);
    for (const kind of ['source', 'raw', 'clean', 'export']) {
      const left = walk(path.join(root, 'art', kind, newId));
      if (!onlyIgnorable(left, kind)) throw new Error(`art/${kind}/${newId}/ already holds files (${left.slice(0, 3).join(', ')}${left.length > 3 ? ', …' : ''}) — move them away first`);
    }
    const pend = walk(path.join(root, 'art', 'clean', oldId)).filter((f) => f.endsWith('.pending.json'));
    if (pend.length) throw new Error(`species "${oldId}" has an interrupted command: ${pend.join(', ')} — finish it first`);
    const groups = listBatches(root, oldId);
    const conf = renameInConfig(text, oldId, newId);
    const exportFiles = walk(path.join(root, 'art', 'export', oldId));
    const exportedGroups = groups.filter((gid) => exportFiles.some((f) => isGroupExportFile(f, gid)));
    const newG = (gid) => { const p = parseGroupId(gid); return groupId(newId, p.stage, p.variant); };
    const counts = Object.fromEntries(['source', 'raw', 'clean', 'export'].map((k) => [k, walk(path.join(root, 'art', k, oldId)).length]));
    if (!yes) {
      throw confirmErr(`Rename species "${oldId}" to "${newId}"? Groups: ${groups.length ? groups.map((gid) => `${gid} → ${newG(gid)}`).join(', ') : 'none'}. Files that move: source ${counts.source}, raw ${counts.raw}, clean ${counts.clean}; no pixel changes.`
        + `${exportedGroups.length ? ` Export is regenerated from clean with the new names (${exportedGroups.map((gid) => `${gid}.h → ${newG(gid)}.h`).join(', ')}); a group with a Validator FAIL will have no export until fixed, and firmware code using the old symbols must be updated.` : ''}`
        + ` Also record the change in your project's species list.`);
    }
    // 1. plan (+ rebuild check before)
    for (const gid of exportedGroups) { try { cmdValidate(root, gid, {}); } catch (e) { throw new Error(`the Validator cannot read ${gid} (${e.message}) — fix it first`); } }
    const before = Object.fromEntries(groups.map((gid) => [gid, cmdRebuild(root, gid, { check: true }).mismatches]));
    const dir = newRemovedDir(root, 'rename', `${oldId}-${newId}`);
    const moves = [], json = [];
    for (const kind of ['source', 'raw', 'clean']) {
      for (const f of walk(path.join(root, 'art', kind, oldId))) {
        const inTrash = f.startsWith('.trash/');
        const base = f.split('/').pop();
        const renamed = inTrash ? null : renameFileName(base, oldId, newId);
        const toRel = `art/${kind}/${newId}/${f.slice(0, f.length - base.length)}${renamed || base}`;
        const fromRel = `art/${kind}/${oldId}/${f}`;
        moves.push({ from: fromRel, to: toRel, sha: sha256File(path.join(root, fromRel)) });
        if (inTrash || !base.endsWith('.json') || base.endsWith('.notes.json') || base.endsWith('.pending.json')) continue;
        const type = /\.batch\.json$/.test(base) ? 'batch' : /\.placement\.json$/.test(base) ? 'placement' : kind === 'raw' && renamed ? 'sidecar' : null;
        if (!type) continue;
        const before = fs.readFileSync(path.join(root, fromRel));
        const obj = rewriteJson(JSON.parse(before.toString('utf8')), type, oldId, newId);
        const after = JSON.stringify(obj, null, 2) + '\n';
        if (after !== before.toString('utf8')) json.push({ path: toRel, sha_before: sha256Bytes(before), sha_after: sha256Bytes(Buffer.from(after)), content: after });
      }
    }
    // a JSON file rewritten after its move counts as moved on a re-run
    for (const j of json) { const mv = moves.find((x) => x.to === j.path); if (mv) mv.sha_done = j.sha_after; }
    // an identical path that already exists is refused here, before anything changes (same content is fine)
    for (const mv of moves) { const pt = path.join(root, mv.to); if (fs.existsSync(pt) && sha256File(pt) !== mv.sha) throw new Error(`${mv.to} already exists with other content — move it away first`); }
    for (const f of exportFiles) moves.push({ from: `art/export/${oldId}/${f}`, to: `${dir}/export/${oldId}/${f}`, sha: sha256File(path.join(root, 'art', 'export', oldId, f)) });
    m = {
      old: oldId, new: newId, dir, moves, json,
      config: { sha_before: sha256Bytes(Buffer.from(text)), content: conf.text, mode: conf.mode, stage: conf.stage },
      export_groups: exportedGroups.map(newG), groups: groups.map((gid) => [gid, newG(gid)]), before,
    };
    m.manifest = {
      command: `species-rename ${oldId} ${newId}`, at: new Date().toISOString(),
      moved: moves, rewritten_json: json.map((j) => j.path), config_line: { stage: conf.stage, from: JSON.stringify(oldId), to: JSON.stringify(newId) },
      restore: `Run species-rename ${newId} ${oldId} to rename it back (the old export files are in this folder).`,
    };
    writeAtomic(mp, JSON.stringify(m, null, 2) + '\n'); // the marker first: everything after it is resumable
  }
  if (m.manifest && !fs.existsSync(path.join(root, m.dir, 'manifest.json'))) writeManifest(root, m.dir, m.manifest);

  // 3. moves (SHA-tagged, never overwrite)
  let moved = 0;
  m.moves.forEach((st, i) => { if (step(root, st)) moved++; if (i === Math.floor(m.moves.length / 2) && hooks.afterHalfMoves) hooks.afterHalfMoves(); });
  // 4. JSON rewrites through temp + rename (first drop temp files a crash left behind)
  for (const t of [mp, ...m.json.map((j) => safeJoin(root, j.path, 'art'))]) {
    const d = path.dirname(t), b = path.basename(t);
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) if (f.startsWith(b + '.') && /^\d+\.\d+\.tmp$/.test(f.slice(b.length + 1))) fs.rmSync(path.join(d, f));
  }
  let rewritten = 0;
  for (const j of m.json) {
    const p = safeJoin(root, j.path, 'art');
    const cur = sha256File(p);
    if (cur === j.sha_after) continue;
    if (cur !== j.sha_before) throw new Error(`${j.path} changed since the rename was planned — fix it by hand, then run species-rename ${m.old} ${m.new} again`);
    writeAtomic(p, j.content); rewritten++;
  }
  if (hooks.afterJson) hooks.afterJson();
  // 5. config
  const curCfg = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(curCfg);
  const has = (id) => Object.values(parsed.stages).some((s) => s.species.includes(id));
  if (!(has(m.new) && !has(m.old))) {
    if (sha256Bytes(Buffer.from(curCfg)) !== m.config.sha_before) throw new Error(`the config changed since the rename was planned — replace "${m.old}" by "${m.new}" in it by hand, then run species-rename ${m.old} ${m.new} again`);
    writeAtomic(configPath, m.config.content);
  }
  // 6. export
  const exported = [], notExported = [];
  for (const gid of m.export_groups) {
    let v;
    try { v = cmdValidate(root, gid, {}); } catch (e) { throw new Error(`validating ${gid} failed (${e.message}) — fix the cause, then run species-rename ${m.old} ${m.new} again to finish`); }
    if (!v.ok) { notExported.push(gid); continue; }
    try { if (hooks.beforeExport) hooks.beforeExport(gid); cmdExport(root, gid, {}); } catch (e) { throw new Error(`export of ${gid} failed (${e.message}) — fix the cause, then run species-rename ${m.old} ${m.new} again to finish`); }
    exported.push(gid);
  }
  // 7. rebuild check after (compare with before, names renamed)
  const check = [];
  for (const [o, n] of m.groups) {
    const after = cmdRebuild(root, n, { check: true }).mismatches;
    const expect = (m.before[o] || []).map((x) => x.replace(/^[^:]+/, (nm) => renameFileName(nm, m.old, m.new) || nm));
    if (JSON.stringify(after) !== JSON.stringify(expect)) check.push({ group: n, before: m.before[o], after });
  }
  // 8. empty old folders, then the marker
  for (const kind of ['source', 'raw', 'clean', 'export']) {
    const d = path.join(root, 'art', kind, m.old);
    if (!fs.existsSync(d)) continue;
    const rest = walk(d);
    if (rest.every((f) => f.endsWith('.DS_Store'))) fs.rmSync(d, { recursive: true, force: true });
  }
  fs.rmSync(mp);
  const symbols = m.export_groups.map((n) => ({ header: `${m.groups.find((x) => x[1] === n)[0]}.h → ${n}.h`, symbol_prefix: `${m.groups.find((x) => x[1] === n)[0].replace(/-fat/, '_fat')}_ → ${n.replace(/-fat/, '_fat')}_` }));
  return { old: m.old, new: m.new, groups: m.groups.map(([o, n]) => `${o} → ${n}`), moved, rewritten, config: m.config.mode, stage: Number(m.config.stage), exported, export_not_regenerated: notExported, symbols, rebuild_check: check.length ? check : 'unchanged', removed_dir: m.dir };
}
