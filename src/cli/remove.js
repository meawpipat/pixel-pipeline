// FR-19 unit-remove, FR-20 group-remove, FR-21 species-remove (spec v3.5).
// Nothing is deleted: everything taken out moves to art/_removed/{ISO-ms}-{n}-{kind}-{name}/ (path below art/ kept),
// with a manifest.json. A {group}.remove.pending.json marker makes every removal finishable by re-running it.
import fs from 'node:fs';
import path from 'node:path';
import { parseGroupId, parseName, groupId } from '../core/naming.js';
import { checkConfig } from '../core/config.js';
import { loadConfig, readJson, writeJson, sha256File, artPaths, safeJoin, configPath as projectConfigPath } from './store.js';
import { loadPlacement, savePlacement, writeAtomic, removeMarkerPath, assertNoMarker, groupCleanFiles } from './cleanstore.js';
import { batchPath, computeGroup, cmdRebuild } from './commands.js';
import { isGroupExportFile } from '../core/exportfmt.js';

function confirmErr(msg) { const e = new Error(msg); e.code = 'CONFIRM'; return e; }
const LOCAL_ONLY = 'Moved files go to art/_removed/ (local only, not committed).';
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** A new art/_removed/{ISO-ms}-{n}-{kind}-{name}/ folder name (relative to root; created later). */
export function newRemovedDir(root, kind, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const r = `art/_removed/${stamp}-${n}-${kind}-${name}`;
    if (!fs.existsSync(path.join(root, r))) return r;
  }
}

/**
 * One planned step: move art-relative file `from` to art-relative `to` (a removal folder or a new name), identified by
 * the SHA it had when the plan was made. Done if `to` already holds that SHA; done now if `from` holds it and `to` is
 * free; anything else refuses (never overwrites, never guesses). Returns true when it moved a file in this call.
 */
export function step(root, { from, to, sha, sha_done = null }) {
  const pf = safeJoin(root, from, 'art'), pt = safeJoin(root, to, 'art');
  if (fs.existsSync(pt)) {
    const cur = sha256File(pt);
    if (cur === sha || (sha_done && cur === sha_done)) { // finished by an earlier run (sha_done: already rewritten after the move)
      if (cur === sha && fs.existsSync(pf) && sha256File(pf) === sha) fs.rmSync(pf); // the same content already at the target: drop the duplicate
      return false;
    }
    throw new Error(`${to} already exists with other content — move it away by hand, then run the command again`);
  }
  if (!fs.existsSync(pf)) throw new Error(`${from} is missing (expected to move it to ${to}) — restore it by hand, then run the command again`);
  if (sha256File(pf) !== sha) throw new Error(`${from} changed since the removal was planned — restore it by hand, then run the command again`);
  fs.mkdirSync(path.dirname(pt), { recursive: true });
  fs.renameSync(pf, pt);
  return true;
}
/** Plan a move of art-relative `r` into removal folder `dir` (only if it exists now). */
const planMove = (root, dir, r) => (fs.existsSync(safeJoin(root, r, 'art')) ? [{ from: r, to: `${dir}/${r.replace(/^art\//, '')}`, sha: sha256File(path.join(root, r)) }] : []);

