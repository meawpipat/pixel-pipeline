// FR-17 Clean Editor & animation timeline. State is an index array per frame, so no off-palette colour can exist.
import { normalizeToIndex } from '../core/normalize.js';
import { encodeCanonical } from '../core/pipeline.js';
import { validateGroup } from '../core/validate.js';
import { contentHash } from '../core/placement.js';
import { parseName, groupId, budgetWarnings } from '../core/naming.js';
import { hexToRgb, TRANSPARENT } from '../core/config.js';
import { sha256 } from '../core/sha256.js';

const HISTORY = 150;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sameI = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

export function initEditor(ctx) {
  const { cfg, $, S, note } = ctx;
  const W = cfg.canvas.w, H = cfg.canvas.h, N = W * H;
  const PAL = cfg.palette.map(hexToRgb);
  let uid = 0;
  const E = {
    open: false, server: false, batchId: null, species: null, stage: null, variant: null,
    batchT: null, rawContent: new Map(), rawNames: new Set(), tombstones: [], notes: new Map(),
    loaded: {}, loadedPlacementSha: null, pending: null,
    anims: new Map(), // anim → [frame]; frame = { key, from, I, origI, entry }
    anim: null, active: 0, color: 0, tool: 'pencil', zoom: 8, grid: true, box: true, onionPrev: false, onionNext: false, mirror: false,
    undo: [], redo: [], dirty: false, stroke: null, validation: { fails: [], warns: [], infos: [] },
  };

  // ------------------------------------------------------------ model helpers
  const framesOf = (a = E.anim) => E.anims.get(a) || [];
  const cur = () => framesOf()[E.active] || null;
  const nameOf = (a, i) => `${E.batchId}_${a}_${String(i).padStart(2, '0')}.png`;
  const finalFrames = () => {
    const out = [];
    for (const [a, list] of [...E.anims.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) list.forEach((f, i) => out.push({ name: nameOf(a, i), anim: a, f }));
    return out;
  };
  const budget = () => (cfg.animations[String(E.stage)] || {})[E.variant] || {};
  const edited = (f) => !f.from || !sameI(f.I, f.origI);

  function snapshot() {
    return { anims: [...E.anims.entries()].map(([a, l]) => [a, l.map((f) => ({ ...f, I: f.I.slice(), entry: { ...f.entry } }))]), anim: E.anim, active: E.active };
  }
  function restore(s) { E.anims = new Map(s.anims.map(([a, l]) => [a, l.map((f) => ({ ...f, I: f.I.slice(), entry: { ...f.entry } }))])); E.anim = s.anim; E.active = s.active; }
  function pushUndo() { E.undo.push(snapshot()); if (E.undo.length > HISTORY) E.undo.shift(); E.redo.length = 0; }
  function changed() { E.dirty = true; saveDraft(); refresh(); }
  function undo() { if (!E.undo.length) return; E.redo.push(snapshot()); restore(E.undo.pop()); changed(); }
  function redo() { if (!E.redo.length) return; E.undo.push(snapshot()); restore(E.redo.pop()); changed(); }

  // ------------------------------------------------------------ opening
  function reset(meta) {
    Object.assign(E, { open: true, anims: new Map(), anim: null, active: 0, undo: [], redo: [], dirty: false, tombstones: [], origRaw: new Set(), notes: new Map(), rawContent: new Map(), rawNames: new Set(), pending: null, loaded: {}, loadedPlacementSha: null }, meta);
    S.meta.species = E.species; S.meta.stage = E.stage; S.meta.variant = E.variant;
    $('species').value = `${E.species}|${E.stage}`; $('variant').value = E.variant;
  }
  function addFrame(anim, f) { if (!E.anims.has(anim)) E.anims.set(anim, []); E.anims.get(anim).push({ key: ++uid, ...f }); }
  function pickAnim(prefer) {
    const names = [...E.anims.keys()];
    E.anim = prefer && (E.anims.has(prefer) || budget()[prefer]) ? prefer : names.includes('idle') ? 'idle' : names[0] || Object.keys(budget())[0] || 'idle';
    E.active = 0;
  }

  /** Server mode: load the group's clean frames, placement and raw content from serve. */
  async function openServerGroup(srv, batchId, { anim = null, quiet = false, keepView = false } = {}) {
    const d = await srv.get(`/api/group/${encodeURIComponent(batchId)}`);
    const b = d.batch;
    reset({ server: true, batchId, species: b.species, stage: b.stage, variant: b.variant, batchT: b.T, tombstones: (d.placement && d.placement.tombstones) || [], loadedPlacementSha: d.placement_sha256, pending: d.pending || null, rawNames: new Set(d.raw.map((r) => r.name)) });
    for (const r of d.raw) {
      try { const x = normalizeToIndex(await srv.fileBytes(`art/raw/${b.species}/${r.name}`), cfg); E.rawContent.set(r.name, contentHash(x.I, W, H)); } catch { /* the Validator reports it */ }
    }
    const claimed = new Set(Object.values((d.placement && d.placement.files) || {}).filter((e) => e.origin === 'raw').map((e) => e.raw_name));
    E.origRaw = claimed;
    const problems = [];
    const badNames = [];
    for (const c of d.clean) {
      const p = parseName(c.name);
      if (!p) { badNames.push(c.name); continue; } // left alone by clean-save; the Validator FAILs it
      E.loaded[c.name] = c.sha256;
      let I;
      try { I = normalizeToIndex(await srv.fileBytes(`art/clean/${b.species}/${c.name}`), cfg).I; } catch (e) { problems.push(`${c.name}: ${e.message}`); continue; }
      let entry = d.placement && d.placement.files[c.name];
      if (!entry) entry = E.rawNames.has(c.name) && !claimed.has(c.name) ? { T: b.T, origin: 'raw', raw_name: c.name, raw_content_sha256: null } : { T: b.T, origin: 'editor', raw_name: null, raw_content_sha256: null };
      addFrame(p.anim, { from: c.name, I, origI: I.slice(), entry: { ...entry } });
      if (d.notes && d.notes[c.name]) E.notes.set(c.name, d.notes[c.name]);
    }
    for (const l of E.anims.values()) l.sort((x, y) => (x.from < y.from ? -1 : 1));
    pickAnim(anim);
    if (problems.length) { E.blocked = `Cannot edit ${batchId}: ${problems.join('; ')} — run pixelpipe normalize on these files first.`; } else E.blocked = null;
    if (badNames.length) note('warn', `${batchId}: ${badNames.join(', ')} ${badNames.length > 1 ? 'are' : 'is'} not a valid frame name ({group}_{anim}_{NN}.png) and is not shown; rename or remove it by hand.`);
    if (!quiet) await offerDraft();
    if (keepView && !isShown()) refresh(); else show();
    return E;
  }

  /** File mode: dropped clean PNGs open as an unsaved sandbox. */
  function openFiles(list) {
    const parsed = [];
    for (const { name, bytes } of list) {
      const p = parseName(name);
      if (!p) continue;
      let I;
      try { I = normalizeToIndex(bytes, cfg).I; } catch (e) { throw new Error(`${name}: ${e.message} — only canonical or exactly normalizable PNGs can be opened (no nearest-colour guessing)`); }
      parsed.push({ name, p, I });
    }
    if (!parsed.length) throw new Error('no PNG named {species}_s{stage}[-fat]_{anim}_{NN}.png was found');
    parsed.sort((a, b) => (a.name < b.name ? -1 : 1));
    const f0 = parsed[0].p;
    const id = groupId(f0.species, f0.stage, f0.variant);
    reset({ server: false, batchId: id, species: f0.species, stage: f0.stage, variant: f0.variant, batchT: null });
    for (const x of parsed) if (groupId(x.p.species, x.p.stage, x.p.variant) === id) { E.loaded[x.name] = sha256(bytes0(list, x.name)); addFrame(x.p.anim, { from: x.name, I: x.I, origI: x.I.slice(), entry: { T: null, origin: 'editor', raw_name: null, raw_content_sha256: null } }); }
    pickAnim(S.meta.anim);
    E.blocked = null;
    show();
    return E;
  }
  const bytes0 = (list, n) => list.find((x) => x.name === n).bytes;

  // ------------------------------------------------------------ drafts (browser storage: a per-viewer convenience only)
  const draftKey = () => `pp-draft:${E.batchId}`;
  let draftTimer = 0;
  function saveDraft() {
    if (!E.server) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey(), JSON.stringify({ at: new Date().toISOString(), loaded: E.loaded, loadedPlacementSha: E.loadedPlacementSha, anims: [...E.anims.entries()].map(([a, l]) => [a, l.map((f) => ({ from: f.from, I: b64(f.I), entry: f.entry }))]) }));
      } catch { /* storage unavailable: no draft */ }
    }, 300);
  }
  function dropDraft() { try { localStorage.removeItem(draftKey()); } catch { /* ignore */ } }
  async function offerDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { d = null; }
    if (!d) return;
    if (!(await ctx.confirm(`There are unsaved changes for ${E.batchId} from ${new Date(d.at).toLocaleString()}. Restore them?`, 'Restore draft'))) { dropDraft(); return; }
    const orig = new Map(); for (const l of E.anims.values()) for (const f of l) orig.set(f.from, f.origI);
    E.anims = new Map();
    const okI = (I) => I.length === N && I.every((v) => v <= TRANSPARENT);
    if (!d.anims.every(([, l]) => l.every((f) => okI(unb64(f.I))))) { dropDraft(); note('warn', 'The saved draft was unreadable and was discarded.'); return; }
    for (const [a, l] of d.anims) for (const f of l) addFrame(a, { from: f.from, I: unb64(f.I), origI: f.from ? (orig.get(f.from) || null) : null, entry: f.entry });
    E.loaded = d.loaded; E.loadedPlacementSha = d.loadedPlacementSha; E.dirty = true;
    pickAnim(E.anim);
  }
  window.addEventListener('beforeunload', (e) => { if (E.open && E.dirty && E.server) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------ live validation
  function validate() {
    const files = [], placement = { schema: 2, files: {}, tombstones: E.tombstones.slice() }, notes = new Map();
    const usedRaw = new Set();
    for (const { name, f } of finalFrames()) {
      files.push({ name, bytes: encodeCanonical({ w: W, h: H, I: f.I }, cfg) });
      placement.files[name] = f.entry;
      if (f.entry.raw_name) usedRaw.add(f.entry.raw_name);
      if (f.from && E.notes.has(f.from)) notes.set(name, E.notes.get(f.from));
    }
    if (!E.server) {
      const v = validateGroup({ mode: 'raw', batchId: E.batchId, files, batch: { stage: E.stage, variant: E.variant }, cfg });
      v.warns = v.warns.filter((w) => !/budgeted anim/.test(w));
      v.infos.push('File mode: rules that need the batch file (T, placement, budget completeness) are skipped. Start pixelpipe serve to save.');
      return v;
    }
    for (const rn of E.origRaw) if (!usedRaw.has(rn) && !placement.tombstones.some((t) => t.raw_name === rn)) placement.tombstones.push({ raw_name: rn, at: 'on save' });
    return validateGroup({ mode: 'clean', batchId: E.batchId, files, batch: { stage: E.stage, variant: E.variant, T: E.batchT }, placement, rawContent: E.rawContent, marker: E.pending && E.pending.kind === 'clean-save' ? E.pending : false, promoteMarker: !!E.pending && E.pending.kind === 'promote', retranslateMarker: !!E.pending && E.pending.kind === 'retranslate', notes, cfg });
  }

  // ------------------------------------------------------------ saving
  function payload() {
    return {
      frames: finalFrames().map(({ name, f }) => ({ name, from: f.from, I_b64: b64(f.I), entry: f.entry })),
      loaded: E.loaded, loaded_placement_sha256: E.loadedPlacementSha,
    };
  }
  async function save(srv) {
    if (!E.server) throw new Error('Start pixelpipe serve to save (this is an unsaved sandbox).');
    if (E.blocked) throw new Error(E.blocked);
    let r;
    E.saving = true; document.body.classList.add('saving');
    try { r = await srv.post('/api/clean/save', { batch_id: E.batchId, payload: payload() }, 'Save and remove'); }
    catch (e) { if (e.status === 412) return conflict(srv, e.conflict || []); throw e; }
    finally { E.saving = false; document.body.classList.remove('saving'); }
    if (!r) return null;
    dropDraft();
    const keep = E.active;
    await openServerGroup(srv, E.batchId, { anim: E.anim, quiet: true });
    E.active = Math.min(keep, Math.max(0, framesOf().length - 1));
    await ctx.refreshGroups(E.batchId);
    if (r.unchanged) note('ok', `${E.batchId}: nothing changed — nothing was written.`);
    else note(r.validator.ok ? 'ok' : 'warn', `Saved ${E.batchId}: ${r.written.length} file(s) written${r.trashed.length ? `, ${r.trashed.length} moved to ${r.trash}` : ''}${r.tombstoned.length ? `, removed raw frame(s) ${r.tombstoned.join(', ')}` : ''}. Validator: ${r.validator.fails.length} FAIL, ${r.validator.warns.length} WARN.`);
    refresh();
    return r;
  }
  async function conflict(srv, files) {
    const choice = await ctx.choose(`Files changed on disk since you opened ${E.batchId}: ${files.join(', ')}. Nothing was saved.`, [
      ['merge', 'Reload the files I did not edit'], ['reload', 'Reload everything from disk'], ['keep', 'Keep my draft'],
    ]);
    if (choice === 'reload') { dropDraft(); await openServerGroup(srv, E.batchId, { anim: E.anim, quiet: true }); note('ok', `Reloaded ${E.batchId} from disk; your changes were discarded.`); }
    else if (choice === 'merge') await merge(srv);
    else note('warn', `${E.batchId}: kept your draft. Saving will be refused until the files on disk match what you loaded.`);
  }
  /** Keep edited frames (refused if one of them changed on disk), take disk versions of the rest. */
  async function merge(srv) {
    const draft = snapshot(), loadedBefore = { ...E.loaded };
    const editedFroms = new Map();
    for (const [, l] of draft.anims) for (const f of l) if (f.from && !sameI(f.I, f.origI)) editedFroms.set(f.from, f);
    await openServerGroup(srv, E.batchId, { anim: E.anim, quiet: true });
    const bad = [...editedFroms.keys()].filter((n) => E.loaded[n] !== loadedBefore[n]);
    if (bad.length) { restore(draft); E.loaded = loadedBefore; E.dirty = true; note('fail', `Cannot merge: you edited ${bad.join(', ')}, and that file also changed on disk. Reload everything, or keep your draft and copy your changes by hand.`); return refresh(); }
    const disk = new Map(); for (const l of E.anims.values()) for (const f of l) disk.set(f.from, f);
    const used = new Set();
    E.anims = new Map();
    for (const [a, l] of draft.anims) for (const f of l) {
      if (!f.from) { addFrame(a, f); continue; }
      const dk = disk.get(f.from);
      if (!dk) continue; // deleted on disk meanwhile and not edited here
      used.add(f.from);
      addFrame(a, editedFroms.has(f.from) ? { ...f, origI: dk.origI, entry: { ...dk.entry } } : dk); // my pixels, the disk's entry
    }
    for (const [from, f] of disk) if (!used.has(from) && !Object.prototype.hasOwnProperty.call(loadedBefore, from)) addFrame(parseName(from).anim, f); // new on disk
    for (const l of E.anims.values()) l.forEach((f) => { f.key = ++uid; });
    E.dirty = true; pickAnim(draft.anim); saveDraft();
    note('ok', `Merged: your edited frames are kept, the rest now match the disk. Review, then Save.`);
    refresh();
  }

  async function restorePrevious(srv) {
    const r = await srv.post('/api/clean/restore', { batch_id: E.batchId }, 'Restore');
    if (!r) return;
    note('ok', r.completed_save ? `${E.batchId}: the interrupted save had actually completed; the marker was removed.` : `${E.batchId}: restored ${r.restored.length} file(s) from .trash and removed ${r.removed.length} partial file(s).`);
    dropDraft();
    await openServerGroup(srv, E.batchId, { anim: E.anim, quiet: true });
    await ctx.refreshGroups(E.batchId);
  }

  // ------------------------------------------------------------ frame operations (timeline)
  function op(fn) { const f = cur(); if (!f || E.saving) return; pushUndo(); fn(f); changed(); }
  const blankI = () => new Uint8Array(N).fill(TRANSPARENT);
  const T0 = () => (E.batchT ? E.batchT.slice() : null);
  const ops = {
    duplicate: () => op((f) => { framesOf().splice(E.active + 1, 0, { key: ++uid, from: null, I: f.I.slice(), origI: null, entry: { T: f.entry.T ? f.entry.T.slice() : null, origin: 'editor', raw_name: null, raw_content_sha256: null } }); E.active++; }),
    blank: () => { if (E.saving) return; pushUndo(); if (!E.anims.has(E.anim)) E.anims.set(E.anim, []); const f = cur(); framesOf().splice(f ? E.active + 1 : 0, 0, { key: ++uid, from: null, I: blankI(), origI: null, entry: { T: f && f.entry.T ? f.entry.T.slice() : T0(), origin: 'editor', raw_name: null, raw_content_sha256: null } }); if (f) E.active++; changed(); },
    remove: () => op(() => { framesOf().splice(E.active, 1); E.active = Math.max(0, Math.min(E.active, framesOf().length - 1)); }),
    left: () => { if (E.active === 0) return; op(() => { const l = framesOf(); [l[E.active - 1], l[E.active]] = [l[E.active], l[E.active - 1]]; E.active--; }); },
    right: () => { if (E.active >= framesOf().length - 1) return; op(() => { const l = framesOf(); [l[E.active + 1], l[E.active]] = [l[E.active], l[E.active + 1]]; E.active++; }); },
    flip: () => op((f) => { const o = new Uint8Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = f.I[y * W + (W - 1 - x)]; f.I = o; }),
  };
  /** FR-25: copy the active frame to the start (frame 00) of one or all other animations — one undo step. */
  async function copyToAnimation(target = null) {
    const f = cur(); if (!f || E.saving) return;
    const others = [...new Set([...Object.keys(budget()), ...E.anims.keys()])].filter((a) => a !== E.anim);
    if (!others.length) { note('warn', 'There is no other animation in this group\'s budget.'); return; }
    const pick = target || await ctx.choose(`Copy ${nameOf(E.anim, E.active)} to the start (frame 00) of:`, [...others.map((a) => [a, a]), ['__all', 'All other animations'], ['', 'Cancel']]);
    if (!pick) return;
    const targets = pick === '__all' ? others : [pick];
    const fresh = targets.filter((a) => !framesOf(a).length);
    pushUndo();
    for (const a of targets) {
      if (!E.anims.has(a)) E.anims.set(a, []);
      E.anims.get(a).unshift({ key: ++uid, from: null, I: f.I.slice(), origI: null, entry: { T: f.entry.T ? f.entry.T.slice() : null, origin: 'editor', raw_name: null, raw_content_sha256: null } });
    }
    changed();
    if (fresh.length) note('warn', `${fresh.join(', ')} had no frames yet: a raw unit added later for ${fresh.length > 1 ? 'them' : 'it'} should use First frame 1, because frame 00 is now this copy.`);
    note('ok', `Copied ${nameOf(E.anim, E.active)} to the start of ${targets.join(', ')}. Their other frames moved up by one; Save writes it (Undo reverts).`);
  }
  function shift(dx, dy, all) {
    const list = all ? framesOf() : [cur()].filter(Boolean);
    const out = [];
    for (const f of list) {
      const o = blankI();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = f.I[y * W + x]; if (v === TRANSPARENT) continue;
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) { note('warn', 'Shift refused: opaque pixels would leave the canvas.'); return; }
        o[Y * W + X] = v;
      }
      out.push([f, o]);
    }
    if (!out.length || E.saving) return;
    pushUndo(); for (const [f, o] of out) f.I = o; changed();
  }

  // ------------------------------------------------------------ drawing
  function paint(f, x, y, v) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    f.I[y * W + x] = v;
    if (E.mirror) f.I[y * W + (W - 1 - x)] = v;
  }
  function line(f, x0, y0, x1, y1, v) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) { paint(f, x0, y0, v); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
  }
  function fill(f, x, y, v) {
    const t = f.I[y * W + x]; if (t === v) return;
    const st = [[x, y]];
    while (st.length) {
      const [cx, cy] = st.pop();
      if (cx < 0 || cy < 0 || cx >= W || cy >= H || f.I[cy * W + cx] !== t) continue;
      f.I[cy * W + cx] = v;
      st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }
  const pix = (ev) => { const c = $('edCanvas'), b = c.getBoundingClientRect(); return [Math.floor(((ev.clientX - b.left) / b.width) * W), Math.floor(((ev.clientY - b.top) / b.height) * H)]; };
  function onDown(ev) {
    const f = cur(); if (!f || E.blocked || E.saving) return;
    const [x, y] = pix(ev);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (E.tool === 'pick') { const v = f.I[y * W + x]; setColor(v); setTool('pencil'); return; }
    pushUndo();
    if (E.tool === 'fill') { fill(f, x, y, E.color); changed(); return; }
    const v = E.tool === 'eraser' ? TRANSPARENT : E.color;
    paint(f, x, y, v); E.stroke = { x, y, v };
    $('edCanvas').setPointerCapture(ev.pointerId);
    draw();
  }
  function onMove(ev) {
    const [x, y] = pix(ev);
    $('edPos').textContent = x >= 0 && y >= 0 && x < W && y < H ? `${x}, ${y}` : '';
    if (!E.stroke) return;
    const f = cur(); if (!f) return;
    line(f, E.stroke.x, E.stroke.y, Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y)), E.stroke.v);
    E.stroke.x = x; E.stroke.y = y;
    draw();
  }
  function onUp() { if (E.stroke) { E.stroke = null; changed(); } }

  function draw() {
    const c = $('edCanvas'), Z = E.zoom, dpr = window.devicePixelRatio || 1;
    c.width = W * Z * dpr; c.height = H * Z * dpr; c.style.width = `${W * Z}px`; c.style.height = `${H * Z}px`;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { g.fillStyle = ((x + y) / 2) & 1 ? '#e4e4df' : '#cfcfca'; g.fillRect(x * Z, y * Z, 2 * Z, 2 * Z); }
    const l = framesOf(), f = cur();
    const layer = (I, alpha) => { g.globalAlpha = alpha; for (let i = 0; i < N; i++) { const v = I[i]; if (v === TRANSPARENT) continue; g.fillStyle = `rgb(${PAL[v].join(',')})`; g.fillRect((i % W) * Z, ((i / W) | 0) * Z, Z, Z); } g.globalAlpha = 1; };
    if (E.onionPrev && E.active > 0) layer(l[E.active - 1].I, 0.3);
    if (E.onionNext && E.active < l.length - 1) layer(l[E.active + 1].I, 0.3);
    if (f) layer(f.I, 1);
    if (E.grid && Z >= 6) {
      g.strokeStyle = 'rgba(0,0,0,.12)'; g.lineWidth = 1; g.beginPath();
      for (let i = 1; i < W; i++) { g.moveTo(i * Z + 0.5, 0); g.lineTo(i * Z + 0.5, H * Z); }
      for (let i = 1; i < H; i++) { g.moveTo(0, i * Z + 0.5); g.lineTo(W * Z, i * Z + 0.5); }
      g.stroke();
    }
    if (E.box && E.stage != null) {
      const box = cfg.stages[String(E.stage)].box, bx = Math.floor((W - box[0]) / 2), by = cfg.baseline_y - box[1] + 1;
      g.strokeStyle = '#ff00ff'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.strokeRect(bx * Z, by * Z, box[0] * Z, box[1] * Z); g.setLineDash([]);
      g.beginPath(); g.moveTo(0, (cfg.baseline_y + 1) * Z); g.lineTo(W * Z, (cfg.baseline_y + 1) * Z); g.stroke();
    }
  }

  function thumbs() {
    const box = $('edFrames'); box.innerHTML = '';
    framesOf().forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'thumb'; b.setAttribute('aria-pressed', String(i === E.active)); b.title = `${nameOf(E.anim, i)}${f.from && f.from !== nameOf(E.anim, i) ? ` (was ${f.from})` : ''}${f.from ? '' : ' (new)'}${edited(f) ? ' · edited' : ''}`;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const id = cv.getContext('2d').createImageData(W, H);
      for (let k = 0; k < N; k++) { const v = f.I[k]; const c = v === TRANSPARENT ? [0, 0, 0, 0] : [...PAL[v], 255]; id.data.set(c, k * 4); }
      cv.getContext('2d').putImageData(id, 0, 0);
      const cap = document.createElement('span'); cap.textContent = `${String(i).padStart(2, '0')}${edited(f) ? ' •' : ''}`;
      b.append(cv, cap);
      b.onclick = () => { E.active = i; S.frame = i; refresh(); };
      box.append(b);
    });
    if (!framesOf().length) box.innerHTML = '<span class="hint">No frames in this animation — Add blank, or pick another animation.</span>';
  }
  function animSelect() {
    const b = budget(), names = [...new Set([...Object.keys(b), ...E.anims.keys()])];
    $('edAnim').innerHTML = names.map((a) => { const n = framesOf(a).length, bb = b[a]; return `<option value="${a}">${a} ${n}/${bb ? (bb[0] === bb[1] ? bb[0] : bb[0] + '–' + bb[1]) : '—'}${bb ? '' : ' (not in budget)'}</option>`; }).join('');
    $('edAnim').value = E.anim;
  }

  // ------------------------------------------------------------ UI state
  function setTool(t) { E.tool = t; for (const [id, k] of [['edPencil', 'pencil'], ['edEraser', 'eraser'], ['edFill', 'fill'], ['edPick', 'pick']]) $(id).setAttribute('aria-pressed', String(k === t)); }
  function setColor(v) { if (v === TRANSPARENT) { setTool('eraser'); return; } E.color = v; document.querySelectorAll('#edPalette .sw').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === v))); if (E.tool === 'eraser') setTool('pencil'); }
  function refresh() {
    if (!E.open) return;
    E.validation = validate();
    animSelect(); thumbs(); draw();
    $('edUndo').disabled = !E.undo.length; $('edRedo').disabled = !E.redo.length;
    $('edGroup').textContent = `${E.batchId}${E.server ? '' : ' (sandbox)'}${E.dirty ? ' — unsaved changes' : ''}`;
    $('edSave').disabled = !E.server || !!E.blocked || !!E.pending || !E.dirty;
    $('edSaveHint').textContent = !E.server ? 'Start pixelpipe serve to save. This is an unsaved sandbox.' : E.pending ? '' : E.dirty ? 'Changes are kept as a draft in this browser until you save.' : '';
    const behind = E.server && finalFrames().some(({ f }) => f.entry.T && E.batchT && (f.entry.T[0] !== E.batchT[0] || f.entry.T[1] !== E.batchT[1]));
    const banner = $('edBanner');
    if (E.pending && E.pending.kind === 'clean-save') { banner.hidden = false; banner.innerHTML = `A save was interrupted. The previous files are in <code>art/clean/${esc(E.species)}/${esc(E.pending.trash || '.trash')}</code>. <button class="btn" id="edRestore">Restore previous state</button>`; $('edRestore').onclick = () => ctx.run(() => restorePrevious(ctx.srv())); }
    else if (E.pending) { banner.hidden = false; banner.textContent = `An interrupted ${E.pending.kind} must be finished first: use Finish ${E.pending.kind} in the Group panel, then Reload here.`; }
    else if (E.blocked) { banner.hidden = false; banner.textContent = E.blocked; }
    else if (behind) { banner.hidden = false; banner.textContent = 'Some frames are placed with an older T than the batch. You can keep editing and saving; run Retranslate in the Group panel before export.'; }
    else banner.hidden = true;
    S.frame = Math.min(E.active, Math.max(0, framesOf().length - 1));
    ctx.renderAll();
  }
  function show() { document.body.classList.add('editor-mode'); $('viewConv').setAttribute('aria-pressed', 'false'); $('viewEdit').setAttribute('aria-pressed', 'true'); refresh(); }
  function hide() { document.body.classList.remove('editor-mode'); $('viewConv').setAttribute('aria-pressed', 'true'); $('viewEdit').setAttribute('aria-pressed', 'false'); ctx.renderAll(); }
  const isShown = () => document.body.classList.contains('editor-mode');

  // ------------------------------------------------------------ wiring
  $('edPalette').innerHTML = [0, 1, 2, 3].map((v) => `<button class="btn sw" data-v="${v}" aria-pressed="${v === 0}" title="${['Black', 'Dark grey', 'Light grey', 'White'][v]} (${v + 1})" style="background:rgb(${PAL[v].join(',')})"></button>`).join('') + '<button class="btn sw clear" data-v="4" title="Transparent = eraser (5)"></button>';
  document.querySelectorAll('#edPalette .sw').forEach((b) => { b.onclick = () => setColor(+b.dataset.v); });
  $('edPencil').onclick = () => setTool('pencil'); $('edEraser').onclick = () => setTool('eraser'); $('edFill').onclick = () => setTool('fill'); $('edPick').onclick = () => setTool('pick');
  $('edMirror').onchange = (e) => { E.mirror = e.target.checked; };
  $('edFlip').onclick = ops.flip;
  $('edUndo').onclick = undo; $('edRedo').onclick = redo;
  $('edZoom').oninput = (e) => { E.zoom = +e.target.value; $('edZoomOut').textContent = `${E.zoom}×`; draw(); };
  $('edGrid').onchange = (e) => { E.grid = e.target.checked; draw(); };
  $('edBox').onchange = (e) => { E.box = e.target.checked; draw(); };
  $('edOnionPrev').onchange = (e) => { E.onionPrev = e.target.checked; draw(); };
  $('edOnionNext').onchange = (e) => { E.onionNext = e.target.checked; draw(); };
  $('edAnim').onchange = (e) => { E.anim = e.target.value; E.active = 0; S.meta.anim = E.anim; refresh(); };
  $('edDup').onclick = ops.duplicate;
  $('edCopyTo').onclick = () => ctx.run(() => copyToAnimation()); $('edBlank').onclick = ops.blank; $('edDel').onclick = ops.remove; $('edLeft').onclick = ops.left; $('edRight').onclick = ops.right;
  for (const [id, d] of [['edUp', [0, -1]], ['edDown', [0, 1]], ['edL1', [-1, 0]], ['edR1', [1, 0]]]) $(id).onclick = (e) => shift(d[0], d[1], e.shiftKey);
  const cv = $('edCanvas');
  cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', (e) => {
    if (!E.open || !isShown() || E.saving) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || document.querySelector('dialog[open]')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); $('edSave').click(); return; }
    if (mod) return;
    const map = { b: () => setTool('pencil'), e: () => setTool('eraser'), g: () => setTool('fill'), i: () => setTool('pick'), 1: () => setColor(0), 2: () => setColor(1), 3: () => setColor(2), 4: () => setColor(3), 5: () => setColor(4) };
    if (map[k]) { map[k](); e.preventDefault(); return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[k]) { e.preventDefault(); shift(arrows[k][0], arrows[k][1], e.shiftKey); }
  });
  $('edZoomOut').textContent = `${E.zoom}×`;

  /** After unit-remove with an unsaved draft: drop frames of the removed raw frames (edited ones become editor-made), apply renames. */
  function dropRawFrames(removedRaw, renames, cleanRenames = {}) {
    for (const [a, l] of E.anims) {
      E.anims.set(a, l.filter((f) => {
        if (f.entry.raw_name && removedRaw.has(f.entry.raw_name)) {
          if (!edited(f)) return false;
          f.entry = { T: f.entry.T, origin: 'editor', raw_name: null, raw_content_sha256: null, written_sha256: null };
        } else if (f.entry.raw_name && renames[f.entry.raw_name]) f.entry = { ...f.entry, raw_name: renames[f.entry.raw_name] };
        if (f.from && cleanRenames[f.from]) f.from = cleanRenames[f.from]; // the file was renamed on disk (same bytes)
        return true;
      }));
    }
    E.loaded = Object.fromEntries(Object.entries(E.loaded).map(([k, v]) => [cleanRenames[k] || k, v]));
    E.origRaw = new Set([...E.origRaw].filter((r) => !removedRaw.has(r)).map((r) => renames[r] || r));
    E.rawNames = new Set([...E.rawNames].filter((r) => !removedRaw.has(r)).map((r) => renames[r] || r));
    E.active = Math.min(E.active, Math.max(0, framesOf().length - 1));
    E.dirty = true; saveDraft(); refresh();
  }
  function close() { E.open = false; E.dirty = false; E.anims = new Map(); hide(); }

  return {
    E, openServerGroup, dropRawFrames, close, copyToAnimation, openFiles, save, show, hide, isShown, refresh, undo, redo, ops, shift, setTool, setColor,
    isOpen: () => E.open,
    hasUnsaved: (batchId) => E.open && E.dirty && (!batchId || E.batchId === batchId),
    outputs: () => framesOf().map((f, i) => ({ name: nameOf(E.anim, i), canvas: { w: W, h: H, I: f.I } })),
    messages: () => [...E.validation.fails.map((t) => ['fail', t]), ...E.validation.warns.map((t) => ['warn', t]), ...E.validation.infos.map((t) => ['ok', t])],
    budgetLine: () => budgetWarnings(cfg, E.stage, E.variant, Object.fromEntries([...E.anims.entries()].map(([a, l]) => [a, l.map((_, i) => i)]))),
  };
}
