// Server mode (FR-16): the page talks to `pixelpipe serve` on the same origin. Relative URLs only (NFR-01).
import { parseGroupId } from '../core/naming.js';

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

import { askConfirm } from './dialogs.js';

export function initServerMode(ctx) {
  const { S, $, note } = ctx;
  const token = S.server.token;

  async function raw(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'X-PP-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data };
  }

  /** POST with the FR-16 confirm protocol: 409 → dialog → retry with yes. 412 is never retried. */
  async function post(url, body, okLabel) {
    let r = await raw('POST', url, body);
    if (r.status === 409) {
      if (!(await askConfirm($, r.data.confirm, okLabel))) { note('ok', 'Cancelled — nothing was changed.'); return null; }
      r = await raw('POST', url, { ...body, yes: true });
    }
    if (r.status === 412) { const e = new Error(`Files changed on disk: ${(r.data.conflict || []).join(', ')}.`); e.status = 412; e.conflict = r.data.conflict || []; throw e; }
    if (r.status !== 200) throw new Error(r.data.error || r.data.confirm || `HTTP ${r.status}`);
    return r.data;
  }
  async function get(url) {
    const r = await raw('GET', url);
    if (r.status !== 200) throw new Error((r.data && r.data.error) || `HTTP ${r.status}`);
    return r.data;
  }
  const fileBytes = (rel) => get(`/api/file?path=${encodeURIComponent(rel)}`);

  // ---- UI wiring
  document.body.classList.add('server-mode');
  $('modeLabel').textContent = `Workbench · ${S.server.root}`;
  const sel = $('groupSel');
  let groups = [];
  let speciesRemovable = [];

  async function refresh(selectId) {
    try {
      const st = await get('/api/state');
      groups = st.groups; speciesRemovable = st.species_removable || [];
      showRenamePending(st.rename_pending);
      sel.innerHTML = groups.length
        ? groups.map((g) => `<option value="${g.batch_id}">${g.batch_id} — raw ${g.raw_frames}, clean ${g.clean_frames}${g.exported ? ', exported' : ''}${g.validator.fails ? ` · ${g.validator.fails} FAIL` : ''}</option>`).join('')
        : '<option value="">No groups yet — add a unit first</option>';
      if (selectId) sel.value = selectId;
      else if (groups.some((g) => g.batch_id === targetId())) sel.value = targetId();
      updateStatus();
    } catch (e) { note('fail', 'Workbench: ' + e.message); }
  }
  function updateStatus() {
    const g = groups.find((x) => x.batch_id === sel.value);
    $('groupStatus').textContent = g ? `${g.validator.fails} FAIL · ${g.validator.warns} WARN` : '';
    for (const id of ['gPreview', 'gClean', 'gPromote', 'gRetranslate', 'gValidate', 'gExport']) $(id).disabled = !g || !!g.error;
    $('gRemoveGroup').disabled = !g; // also for a group that cannot be loaded (a half-done removal)
    updateTarget();
    loadDetail(g ? g.batch_id : null);
  }
  sel.onchange = updateStatus;

  // v3.4: where Add to group will write, and the group panel follows Species / Form
  const targetId = () => ctx.groupIdOf(S.meta);
  function updateTarget() {
    const id = targetId(), t = $('addTarget');
    t.hidden = false;
    t.textContent = groups.some((x) => x.batch_id === id) ? `→ adds to ${id}` : `→ creates ${id}`;
  }
  function followSpecies() {
    const id = targetId();
    if (groups.some((x) => x.batch_id === id) && sel.value !== id) { sel.value = id; updateStatus(); } else updateTarget();
  }

  // v3.4: per-group detail — "raw changed" resolutions and interrupted-command actions
  let detailSeq = 0;
  async function loadDetail(id) {
    const box = $('rawChanged'), seq = ++detailSeq;
    if (!id) { box.innerHTML = ''; return; }
    let d;
    try { d = await get(`/api/group/${encodeURIComponent(id)}`); } catch { return; }
    if (seq !== detailSeq) return;
    box.innerHTML = '';
    const row = (html, buttons) => {
      const div = document.createElement('div'); div.innerHTML = html;
      for (const [label, fn, primary] of buttons) { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = run(fn); div.append(b); }
      box.append(div);
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (d.pending) {
      const k = d.pending.kind;
      if (k === 'promote') row('<b>Interrupted promote.</b>', [['Finish promote', async () => { const r = await post('/api/promote', { batch_id: id }); if (r) note('ok', `${id}: promote finished.`); await afterGroupWrite(id); }, true]]);
      else if (k === 'retranslate') row('<b>Interrupted retranslate.</b>', [['Finish retranslate', () => doRetranslate(id), true]]);
      else if (k === 'unit-remove' && !d.pending.args) row('<b>Interrupted removal</b> (its marker is unreadable — check it by hand).', []);
      else if (k === 'unit-remove') row(`<b>Interrupted removal of unit ${esc(d.pending.args.unit)}.</b>`, [['Finish removal', async () => { const r = await post('/api/unit/remove', { batch_id: id, unit_id: d.pending.args.unit, edited: d.pending.args.edited, yes: true }); if (r) note('ok', `${id}: removal of unit "${d.pending.args.unit}" finished.`); await afterGroupWrite(id); }, true]]);
      else if (k === 'group-remove') row(`<b>Interrupted removal of ${esc(id)}.</b>`, [['Finish removal', async () => { const r = await post('/api/group/remove', { batch_id: id, yes: true }); if (r) note('ok', `Removed ${id}.`); await afterGroupRemoved(id); }, true]]);
      else row(`<b>Interrupted save.</b> Previous files: <code>${esc(d.pending.trash || '.trash')}</code>`, [['Restore previous state', async () => { const r = await post('/api/clean/restore', { batch_id: id }, 'Restore'); if (r) note('ok', `${id}: previous state restored.`); await afterGroupWrite(id); }, true]]);
    }
    // FR-22: the group's units, each with Edit unit / Remove
    const ul = $('unitList'); ul.innerHTML = '';
    for (const u of (d.batch && d.batch.units) || []) {
      const a = u.frame_start || 0, b = a + u.frames.length - 1;
      const range = a === b ? String(a).padStart(2, '0') : `${String(a).padStart(2, '0')}–${String(b).padStart(2, '0')}`;
      const used = u.strip && u.strip.use ? ` (frames ${u.strip.use.map((x) => x + 1).join(', ')} of ${u.strip.n})` : '';
      const div = document.createElement('div'); div.className = 'unit';
      div.innerHTML = `<b>${esc(u.id)}</b><span>${esc(u.anim)} ${range}${used}</span><span class="src" title="${esc(u.source)}">${esc(u.source_name || u.source.split('/').pop())}</span>`;
      const eb = document.createElement('button'); eb.className = 'btn'; eb.textContent = 'Edit unit';
      eb.onclick = run(async () => { await ctx.editUnit(d, u.id, fileBytes); note('ok', `Loaded unit ${u.id} of ${id} with its stored settings. Change what you need, then Add to group to replace it.`); });
      const rb = document.createElement('button'); rb.className = 'btn'; rb.textContent = 'Remove';
      rb.onclick = run(() => removeUnit(id, u.id));
      div.append(eb, rb); ul.append(div);
    }
    for (const rc of d.raw_changed || []) {
      row(`<span><b>${esc(rc.clean)}</b>: ${rc.recorded_null ? 'no recorded raw content' : 'raw changed'} (${esc(rc.raw_name)})</span>`, [
        ['Use new raw', async () => { const r = await post('/api/promote', { batch_id: id, force: rc.raw_name }, 'Replace'); if (r) note('ok', `${rc.clean} now matches the new raw; the old file is in .trash/.`); await afterGroupWrite(id); }],
        ['Keep my edits', async () => { const r = await post('/api/promote', { batch_id: id, accept_raw: rc.clean }); if (r) note('ok', `${rc.clean}: kept your pixels and recorded the new raw.`); await afterGroupWrite(id); }],
      ]);
    }
  }
  async function afterGroupWrite(id) { await refresh(id); await syncEditor(id); }

  // FR-19 / FR-20: removing work (wired at the end, after `run` exists)
  /** FR-19 from a row of the units list (FR-22). */
  async function removeUnit(id, unitId) {
    const d = await get(`/api/group/${encodeURIComponent(id)}`);
    const unit = d.batch.units.find((u) => u.id === unitId);
    if (!unit) throw new Error(`${id} has no unit ${unitId}`);
    const own = new Set(unit.frames.map((f) => f.name));
    const sha = Object.fromEntries(d.clean.map((c) => [c.name, c.sha256]));
    const rawSha = Object.fromEntries(d.raw.map((c) => [c.name, c.sha256]));
    const editedFrames = Object.entries((d.placement && d.placement.files) || {}).filter(([n, e]) => e.origin === 'raw' && own.has(e.raw_name) && sha[n] && sha[n] !== e.written_sha256 && !(!e.written_sha256 && sha[n] === rawSha[e.raw_name])).map(([n]) => n);
    let edited = 'keep';
    if (editedFrames.length) {
      edited = await ctx.choose(`You edited ${editedFrames.join(', ')}, which came from unit "${unitId}". Keep them as editor-made frames, or move them out too?`, [['keep', 'Keep my edited frames'], ['trash', 'Move them out too'], ['', 'Cancel']]);
      if (!edited) return;
    }
    if (ctx.editor.hasUnsaved(id) && !(await askConfirm($, `The Clean Editor has unsaved changes for ${id}. Removing the unit changes files on disk; your draft keeps its edits but frames of the removed unit are dropped from it (edited ones stay as editor-made frames), and saving will ask you to merge. Continue?`, 'Continue'))) return;
    const r = await post('/api/unit/remove', { batch_id: id, unit_id: unitId, edited }, 'Remove');
    if (!r) return;
    if (r.via_unit_remove) { note('ok', `Removed the whole group ${id} (it was its only unit). Files are in ${r.removed_dir}.`); await afterGroupRemoved(id); return; }
    note('ok', `Removed unit "${unitId}" from ${id}: ${r.moved.length} file(s) moved to ${r.removed_dir}${r.kept_as_editor.length ? `; kept as editor-made: ${r.kept_as_editor.join(', ')}` : ''}${Object.keys(r.renamed_clean).length ? `; clean frames renumbered: ${Object.entries(r.renamed_clean).map(([a, b]) => `${a} → ${b}`).join(', ')}` : ''}.${r.source_unused ? ` Its source ${r.source_unused} is no longer used.` : ''}`);
    if (ctx.editor.hasUnsaved(id)) ctx.editor.dropRawFrames(own, r.renamed_raw, r.renamed_clean);
    await refresh(id);
    if (r.retranslate_needed) {
      if (await askConfirm($, `Removing the unit moved the group. The remaining clean frames must be shifted to match. Retranslate now?`, 'Retranslate')) await doRetranslate(id);
      else note('warn', `${id}: clean frames are behind the new placement — use Retranslate before export.`);
    }
    if (r.name_taken.length) note('warn', `${id}: ${r.name_taken.join(', ')} could not be promoted because kept frames use those names. Move the kept frames in the Clean Editor, save, then Promote.`);
    await syncEditor(id);
  }
  function wireRemoval() {
  $('gRemoveGroup').onclick = run(async () => {
    const id = current();
    if (ctx.editor.hasUnsaved(id) && !(await askConfirm($, `The Clean Editor has unsaved changes for ${id}; they will be lost. Continue?`, 'Continue'))) return;
    const r = await post('/api/group/remove', { batch_id: id }, 'Remove group');
    if (!r) return;
    note('ok', `Removed ${id}: ${r.moved.length} file(s) moved to ${r.removed_dir}.`);
    await afterGroupRemoved(id);
  });
  }
  async function afterGroupRemoved(id) {
    if (ctx.editor.isOpen() && ctx.editor.E.batchId === id) { ctx.editor.close(); try { localStorage.removeItem(`pp-draft:${id}`); } catch { /* ignore */ } }
    await refresh();
  }

  // FR-26: ✎ Rename species… and Finish rename
  function showRenamePending(rp) {
    const box = $('renamePending');
    box.hidden = !rp; box.innerHTML = '';
    if (!rp) return;
    const div = document.createElement('div');
    div.innerHTML = `<span><b>Interrupted rename</b> ${String(rp.old).replace(/</g, '&lt;')} → ${String(rp.new).replace(/</g, '&lt;')}. Other changes are blocked until it is finished.</span>`;
    const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = 'Finish rename';
    b.onclick = run(async () => {
      const E = ctx.editor.E;
      if (ctx.editor.hasUnsaved() && E.batchId && parseGroupId(E.batchId)?.species === rp.old) { note('warn', `The Clean Editor has unsaved edits for ${E.batchId}: save or discard them first.`); return; }
      const r = await post('/api/species/rename', { old: rp.old, new: rp.new, yes: true }); if (r) { ctx.onRenamed(r); await refresh(); } });
    div.append(b); box.append(div);
  }
  async function renameSpecies() {
    const dlg = $('speciesRnDlg');
    const all = Object.values(ctx.cfg.stages).flatMap((s) => s.species);
    $('rnSpOld').innerHTML = all.map((sp) => `<option value="${sp}">${sp}</option>`).join('');
    $('rnSpOld').value = S.meta.species; $('rnSpNew').value = ''; $('rnSpErr').textContent = '';
    dlg.showModal();
    return new Promise((resolve) => {
      const done = (v) => { dlg.close(); $('rnSpOk').onclick = $('rnSpCancel').onclick = null; dlg.oncancel = null; resolve(v); };
      $('rnSpCancel').onclick = () => done(null);
      dlg.oncancel = (e) => { e.preventDefault(); done(null); };
      $('rnSpOk').onclick = async () => {
        const oldId = $('rnSpOld').value, newId = $('rnSpNew').value.trim();
        const E = ctx.editor.E;
        if (ctx.editor.hasUnsaved() && E.batchId && parseGroupId(E.batchId)?.species === oldId) { $('rnSpErr').textContent = `The Clean Editor has unsaved edits for ${E.batchId}: save or discard them first.`; return; }
        dlg.close(); // the confirm dialog is modal too
        try {
          const r = await post('/api/species/rename', { old: oldId, new: newId }, 'Rename');
          done(r);
        } catch (e) { dlg.showModal(); $('rnSpErr').textContent = e.message; refresh().catch(() => {}); }
      };
    });
  }

  // FR-21: − Remove species…
  async function removeSpecies() {
    if (!speciesRemovable.length) { note('warn', 'Every species still has groups. Remove its groups first (Remove group…).'); return null; }
    const dlg = $('speciesRmDlg');
    $('rmSpId').innerHTML = speciesRemovable.map((sp) => `<option value="${sp}">${sp}</option>`).join('');
    dlg.showModal();
    const id = await new Promise((resolve) => {
      const done = (v) => { dlg.close(); $('rmSpOk').onclick = $('rmSpCancel').onclick = null; dlg.oncancel = null; resolve(v); };
      $('rmSpCancel').onclick = () => done(null);
      dlg.oncancel = (e) => { e.preventDefault(); done(null); };
      $('rmSpOk').onclick = () => done($('rmSpId').value);
    });
    if (!id) return null;
    const r = await post('/api/species/remove', { id }, 'Remove species');
    if (r) await refresh();
    return r;
  }

  // FR-18: + New species…
  async function addSpecies() {
    const dlg = $('speciesDlg');
    $('newSpStage').innerHTML = Object.entries(ctx.cfg.stages).map(([n, s]) => `<option value="${n}">${n} ${s.name}</option>`).join('');
    $('newSpStage').value = String(S.meta.stage);
    $('newSpId').value = ''; $('newSpErr').textContent = '';
    dlg.showModal();
    return new Promise((resolve) => {
      const done = (v) => { dlg.close(); $('newSpOk').onclick = $('newSpCancel').onclick = null; dlg.oncancel = null; resolve(v); };
      $('newSpCancel').onclick = () => done(null);
      dlg.oncancel = (e) => { e.preventDefault(); done(null); };
      $('newSpOk').onclick = async () => {
        try {
          const r = await post('/api/species', { id: $('newSpId').value.trim(), stage: Number($('newSpStage').value) });
          if (r) done(r);
        } catch (e) { $('newSpErr').textContent = e.message; }
      };
    });
  }

  const run = (fn) => async () => { try { await fn(); } catch (e) { note('fail', e.message); } };
  const current = () => sel.value;

  $('addBtn').hidden = false;
  $('addBtn').onclick = run(async () => {
    if (S.srcSpecies && S.srcSpecies !== S.meta.species) {
      // the source was archived under another species: archive it again under the selected one
      const a = await api.archive(S.bytes, S.meta.species);
      S.srcSpecies = S.meta.species; S.fileName = a.name;
      note('ok', `Archived the source again for ${S.meta.species}: ${a.path}`);
    }
    const frag = ctx.buildFragment();
    if (S.editing && (S.editing.batchId !== frag.batch_id || S.editing.unitId !== frag.unit.id)) ctx.setEditing(null);
    if (ctx.editor.hasUnsaved(frag.batch_id) && !(await askConfirm($, `The Clean Editor has unsaved changes for ${frag.batch_id}. Adding this unit may update clean frames you edited there, and saving the draft would then be refused. Add anyway?`, 'Add anyway'))) return;
    const r = await post('/api/add', { fragment: frag }, 'Replace unit');
    if (!r) return;
    const id = r.report.batch_id;
    const copied = r.promote ? r.promote.copied.length : 0;
    S.lastSettings = ctx.settingsOf(frag.unit.params, `${id} · ${frag.unit.id}`);
    if (S.editing) { ctx.setEditing(null); try { ctx.nextFreeUnit((await get(`/api/group/${encodeURIComponent(frag.batch_id)}`)).batch.units); } catch { ctx.nextFreeUnit(); } }
    note('ok', `Added unit "${frag.unit.id}" to ${id}: ${r.report.files.length} raw frame(s), ${copied} promoted to clean.${r.promote && r.promote.name_taken.length ? ` Name taken: ${r.promote.name_taken.join(', ')}.` : ''}`);
    if (r.promote && r.promote.refreshed.length) note('ok', `Updated to the new raw (they had not been edited): ${r.promote.refreshed.join(', ')}. Old versions are in ${r.promote.trash || '.trash/'}.`);
    if (r.promote_error) note('warn', `Added, but promote failed: ${r.promote_error}`);
    await refresh(id);
    if (r.retranslate_needed) {
      if (await askConfirm($, `Adding this unit moved the whole group (new T ${JSON.stringify(r.report.T)}). The existing clean frames must be shifted to match. Retranslate now?`, 'Retranslate')) await doRetranslate(id);
      else note('warn', `${id}: clean frames are behind the new placement — use Retranslate before export.`);
    }
    if (ctx.editor.hasUnsaved(id)) note('warn', `${id}: the Clean Editor still shows your unsaved draft. Use Reload there to see the new frames (your draft would then be dropped), or Save first.`);
    else await openEditor(id, frag.unit.anim);
  });

  /** After a write to a group: refresh the editor's view of it, unless it holds unsaved edits. */
  async function syncEditor(id) {
    if (ctx.editor.isOpen() && ctx.editor.E.batchId === id && ctx.editor.E.server && !ctx.editor.hasUnsaved(id)) await ctx.editor.openServerGroup(api, id, { anim: ctx.editor.E.anim, quiet: true, keepView: true });
  }

  async function openEditor(id, anim = null, { quiet = false } = {}) {
    if (ctx.editor.hasUnsaved() && ctx.editor.E.batchId !== id && !(await askConfirm($, `Leave ${ctx.editor.E.batchId} with unsaved changes? They stay as a draft in this browser.`, 'Open other group'))) return;
    await ctx.editor.openServerGroup(api, id, { anim, quiet });
  }

  async function doRetranslate(id) {
    const r = await post('/api/retranslate', { batch_id: id }, 'Shift frames');
    if (!r) return;
    if (r.refused.length) for (const m of r.refused) note('fail', m);
    else note('ok', `Retranslated ${r.shifted.length} clean frame(s)${r.resumed ? ' (finished the interrupted run)' : ''}.`);
    await refresh(id);
    await syncEditor(id);
  }

  $('gPreview').onclick = run(async () => {
    const d = await get(`/api/group/${encodeURIComponent(current())}`);
    await ctx.applyGroup(d.batch, async (name) => d.sidecars[name], async (rel) => fileBytes(rel));
    note('ok', `Previewing ${current()} (${d.raw.length} raw frames). Load a source to add a unit next to it.`);
  });
  $('gClean').onclick = run(() => openEditor(current()));
  $('gPromote').onclick = run(async () => {
    const r = await post('/api/promote', { batch_id: current() });
    if (!r) return;
    note('ok', `Promoted ${r.copied.length} frame(s); ${r.skipped.length} already in clean${r.name_taken.length ? `; name taken: ${r.name_taken.join(', ')}` : ''}.`);
    await refresh(current());
    await syncEditor(current());
  });
  $('gRetranslate').onclick = run(() => doRetranslate(current()));
  $('gValidate').onclick = run(async () => {
    const v = await post('/api/validate', { batch_id: current() });
    if (!v) return;
    for (const w of v.warns.slice().reverse()) note('warn', w);
    for (const f of v.fails.slice().reverse()) note('fail', f);
    note(v.ok ? 'ok' : 'fail', `Validator ${current()}: ${v.fails.length} FAIL, ${v.warns.length} WARN${v.ok ? ' — ready to export' : ''}.`);
    await refresh(current());
  });
  $('gExport').onclick = run(async () => {
    const r = await post('/api/export', { batch_id: current() });
    if (!r) return;
    note('ok', `Exported ${current()} (${r.anchor} dither anchor): ${r.written.length} file(s) in art/export/${r.moved_stale && r.moved_stale.length ? `; ${r.moved_stale.length} old file(s) of this group moved to ${r.removed_dir}` : ''}.`);
    await refresh(current());
  });

  wireRemoval();
  refresh();

  const api = {
    get, post, fileBytes, openEditor, syncEditor, renameSpecies, groupIds: () => groups.map((g) => g.batch_id), followSpecies, updateTarget, addSpecies, removeSpecies,
    async archive(bytes, species) {
      const a = await post('/api/archive', { species, bytes_b64: b64(bytes) });
      return { ...a, name: a.path.split('/').pop(), bytes: await fileBytes(a.path) };
    },
    refresh,
  };
  return api;
}