export function writeManifest(root, dir, m) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeAtomic(path.join(root, dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

/** Pending removal marker of a group: refuse unless it is exactly this command (then return it for resuming). */
function removalMarker(cleanDir, batchId, cmd, args) {
  assertNoMarker(cleanDir, batchId, 'remove');
  const mp = removeMarkerPath(cleanDir, batchId);
  if (!fs.existsSync(mp)) return null;
  let m;
  try { m = readJson(mp); } catch { throw new Error(`${path.basename(mp)} is unreadable — check it by hand (it lists an interrupted removal)`); }
  if (m.cmd !== cmd || JSON.stringify(m.args) !== JSON.stringify(args)) {
    throw new Error(`${batchId}: an interrupted ${m.cmd} ${JSON.stringify(m.args)} must be finished first — run it again with the same arguments`);
  }
  return m;
}

/** Hooks for crash tests only. */
export const hooks = { afterClean: null, afterRawMove: null, afterHalfGroup: null };

// ---------------------------------------------------------------- FR-19
/**
 * unit-remove <group> <unit_id> [--edited keep|trash]
 * Returns { batch_id, unit_id, moved, kept_as_editor, renamed_raw, renamed_clean, retranslate_needed, name_taken, removed_dir }
 * (or the group-remove report when it was the only unit).
 */
export function cmdUnitRemove(root, batchId, unitId, { edited = 'keep', yes = false } = {}) {
  const cfg = loadConfig(root);
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  if (!['keep', 'trash'].includes(edited)) throw new Error('--edited must be keep or trash');
  const bp = batchPath(root, batchId);
  const dirs = artPaths(root, g.species);
  // a group-remove that this unit-remove delegated to (only unit) is finished by the same unit-remove too
  const rmp = removeMarkerPath(dirs.clean, batchId);
  if (fs.existsSync(rmp)) { let pm = {}; try { pm = readJson(rmp); } catch { /* reported by removalMarker */ } if (pm.cmd === 'group-remove' && pm.via_unit === unitId) return { ...cmdGroupRemove(root, batchId, { yes: true }), via_unit_remove: unitId }; }
  if (!fs.existsSync(bp) && !fs.existsSync(rmp)) throw new Error(`no group ${batchId}`);
  const args = { unit: unitId, edited };
  let m = removalMarker(dirs.clean, batchId, 'unit-remove', args);

  if (!m) {
    const batch = readJson(bp);
    const unit = batch.units.find((u) => u.id === unitId);
    if (!unit) throw new Error(`${batchId} has no unit "${unitId}" (units: ${batch.units.map((u) => u.id).join(', ')})`);
    if (batch.units.length === 1) {
      if (!yes) throw confirmErr(`"${unitId}" is the only unit of ${batchId}, so removing it removes the whole group. ${groupRemovePlanText(root, batchId)} ${LOCAL_ONLY}`);
      return { ...cmdGroupRemove(root, batchId, { yes: true, viaUnit: unitId }), via_unit_remove: unitId };
    }
    // later units of the same anim move down by n
    const n = unit.frames.length, start = unit.frame_start || 0;
    const renames = {}; // old raw name → new raw name
    const newUnits = [];
    for (const u of batch.units) {
      if (u.id === unitId) continue;
      if (u.anim === unit.anim && (u.frame_start || 0) > start) {
        const fs2 = (u.frame_start || 0) - n;
        const frames = u.frames.map((f0, i) => { // positional over used segments (FR-23)
          const f = { ...f0, segment: f0.segment ?? i };
          const name = `${batchId}_${u.anim}_${String(fs2 + i).padStart(2, '0')}.png`;
          renames[f.name] = name;
          return { ...f, name, sidecar: `art/raw/${g.species}/${name.replace(/\.png$/, '.json')}` };
        });
        newUnits.push({ ...u, frame_start: fs2, frames });
      } else newUnits.push(u);
    }
    const newBatch = { ...batch, units: newUnits };
    // new sidecars (renamed units only), from the current ones
    const newSidecars = {};
    for (const u of newUnits) for (const f of u.frames) {
      const oldName = Object.keys(renames).find((k) => renames[k] === f.name);
      if (!oldName) continue;
      const oldF = batch.units.find((x) => x.id === u.id).frames.find((x) => x.name === oldName);
      const sc = readJson(path.join(root, oldF.sidecar));
      newSidecars[f.sidecar] = { ...sc, name: f.name, frame: (u.frame_start || 0) + u.frames.indexOf(f) };
    }
    // 1. dry run before anything moves
    computeGroup(root, newBatch, new Map(Object.entries(newSidecars)), cfg);

    // clean plan
    const { placement } = loadPlacement(dirs.clean, dirs.raw, batchId);
    const own = new Set(unit.frames.map((f) => f.name));
    const cleanMoves = [], keptAsEditor = [], droppedEntries = {};
    const newFiles = {};
    const isOwnFrame = (n) => { const p = parseName(n); return !!p && groupId(p.species, p.stage, p.variant) === batchId; };
    for (const [name, e] of Object.entries(placement.files)) {
      if (!isOwnFrame(name)) { newFiles[name] = e; continue; } // never touch a key that is not a frame filename of the group
      if (e.origin === 'raw' && own.has(e.raw_name)) {
        const p = path.join(dirs.clean, name);
        const exists = fs.existsSync(p);
        const sha = exists ? sha256File(p) : null;
        const rawP = path.join(dirs.raw, e.raw_name);
        const untouched = !exists || (e.written_sha256 && sha === e.written_sha256) || (!e.written_sha256 && fs.existsSync(rawP) && sha === sha256File(rawP));
        if (untouched || edited === 'trash') {
          cleanMoves.push(name);
          droppedEntries[name] = e;
          continue;
        }
        newFiles[name] = { T: e.T, origin: 'editor', raw_name: null, raw_content_sha256: null, written_sha256: null };
        keptAsEditor.push(name);
        droppedEntries[name] = e;
        continue;
      }
      newFiles[name] = e.origin === 'raw' && renames[e.raw_name] ? { ...e, raw_name: renames[e.raw_name] } : e;
    }
    const droppedTombs = (placement.tombstones || []).filter((t) => own.has(t.raw_name));
    const tombstones = (placement.tombstones || []).filter((t) => !own.has(t.raw_name)).map((t) => (renames[t.raw_name] ? { ...t, raw_name: renames[t.raw_name] } : t));
    // renumber the remaining clean frames of the anim by position (name order), so no gap remains
    const anim = unit.anim;
    const remaining = groupCleanFiles(dirs.clean, batchId).filter((f) => { const p = parseName(f); return p && p.anim === anim && !cleanMoves.includes(f); }).sort();
    const cleanRenames = [];
    remaining.forEach((f, i) => { const to = `${batchId}_${anim}_${String(i).padStart(2, '0')}.png`; if (to !== f) cleanRenames.push([f, to]); });
    const files2 = {};
    const rmap = Object.fromEntries(cleanRenames);
    for (const [k, e] of Object.entries(newFiles)) {
      const key = rmap[k] || k;
      if (files2[key]) throw new Error(`placement entry ${key} has no clean file and would be replaced by a renumbered frame — fix it first (Validator: "placement entry without a file")`);
      files2[key] = e;
    }
    for (const [, to] of cleanRenames) if (newFiles[to] && !rmap[to]) throw new Error(`placement entry ${to} has no clean file and would be replaced by a renumbered frame — fix it first`);
    const placementAfter = { schema: 2, batch_id: batchId, files: files2, tombstones };
    const hasClean = fs.existsSync(path.join(dirs.clean, `${batchId}.placement.json`));

    if (!yes) {
      const edits = Object.entries(placement.files).filter(([nm, e]) => e.origin === 'raw' && own.has(e.raw_name) && !cleanMoves.includes(nm)).map(([nm]) => nm);
      const editedNow = edited === 'trash' ? cleanMoves.filter((nm) => { const e = placement.files[nm]; const p = path.join(dirs.clean, nm); return fs.existsSync(p) && e.written_sha256 !== sha256File(p) && !(fs.existsSync(path.join(dirs.raw, e.raw_name)) && sha256File(p) === sha256File(path.join(dirs.raw, e.raw_name))); }) : [];
      throw confirmErr(`Remove unit "${unitId}" (${unit.anim} ${unit.frames.map((f) => f.name).join(', ')}) from ${batchId}?`
        + `${cleanMoves.length ? ` Clean frames moved out: ${cleanMoves.join(', ')}${editedNow.length ? ` (including your edited ${editedNow.join(', ')})` : ''}.` : ''}`
        + `${edits.length ? ` Your edited clean frames ${edits.join(', ')} stay as editor-made frames.` : ''}`
        + `${Object.keys(renames).length ? ` Later frames move down: ${Object.entries(renames).map(([a, b]) => `${a} → ${b}`).join(', ')}.` : ''} ${LOCAL_ONLY}`);
    }
    const dir = newRemovedDir(root, 'unit', `${batchId}-${unit.id}`);
    const rawMoves = [...unit.frames.flatMap((f) => [`art/raw/${g.species}/${f.name}`, f.sidecar])];
    const oldSidecarsOfRenamed = batch.units.filter((u) => newUnits.some((x) => x.id === u.id && x.frame_start !== u.frame_start)).flatMap((u) => u.frames.map((f) => f.sidecar));
    m = {
      cmd: 'unit-remove', args, dir, batch_id: batchId,
      // one ordered, SHA-tagged clean plan: moves out first, then renames in ascending target order
      clean_steps: [
        ...cleanMoves.flatMap((nm) => [...planMove(root, dir, `art/clean/${g.species}/${nm}`), ...planMove(root, dir, `art/clean/${g.species}/${nm.replace(/\.png$/, '.notes.json')}`)]),
        ...cleanRenames.flatMap(([a, b]) => [[a, b], [a.replace(/\.png$/, '.notes.json'), b.replace(/\.png$/, '.notes.json')]])
          .filter(([a]) => fs.existsSync(path.join(dirs.clean, a)))
          .map(([a, b]) => ({ from: `art/clean/${g.species}/${a}`, to: `art/clean/${g.species}/${b}`, sha: sha256File(path.join(dirs.clean, a)) })),
      ],
      placement_after: hasClean ? placementAfter : null,
      raw_steps: [...rawMoves, ...oldSidecarsOfRenamed].flatMap((r) => planMove(root, dir, r)),
      new_sidecars: newSidecars, new_batch: newBatch, T_before: batch.T, renames, kept_as_editor: keptAsEditor,
      renamed_clean: Object.fromEntries(cleanRenames),
    };
    writeManifest(root, dir, {
      command: `unit-remove ${batchId} ${unit.id} --edited ${edited}`, at: new Date().toISOString(),
      removed_unit: unit, renamed_raw: renames,
      renamed_units: newUnits.filter((u) => batch.units.find((x) => x.id === u.id).frame_start !== u.frame_start).map((u) => ({ id: u.id, frame_start_before: batch.units.find((x) => x.id === u.id).frame_start, frame_start_after: u.frame_start })),
      dropped_placement_entries: droppedEntries, dropped_tombstones: droppedTombs, kept_as_editor: keptAsEditor, renamed_clean: Object.fromEntries(cleanRenames),
      moved: [...m.clean_steps, ...m.raw_steps],
      restore: 'Move the files back, re-insert removed_unit into the batch file (and undo renamed_units / renamed_raw), re-insert dropped_placement_entries and dropped_tombstones into placement.json, then run rebuild.',
    });
    fs.mkdirSync(dirs.clean, { recursive: true });
    writeAtomic(removeMarkerPath(dirs.clean, batchId), JSON.stringify(m, null, 2) + '\n');
  }

  // 3. clean side (a re-run first clears temp files of an interrupted atomic write)
  for (const f of fs.existsSync(dirs.clean) ? fs.readdirSync(dirs.clean) : []) if (f.startsWith(batchId + '.') && f.endsWith('.tmp') && /\.(placement|remove\.pending)\.json\.\d+\.\d+\.tmp$/.test(f)) fs.rmSync(path.join(dirs.clean, f));
  const moved = [];
  for (const st of m.clean_steps) if (step(root, st) && st.to.startsWith('art/_removed/')) moved.push(st.from);
  if (m.placement_after) savePlacement(dirs.clean, batchId, m.placement_after);
  if (hooks.afterClean) hooks.afterClean();
  // 4. raw side: old sidecars of the removed and renamed units first, then the new sidecars, the batch, rebuild
  for (const st of m.raw_steps) if (step(root, st)) moved.push(st.from);
  if (hooks.afterRawMove) hooks.afterRawMove();
  for (const [r, sc] of Object.entries(m.new_sidecars)) writeJson(safeJoin(root, r, `art/raw/${g.species}`), sc);
  writeJson(bp, m.new_batch);
  const rb = cmdRebuild(root, batchId, {});
  fs.rmSync(removeMarkerPath(dirs.clean, batchId));
  // raw frames whose filename a kept editor-made frame now holds (FR-14 "name taken")
  const pl = loadPlacement(dirs.clean, dirs.raw, batchId).placement;
  const claimed = new Set(Object.values(pl.files).map((e) => e.raw_name).filter(Boolean));
  const tomb = new Set((pl.tombstones || []).map((t) => t.raw_name));
  const nameTaken = m.new_batch.units.flatMap((u) => u.frames.map((f) => f.name)).filter((n) => !claimed.has(n) && !tomb.has(n) && fs.existsSync(path.join(dirs.clean, n)));
  const remainingClean = groupCleanFiles(dirs.clean, batchId).length > 0;
  const srcStillUsed = (src) => listBatches(root, g.species).some((id) => readJson(batchPath(root, id)).units.some((u) => u.source === src));
  const removedUnit = readJson(path.join(root, m.dir, 'manifest.json')).removed_unit;
  return {
    batch_id: batchId, unit_id: unitId, removed_dir: m.dir, moved, kept_as_editor: m.kept_as_editor,
    renamed_raw: m.renames, renamed_clean: m.renamed_clean,
    retranslate_needed: remainingClean && JSON.stringify(rb.T) !== JSON.stringify(m.T_before), name_taken: nameTaken,
    source_unused: srcStillUsed(removedUnit.source) ? null : removedUnit.source,
  };
}

export function listBatches(root, species) {
  const d = artPaths(root, species).raw;
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.batch.json')).map((f) => f.replace(/\.batch\.json$/, '')).filter((id) => parseGroupId(id)) : [];
}

// ---------------------------------------------------------------- FR-20
function groupRemovePlan(root, batchId) {
  const g = parseGroupId(batchId);
  const dirs = artPaths(root, g.species);
  const list = (d, pred) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile() && pred(f)).sort() : []);
  const mine = (f) => f.startsWith(batchId + '_') || f.startsWith(batchId + '.');
  const isMarker = (f) => f.endsWith('.pending.json');
  const batch = fs.existsSync(batchPath(root, batchId)) ? readJson(batchPath(root, batchId)) : { units: [] };
  const others = listBatches(root, g.species).filter((id) => id !== batchId);
  const otherSources = new Set(others.flatMap((id) => readJson(batchPath(root, id)).units.map((u) => u.source)));
  const sources = [...new Set(batch.units.map((u) => u.source))].filter((s) => !otherSources.has(s) && fs.existsSync(path.join(root, s)));
  return {
    export: list(dirs.export, (f) => isGroupExportFile(f, batchId)).map((f) => `art/export/${g.species}/${f}`),
    clean: list(dirs.clean, (f) => mine(f) && !isMarker(f)).map((f) => `art/clean/${g.species}/${f}`),
    raw: list(dirs.raw, (f) => mine(f) && !f.endsWith('.batch.json')).map((f) => `art/raw/${g.species}/${f}`),
    source: sources,
    batch: [`art/raw/${g.species}/${batchId}.batch.json`],
  };
}
function groupRemovePlanText(root, batchId) {
  const p = groupRemovePlan(root, batchId);
  return `Files that move: export ${p.export.length}, clean ${p.clean.length}, raw ${p.raw.length}, source ${p.source.length}, batch 1.`;
}

/** group-remove <group> */
export function cmdGroupRemove(root, batchId, { yes = false, viaUnit = null } = {}) {
  const g = parseGroupId(batchId);
  if (!g) throw new Error(`invalid batch id "${batchId}"`);
  const dirs = artPaths(root, g.species);
  let m = removalMarker(dirs.clean, batchId, 'group-remove', {}); // checked before "no such group": the batch may already be moved
  if (!m && !fs.existsSync(batchPath(root, batchId))) throw new Error(`no group ${batchId}`);
  if (!m) {
    if (!yes) throw confirmErr(`Remove the whole group ${batchId}? ${groupRemovePlanText(root, batchId)} Sources used by another group stay. ${LOCAL_ONLY}`);
    const files = groupRemovePlan(root, batchId);
    const dir = newRemovedDir(root, 'group', batchId);
    const plan = Object.fromEntries(Object.entries(files).map(([k, list]) => [k, list.flatMap((r) => planMove(root, dir, r))]));
    m = { cmd: 'group-remove', args: {}, via_unit: viaUnit, dir, batch_id: batchId, plan };
    writeManifest(root, dir, {
      command: `group-remove ${batchId}`, at: new Date().toISOString(),
      moved: [...plan.export, ...plan.clean, ...plan.raw, ...plan.source, ...plan.batch],
      restore: 'Move every file back to its "from" path. The batch file, sidecars and placement.json travel with the group, so nothing else needs re-inserting.',
    });
    fs.mkdirSync(dirs.clean, { recursive: true });
    writeAtomic(removeMarkerPath(dirs.clean, batchId), JSON.stringify(m, null, 2) + '\n');
  }
  const moved = [];
  const order = ['export', 'clean', 'raw', 'source'];
  let k = 0;
  for (const key of order) for (const st of m.plan[key]) {
    if (step(root, st)) moved.push(st.from);
    if (++k === 3 && hooks.afterHalfGroup) hooks.afterHalfGroup();
  }
  for (const st of m.plan.batch) if (step(root, st)) moved.push(st.from);
  fs.rmSync(removeMarkerPath(dirs.clean, batchId));
  return { batch_id: batchId, removed_dir: m.dir, moved };
}

// ---------------------------------------------------------------- FR-21
/** species-remove <id> */
export function cmdSpeciesRemove(root, id, { yes = false, configPath = projectConfigPath(root) } = {}) {
  const text = fs.readFileSync(configPath, 'utf8');
  const cfg = checkConfig(JSON.parse(text));
  const stage = Object.keys(cfg.stages).find((k) => cfg.stages[k].species.includes(id));
  if (typeof id !== 'string' || stage === undefined) throw new Error(`unknown species "${id}"`);
  const groups = listBatches(root, id);
  if (groups.length) throw new Error(`species "${id}" still has group(s) ${groups.join(', ')} — remove them first (group-remove)`);
  const want = JSON.parse(text);
  want.stages[stage].species = want.stages[stage].species.filter((s) => s !== id);
  checkConfig(want); // a stage may end up empty, but the config must stay valid
  // leftovers: every file under art/{source,raw,clean,export}/{id}/ except the clean .trash/
  const left = [];
  for (const kind of ['source', 'raw', 'clean', 'export']) {
    const base = path.join(root, 'art', kind, id);
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (!(kind === 'clean' && f === '.trash' && d === base)) walk(p); } else left.push(rel(root, p)); } };
    walk(base);
  }
  if (left.some((r) => r.endsWith('.pending.json'))) throw new Error(`species "${id}" has an interrupted command marker: ${left.filter((r) => r.endsWith('.pending.json')).join(', ')}`);
  if (!yes) throw confirmErr(`Remove species "${id}" (stage ${stage}) from the config?${left.length ? ` Its remaining files move out: ${left.join(', ')}.` : ''} ${LOCAL_ONLY}`);
  // textual edit (FR-18 rule)
  let out = null;
  const stageRe = new RegExp(`("${stage}"\\s*:\\s*\\{[^{}]*?"species"\\s*:\\s*\\[)([^\\]]*)(\\])`, 'g');
  const hits = [...text.matchAll(stageRe)];
  if (hits.length === 1) {
    const h = hits[0];
    const items = h[2].split(',').map((x) => x.trim()).filter((x) => x && x !== JSON.stringify(id));
    const lead = h[2].match(/^\s*/)[0], trail = h[2].match(/\s*$/)[0];
    const cand = text.slice(0, h.index) + h[1] + (items.length ? lead + items.join(', ') + trail : '') + h[3] + text.slice(h.index + h[0].length);
    try { if (JSON.stringify(JSON.parse(cand)) === JSON.stringify(want)) out = cand; } catch { /* fall back */ }
  }
  const mode = out ? 'line' : 'full';
  if (!out) out = JSON.stringify(want, null, 2) + '\n';
  const dir = newRemovedDir(root, 'species', id);
  const steps = left.flatMap((r) => planMove(root, dir, r));
  writeManifest(root, dir, {
    command: `species-remove ${id}`, at: new Date().toISOString(), config_stage: stage, config_line_removed: JSON.stringify(id),
    moved: steps,
    restore: `Move the files back and add "${id}" to stages["${stage}"].species in the config (species-add ${id} --stage ${stage}).`,
  });
  for (const st of steps) step(root, st);
  writeAtomic(configPath, out);
  return { id, stage: Number(stage), removed_dir: dir, moved: left, rewritten: mode };
}
