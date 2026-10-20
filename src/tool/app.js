// Browser tool (FR-10, NFR-01): parameter picker + live preview. Exports a fragment, never PNGs.
import { decodeImage } from '../core/image.js';
import { sha256 } from '../core/sha256.js';
import { hexToRgb, TRANSPARENT } from '../core/config.js';
import { processUnit, placeUnits, TOOL_VERSION, PARAM_KEYS } from '../core/pipeline.js';
import { histogram } from '../core/quantize.js';
import { defaultDividers } from '../core/frame.js';
import { groupId, parseGroupId, parseName, checkMembership, budgetWarnings } from '../core/naming.js';
import { initServerMode } from './serverui.js';
import { initEditor } from './editor.js';
import { askConfirm, choose } from './dialogs.js';
import { composeScreenFine } from '../core/dither.js';
import { pixelHash, checkConfig } from '../core/config.js';
import { encodeCanonical } from '../core/pipeline.js';
import { validateGroup } from '../core/validate.js';

// server mode: the config the server reads now is authoritative (FR-18); file mode: the config inlined at build time
const cfg = checkConfig((window.PP_SERVER && window.PP_SERVER.config) || window.PP_CONFIG);
const $ = (id) => document.getElementById(id);
const PAL = cfg.palette.map(hexToRgb);
/** NFR-08: no hard-coded species — the first species of the lowest stage that has one (none: empty, stage 0). */
function firstSpecies() {
  const e = Object.entries(cfg.stages).sort((a, b) => Number(a[0]) - Number(b[0])).find(([, s]) => s.species.length);
  return e ? { species: e[1].species[0], stage: Number(e[0]) } : { species: '', stage: Number(Object.keys(cfg.stages).sort()[0] || 0) };
}
const EXAMPLE_HINT = 'this page was built from the example config — run `pixelpipe page` in your project for a page with your species';

const S = {
  img: null, bytes: null, fileName: '', sha: '', cache: new Map(),
  params: { roi: null, key: null, tolerance: cfg.processing.key_tolerance_default, flood_fill: true, grid: null, fallback_target_h: null, thresholds: cfg.processing.thresholds_default.slice(), stray_removal: false, auto_outline: false },
  gridMode: 'auto', strip: { n: 1, dividers: null, use: null }, // use: used segment indices (FR-23), null = all
  editing: null, // { batchId, unitId, sourceName } while a unit is loaded back with Edit unit (FR-22)
  sourceName: null, lastSettings: null,
  meta: { ...firstSpecies(), variant: 'base', anim: 'idle', frame_start: 0, unit_id: 'u1', dx: 0, dy: 0 },
  others: [], // units loaded from an existing group: [{ def, frames }]
  result: null, placed: null, error: null, frame: 0, play: 0, timer: null,
  events: [], // recent server/action messages, newest first
  server: window.PP_SERVER || null,
  mode: 'normal', anchor: 'canvas', tool: 'roi',
  view: { scale: 1, ox: 0, oy: 0 }, drag: null,
};

// ------------------------------------------------------------ setup
function fillSpecies() {
  const list = Object.entries(cfg.stages).flatMap(([st, s]) => s.species.map((sp) => ({ sp, st: Number(st), name: s.name })));
  $('species').innerHTML = list.map((x) => `<option value="${x.sp}|${x.st}">${x.sp} · stage ${x.st} ${x.name}</option>`).join('')
    + (!list.length ? '<option value="" disabled>(no species yet)</option>' : '')
    + (S.server ? '<option value="__new__">+ New species…</option>' + (list.length ? '<option value="__rename__">✎ Rename species…</option><option value="__remove__">− Remove species…</option>' : '') : '');
  $('species').value = S.meta.species ? `${S.meta.species}|${S.meta.stage}` : '';
}
fillSpecies();
$('cfgLabel').textContent = `config ${cfg.config_version} · tool ${TOOL_VERSION}`;

function fillAnims() {
  const b = (cfg.animations[String(S.meta.stage)] || {})[S.meta.variant] || {};
  const names = Object.keys(b);
  $('anim').innerHTML = names.map((a) => `<option value="${a}">${a} (${b[a][0] === b[a][1] ? b[a][0] : b[a][0] + '–' + b[a][1]} frames)</option>`).join('');
  if (!names.includes(S.meta.anim)) S.meta.anim = names[0] || 'idle';
  $('anim').value = S.meta.anim;
  $('variant').querySelector('[value=fat]').disabled = !cfg.fat_stages.includes(S.meta.stage);
}
fillAnims();

// ------------------------------------------------------------ processing
let pending = 0;
function schedule() { cancelAnimationFrame(pending); pending = requestAnimationFrame(run); }

function run() {
  S.error = null; S.result = null; S.placed = null;
  if (!S.img) {
    // Group Preview without a loaded source: show the group's existing units on their own (FR-10 panel 2/3)
    if (S.others.length) {
      try { S.placed = placeUnits(S.others, { species: S.meta.species, stage: S.meta.stage, variant: S.meta.variant }, cfg); S.placed.currentIndex = -1; } catch (e) { S.error = e.message; }
    }
    renderAll(); return;
  }
  try {
    const snap = $('snap').checked;
    const grid = S.gridMode === 'manual' ? S.params.grid : { x: { snapping: snap }, y: { snapping: snap } };
    const params = { ...S.params, grid, fallback_target_h: S.gridMode === 'fallback' ? S.params.fallback_target_h : null };
    try {
      S.result = processUnit(S.img, params, { n: S.strip.n, dividers: S.strip.dividers, use: S.strip.use }, cfg, S.cache);
    } catch (e) {
      // dragged dividers no longer fit (grid / region changed) → fall back to even dividers
      if (!S.strip.dividers || /after stray removal/.test(e.message) || !/divider|segment|first frame/.test(e.message)) throw e;
      S.strip.dividers = null;
      S.result = processUnit(S.img, params, { n: S.strip.n, dividers: null, use: S.strip.use }, cfg, S.cache);
      S.notice = 'Dividers no longer matched the grid and were reset to even spacing.';
    }
    const r = S.result.resolved;
    if (!S.params.key) setKeySwatch(r.key);
    if (r.grid && S.gridMode === 'auto') {
      $('px').value = r.grid.x.period.toFixed(2); $('phx').value = r.grid.x.phase.toFixed(2);
      $('py').value = r.grid.y.period.toFixed(2); $('phy').value = r.grid.y.phase.toFixed(2);
    }
    $('confLabel').textContent = r.confidence == null ? '' : `confidence ${(r.confidence * 100).toFixed(0)}%`;
    const units = [...S.others.filter((u) => u.def.id !== S.meta.unit_id), { def: { id: S.meta.unit_id, dx: S.meta.dx, dy: S.meta.dy, anim: S.meta.anim, frame_start: S.meta.frame_start, use: S.strip.use }, frames: S.result.frames, current: true }];
    S.placed = placeUnits(units, { species: S.meta.species, stage: S.meta.stage, variant: S.meta.variant }, cfg);
    S.placed.currentIndex = units.length - 1;
  } catch (e) { S.error = e.message; }
  renderAll();
}

const animOf = (name) => (parseName(name) || {}).anim;
// Priority as in the team's version: frames of the selected animation first, else the current unit.
const currentOutputs = () => {
  if (editor && editor.isShown()) return editor.outputs();
  if (!S.placed || !S.placed.outputs) return [];
  const forAnim = S.placed.outputs.filter((o) => animOf(o.name) === S.meta.anim);
  if (forAnim.length) return forAnim;
  const cur = S.placed.outputs.filter((o) => o.unitIndex === S.placed.currentIndex);
  return cur.length ? cur : S.placed.outputs; // no current unit (group preview only): every frame
};

// ------------------------------------------------------------ rendering
function setKeySwatch(k) { $('keySwatch').style.background = k ? `rgb(${k.join(',')})` : 'transparent'; }

function fitView() {
  const st = $('stage').getBoundingClientRect();
  const s = Math.min(st.width / S.img.w, st.height / S.img.h) * 0.94;
  S.view = { scale: s, ox: (st.width - S.img.w * s) / 2, oy: (st.height - S.img.h * s) / 2 };
}

let srcBitmap = null;
function drawSource() {
  const c = $('srcCanvas'), st = $('stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  for (const cv of [c, $('ovCanvas')]) { cv.width = Math.round(st.width * dpr); cv.height = Math.round(st.height * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.imageSmoothingEnabled = S.view.scale < 1;
  g.clearRect(0, 0, st.width, st.height);
  if (!srcBitmap) return;
  g.drawImage(srcBitmap, S.view.ox, S.view.oy, S.img.w * S.view.scale, S.img.h * S.view.scale);
}

function drawOverlay() {
  const c = $('ovCanvas'), dpr = window.devicePixelRatio || 1, g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  if (!S.img) return;
  const { scale: s, ox, oy } = S.view;
  const X = (x) => ox + x * s, Y = (y) => oy + y * s;
  const roi = S.params.roi || { x: 0, y: 0, w: S.img.w, h: S.img.h };
  // dim outside ROI
  g.fillStyle = 'rgba(220,220,215,.72)';
  g.beginPath(); g.rect(X(0), Y(0), S.img.w * s, S.img.h * s); g.rect(X(roi.x), Y(roi.y), roi.w * s, roi.h * s); g.fill('evenodd');
  const r = S.result && S.result.resolved;
  if (r && r.lines) {
    const [rx, ry] = r.lines.roiOffset;
    g.strokeStyle = 'rgba(255,0,255,.45)'; g.lineWidth = 1;
    g.beginPath();
    for (const lx of r.lines.x) { g.moveTo(X(rx + lx), Y(ry + r.lines.y[0])); g.lineTo(X(rx + lx), Y(ry + r.lines.y[r.lines.y.length - 1])); }
    for (const ly of r.lines.y) { g.moveTo(X(rx + r.lines.x[0]), Y(ry + ly)); g.lineTo(X(rx + r.lines.x[r.lines.x.length - 1]), Y(ry + ly)); }
    g.stroke();
    if (S.strip.n > 1) {
      // dim segments left out (FR-23)
      if (S.strip.use) {
        const b = [0, ...r.dividers, r.lines.x.length - 1];
        g.fillStyle = 'rgba(220,220,215,.78)';
        for (let sgi = 0; sgi < S.strip.n; sgi++) if (!S.strip.use.includes(sgi)) g.fillRect(X(rx + r.lines.x[b[sgi]]), Y(ry), (r.lines.x[b[sgi + 1]] - r.lines.x[b[sgi]]) * s, roi.h * s);
      }
      g.strokeStyle = '#ff00ff'; g.lineWidth = 3;
      for (const d of r.dividers) { const lx = r.lines.x[d]; g.beginPath(); g.moveTo(X(rx + lx), Y(ry) - 8); g.lineTo(X(rx + lx), Y(ry + roi.h) + 8); g.stroke(); }
    }
  }
  g.strokeStyle = '#ff00ff'; g.lineWidth = 2; g.setLineDash([6, 4]);
  g.strokeRect(X(roi.x), Y(roi.y), roi.w * s, roi.h * s); g.setLineDash([]);
  if (S.drag && S.drag.kind === 'roi' && S.drag.rect) { const q = S.drag.rect; g.strokeStyle = '#000'; g.strokeRect(X(q.x), Y(q.y), q.w * s, q.h * s); }
  $('zoomLabel').hidden = false; $('zoomLabel').textContent = `${Math.round(s * 100)}%`;
}

function drawHistogram() {
  const c = $('hist'), g = c.getContext('2d');
  g.clearRect(0, 0, 256, 44);
  if (!S.result) return;
  const h = histogram(S.result.nat);
  let max = 1; for (const v of h) if (v > max) max = v;
  const [t1, t2, t3] = S.params.thresholds;
  for (let x = 0; x < 256; x++) {
    const idx = x < t1 ? 0 : x < t2 ? 1 : x < t3 ? 2 : 3;
    g.fillStyle = idx === 3 ? '#bbb' : `rgb(${PAL[idx].join(',')})`;
    const hh = Math.round((Math.sqrt(h[x]) / Math.sqrt(max)) * 42);
    g.fillRect(x, 44 - hh, 1, hh);
  }
  g.fillStyle = '#ff00ff';
  for (const t of [t1, t2, t3]) g.fillRect(Math.min(255, t), 0, 1, 44);
}

function drawSprite() {
  const c = $('spriteCanvas'), g = c.getContext('2d'), Z = 4;
  g.clearRect(0, 0, 256, 256);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { g.fillStyle = (x + y) & 1 ? '#e4e4df' : '#cfcfca'; g.fillRect(x * Z, y * Z, Z, Z); }
  const outs = currentOutputs();
  const o = outs[Math.min(S.frame, outs.length - 1)];
  if (o) for (let i = 0; i < 4096; i++) { const v = o.canvas.I[i]; if (v === TRANSPARENT) continue; g.fillStyle = `rgb(${PAL[v].join(',')})`; g.fillRect((i % 64) * Z, ((i / 64) | 0) * Z, Z, Z); }
  const box = cfg.stages[String(S.meta.stage)].box;
  const bx = Math.floor((64 - box[0]) / 2), by = cfg.baseline_y - box[1] + 1;
  g.strokeStyle = '#ff00ff'; g.lineWidth = 1; g.setLineDash([4, 3]);
  g.strokeRect(bx * Z + 0.5, by * Z + 0.5, box[0] * Z - 1, box[1] * Z - 1); g.setLineDash([]);
  g.beginPath(); g.moveTo(0, (cfg.baseline_y + 1) * Z - 0.5); g.lineTo(256, (cfg.baseline_y + 1) * Z - 0.5); g.stroke();
  $('spriteTitle').textContent = o ? `Sprite 64 × 64 — ${o.name}` : 'Sprite 64 × 64';
  $('placeInfo').textContent = S.placed && S.placed.U ? `Group ${S.placed.U.w} × ${S.placed.U.h} in box ${box[0]} × ${box[1]}` : '';
  $('frameOut').textContent = outs.length ? `${Math.min(S.frame, outs.length - 1) + 1} / ${outs.length}` : '–';
}

function drawEink() {
  const c = $('einkCanvas'), g = c.getContext('2d');
  const id = g.createImageData(200, 200);
  const outs = currentOutputs();
  const o = outs[Math.min(S.frame, outs.length - 1)];
  const P = cfg.preview;
  const opts = { screen: P.screen, scale: P.sprite_scale, offset: P.sprite_offset, dialogHeight: S.mode === 'dialog' ? P.dialog_height : 0 };
  const empty = { w: 64, h: 64, I: new Uint8Array(4096).fill(TRANSPARENT) };
  const bits = composeScreenFine(o ? o.canvas : empty, cfg, { ...opts, anchor: S.anchor }); // §2.4 (D16): scale first, then dither at screen pixels
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? [24, 24, 24] : [236, 236, 230]; // ink on e-paper
    id.data[i * 4] = v[0]; id.data[i * 4 + 1] = v[1]; id.data[i * 4 + 2] = v[2]; id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  if (S.mode === 'dialog') {
    // sample text, thresholded to 1-bit like the firmware would draw it
    const top = 200 - P.dialog_height;
    g.fillStyle = '#000'; g.font = 'bold 11px ' + getComputedStyle(document.body).fontFamily;
    g.fillText('Found a treasure box!', 10, top + 22);
    const t = g.getImageData(1, top + 1, 198, P.dialog_height - 2);
    for (let i = 0; i < t.data.length; i += 4) { const v = t.data[i] < 128 ? 24 : 236; t.data[i] = t.data[i + 1] = v; t.data[i + 2] = v === 24 ? 24 : 230; }
    g.putImageData(t, 1, top + 1);
  }
}

/** Message panel: list + a count summary that stays visible when the panel is collapsed. */
function showMessages(items) {
  $('messages').innerHTML = items.map(([k, t]) => `<li class="${k}">${t.replace(/</g, '&lt;')}</li>`).join('');
  const n = (k) => items.filter((x) => x[0] === k).length;
  const f = n('fail'), w = n('warn');
  $('msgCount').innerHTML = `${f ? `<span class="fail">${f} fail</span>` : ''}${w ? `<span class="warn">${w} warn</span>` : ''}${!f && !w ? '<span>OK</span>' : ''}`;
}
function setMsgCollapsed(c) {
  $('msgPanel').classList.toggle('collapsed', c);
  $('msgToggle').setAttribute('aria-expanded', String(!c));
  try { localStorage.setItem('pp-msgs-collapsed', c ? '1' : '0'); } catch { /* no storage */ }
}
$('msgToggle').onclick = () => setMsgCollapsed(!$('msgPanel').classList.contains('collapsed'));
try { if (localStorage.getItem('pp-msgs-collapsed') === '1') setMsgCollapsed(true); } catch { /* no storage */ }

function messages() {
  const items = [];
  for (const [k, t] of S.events.slice(0, 6)) items.push([k, t]);
  if (editor && editor.isShown()) {
    items.push(...editor.messages());
    if (items.length === S.events.slice(0, 6).length) items.push(['ok', 'Clean Editor: no Validator problems.']);
    showMessages(items);
    return;
  }
  if (S.error) items.push(['fail', S.error]);
  if (S.notice) { items.push(['ok', S.notice]); S.notice = null; }
  if (S.result) for (const w of S.result.warnings) items.push(['warn', w]);
  if (S.placed) {
    if (S.placed.blocked) items.push(['fail', S.placed.blocked]);
    if (S.placed.exceedsBox) items.push(['warn', `Group ${S.placed.U.w} × ${S.placed.U.h} exceeds the stage box — trim in cleanup or regenerate smaller`]);
    const anims = {};
    for (const o of S.placed.outputs) { const m = /_([a-z0-9]+)_(\d{2})\.png$/.exec(o.name); (anims[m[1]] ||= []).push(Number(m[2])); }
    for (const w of budgetWarnings(cfg, S.meta.stage, S.meta.variant, anims)) items.push([/is missing$/.test(w) ? 'ok' : 'warn', w]);
    if (!S.placed.blocked) {
      const files = S.placed.outputs.map((o) => ({ name: o.name, bytes: encodeCanonical(o.canvas, cfg) }));
      const v = validateGroup({ mode: 'raw', batchId: groupId(S.meta.species, S.meta.stage, S.meta.variant), files, batch: { stage: S.meta.stage, variant: S.meta.variant, T: S.placed.T }, cfg });
      for (const f of v.fails) items.push(['fail', 'Validator: ' + f]);
      for (const w of v.warns) if (!/budget|missing$/.test(w)) items.push(['warn', 'Validator: ' + w]);
    }
    const stray = (S.result ? S.result.frames : []).reduce((n, f) => n + f.stray.length, 0);
    if (stray && !S.params.stray_removal) items.push(['ok', `${stray} isolated pixel(s) found — check eye highlights before enabling Remove strays`]);
  }
  let mem = !S.meta.species ? `No species in this project yet — add one with ${S.server ? '+ New species… in the Species list' : '`pixelpipe species-add <id> --stage N`'}` : checkMembership(cfg, S.meta.species, S.meta.stage, S.meta.variant);
  if (mem && window.PP_EXAMPLE && !S.server) mem += ` (${EXAMPLE_HINT})`;
  if (window.PP_EXAMPLE && !S.server) items.push(['warn', `Example config: ${EXAMPLE_HINT}.`]);
  if (mem) items.push(['fail', mem]);
  if (S.img && !S.server && !/^[0-9a-f]{16}\.png$/.test(S.fileName)) items.push(['warn', `“${S.fileName}” is not an archived source. Run pixelpipe archive and open the PNG it creates, otherwise add will reject the fragment.`]);
  if (!items.length) items.push(['ok', S.img ? 'No problems found.' : 'Messages from each step appear here.']);
  const seen = new Set();
  const uniq = items.filter(([, t]) => { const k = t.replace(/^Validator: /, ''); if (seen.has(k)) return false; seen.add(k); return true; });
  showMessages(uniq);
  const ready = !!S.result && !S.error && !mem && !(S.placed && S.placed.blocked);
  $('exportBtn').disabled = !ready;
  if ($('addBtn')) $('addBtn').disabled = !ready;
}

function renderAll() { if (S.img) { drawSource(); drawOverlay(); } drawHistogram(); drawSprite(); drawEink(); messages(); }

// ------------------------------------------------------------ loading
async function loadFile(file) {
  let buf = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  S.sourceName = /^[0-9a-f]{16}\.png$/.test(name) ? null : name; // the original file name, shown in the units list (FR-22)
  try {
    if (S.server && !/^[0-9a-f]{16}\.png$/.test(name)) {
      // server mode: archive automatically (§3.3), then work on the archived PNG
      const a = await serverApi.archive(buf, S.meta.species);
      buf = a.bytes; name = a.name; S.srcSpecies = S.meta.species;
      note('ok', `${a.existing ? 'Already archived' : 'Archived'} ${file.name} → ${a.path}`);
    }
    editor.hide();
    const img = decodeImage(buf, cfg.processing.max_source_px);
    S.img = img; S.bytes = buf; S.fileName = name; S.sha = sha256(buf); S.cache = new Map();
    if (!S.server) S.srcSpecies = S.meta.species;
    S.params.roi = null; S.params.key = null; S.strip.dividers = null; S.frame = 0;
    const cv = document.createElement('canvas'); cv.width = img.w; cv.height = img.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.length), img.w, img.h), 0, 0);
    srcBitmap = cv;
    $('emptyMsg').hidden = true;
    $('fileLabel').textContent = `${name} — ${img.w} × ${img.h} px — sha256 ${S.sha.slice(0, 12)}…`;
    fitView(); schedule();
  } catch (e) { S.error = `Could not open ${file.name}: ${e.message}`; messages(); }
}

/** Preview a group's real placement. getSidecar(name) → object, getSource(relPath) → bytes. */
async function applyGroup(batch, getSidecar, getSource) {
  const units = [];
  for (const u of batch.units) {
    const sc = await getSidecar(u.frames[0].name, u.frames[0].sidecar);
    const params = Object.fromEntries(PARAM_KEYS.map((k) => [k, sc[k]]));
    const img = decodeImage(await getSource(u.source), cfg.processing.max_source_px);
    units.push({ def: { ...u, use: u.frames.map((f, i) => f.segment ?? i) }, frames: processUnit(img, params, u.strip, cfg).frames });
  }
  S.others = units;
  editor.hide();
  $('species').value = `${batch.species}|${batch.stage}`; S.meta.species = batch.species; S.meta.stage = batch.stage;
  S.meta.variant = batch.variant; $('variant').value = batch.variant; fillAnims();
  if (batch.dither_anchor) { S.anchor = batch.dither_anchor; setPressed(['ancCanvas', 'ancSprite'], S.anchor === 'sprite' ? 'ancSprite' : 'ancCanvas'); }
  S.error = null; schedule();
}

/** Clean frames (64x64 PNGs) dropped in file mode open in the Clean Editor as an unsaved sandbox (FR-17). */
function applyCleanFrames(list) {
  editor.openFiles(list);
  note('ok', `Opened ${editor.E.batchId} in the Clean Editor as an unsaved sandbox${S.server ? ' (dropped files are not saved; use Edit clean in the Group panel to edit the files on disk)' : ' — start pixelpipe serve to save'}.`);
}

async function loadGroup(files) {
  const list = [...files];
  const byName = new Map(list.map((f) => [f.name, f]));
  const batchFile = list.find((f) => f.name.endsWith('.batch.json'));
  try {
    if (!batchFile) {
      const pngs = list.filter((f) => f.name.toLowerCase().endsWith('.png'));
      if (!pngs.length) throw new Error('select the .batch.json with its sidecars and sources, or clean PNG frames');
      applyCleanFrames(await Promise.all(pngs.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      return;
    }
    const batch = JSON.parse(await batchFile.text());
    const need = (n) => { const f = byName.get(n); if (!f) throw new Error(`also select ${n}`); return f; };
    await applyGroup(batch,
      async (name, rel) => JSON.parse(await need(rel.split('/').pop()).text()),
      async (rel) => new Uint8Array(await need(rel.split('/').pop()).arrayBuffer()));
  } catch (e) { S.error = 'Load group: ' + e.message; messages(); }
}

function note(kind, text) { S.events.unshift([kind, text]); S.events.length = Math.min(S.events.length, 12); messages(); }

// ------------------------------------------------------------ export
function buildFragment() {
  const r = S.result.resolved;
  const params = {
    roi: S.params.roi || { x: 0, y: 0, w: S.img.w, h: S.img.h },
    key: r.key, tolerance: S.params.tolerance, flood_fill: S.params.flood_fill,
    grid: S.gridMode === 'fallback' ? null : r.grid,
    fallback_target_h: S.gridMode === 'fallback' ? S.params.fallback_target_h : null,
    thresholds: S.params.thresholds, stray_removal: S.params.stray_removal, auto_outline: S.params.auto_outline,
  };
  const frag = {
    tool_version: TOOL_VERSION, pixel_hash: pixelHash(cfg),
    batch_id: groupId(S.meta.species, S.meta.stage, S.meta.variant),
    species: S.meta.species, stage: S.meta.stage, variant: S.meta.variant, dither_anchor: S.anchor,
    unit: {
      id: S.meta.unit_id, source: `art/source/${S.srcSpecies || S.meta.species}/${S.fileName}`, source_sha256: S.sha,
      anim: S.meta.anim, frame_start: S.meta.frame_start, strip: { n: S.strip.n, dividers: r.dividers, ...(S.strip.use ? { use: S.strip.use } : {}) }, dx: S.meta.dx, dy: S.meta.dy, params,
      ...(S.sourceName ? { source_name: S.sourceName } : {}),
    },
  };
  return frag;
}

// ------------------------------------------------------------ FR-22 Edit unit / FR-24 settings
/** Copy of the image-independent settings of a fragment / sidecar params, for "Use settings from…". */
function settingsOf(p, label) {
  return { label, key: p.key, tolerance: p.tolerance, flood_fill: p.flood_fill, grid: p.grid, roi: p.roi || null, fallback_target_h: p.fallback_target_h, thresholds: p.thresholds, stray_removal: p.stray_removal, auto_outline: p.auto_outline };
}
/** Grid phases are relative to the ROI origin: re-express a grid stored for ROI `from` for ROI `to` (FR-24). */
function rephase(grid, from, to) {
  const m = (v, p) => ((v % p) + p) % p;
  const fx = from ? from.x : 0, fy = from ? from.y : 0, tx = to ? to.x : 0, ty = to ? to.y : 0;
  return {
    x: { ...grid.x, phase: m(grid.x.phase + fx - tx, grid.x.period) },
    y: { ...grid.y, phase: m(grid.y.phase + fy - ty, grid.y.period) },
  };
}
function setGridModeUI(m) {
  S.gridMode = m; setPressed(['gridAuto', 'gridManual', 'gridFallback'], { auto: 'gridAuto', manual: 'gridManual', fallback: 'gridFallback' }[m]);
  $('gridFields').hidden = m === 'fallback'; $('fallbackRow').hidden = m !== 'fallback';
}
/** Apply stored parameters to the page state directly (never through the form controls, so nothing is rounded). */
function applyParams(p, { withImageSpecific = false } = {}) {
  if (p.key) { S.params.key = p.key.slice(); setKeySwatch(p.key); }
  // null means "the default" in a sidecar, exactly as rebuild reads it
  S.params.tolerance = p.tolerance ?? cfg.processing.key_tolerance_default; $('tol').value = S.params.tolerance; $('tolOut').textContent = S.params.tolerance;
  S.params.flood_fill = p.flood_fill !== false; $('flood').checked = S.params.flood_fill;
  if (p.thresholds) { S.params.thresholds = p.thresholds.slice(); ['t1', 't2', 't3'].forEach((id, i) => { $(id).value = p.thresholds[i]; $(id + 'Out').textContent = p.thresholds[i]; }); }
  S.params.stray_removal = !!p.stray_removal; $('stray').checked = !!p.stray_removal;
  S.params.auto_outline = !!p.auto_outline; $('outline').checked = !!p.auto_outline;
  if (p.fallback_target_h) {
    S.params.fallback_target_h = p.fallback_target_h; $('fbh').value = p.fallback_target_h; setGridModeUI('fallback');
  } else if (p.grid && p.grid.x && p.grid.x.period) {
    S.params.grid = JSON.parse(JSON.stringify(p.grid));
    $('px').value = String(p.grid.x.period); $('phx').value = String(p.grid.x.phase);
    $('py').value = String(p.grid.y.period); $('phy').value = String(p.grid.y.phase);
    $('snap').checked = p.grid.x.snapping !== false;
    setGridModeUI('manual');
  }
  if (withImageSpecific && p.roi) S.params.roi = { ...p.roi };
}

/** FR-22: load a unit back into the converter exactly as it was added. d = GET /api/group detail. */
async function editUnit(d, unitId, fileBytes) {
  const u = d.batch.units.find((x) => x.id === unitId);
  if (!u) throw new Error(`no unit ${unitId}`);
  await applyGroup(d.batch, async (name) => d.sidecars[name], async (rel) => fileBytes(rel));
  const bytes = await fileBytes(u.source);
  await loadFile(new File([bytes], u.source.split('/').pop()));
  const sc = d.sidecars[u.frames[0].name];
  if (!sc) throw new Error(`${u.id}: sidecar ${u.frames[0].sidecar} is missing — run rebuild`);
  S.srcSpecies = d.batch.species;
  S.sourceName = u.source_name || null;
  Object.assign(S.meta, { species: d.batch.species, stage: d.batch.stage, variant: d.batch.variant, anim: u.anim, unit_id: u.id, frame_start: u.frame_start || 0, dx: u.dx || 0, dy: u.dy || 0 });
  $('species').value = S.meta.species ? `${S.meta.species}|${S.meta.stage}` : ''; $('variant').value = S.meta.variant; fillAnims();
  if (![...$('anim').options].some((o) => o.value === u.anim)) $('anim').insertAdjacentHTML('beforeend', `<option value="${u.anim}" data-temp="1">${u.anim} (not in budget)</option>`);
  S.meta.anim = u.anim; $('anim').value = u.anim; $('unitId').value = u.id; $('frameStart').value = S.meta.frame_start; $('dx').value = S.meta.dx; $('dy').value = S.meta.dy;
  applyParams(sc, { withImageSpecific: true });
  S.strip = { n: u.strip.n || 1, dividers: u.strip.dividers ? u.strip.dividers.slice() : null, use: u.strip.use ? u.strip.use.slice() : null };
  $('nFrames').value = S.strip.n; fillUse();
  setEditing({ batchId: d.batch.batch_id, unitId: u.id });
  S.cache = new Map(); schedule();
}
function setEditing(ed) {
  S.editing = ed;
  for (const id of ['species', 'variant', 'anim', 'unitId', 'frameStart', 'dx', 'dy']) $(id).disabled = !!ed;
  if (!ed) $('anim').querySelectorAll('option[data-temp]').forEach((o) => { if (o.value !== S.meta.anim) o.remove(); });
  $('editBanner').hidden = !ed;
  if (ed) $('editLabel').textContent = `Editing unit ${ed.unitId} of ${ed.batchId} — Add to group replaces it.`;
}
/** Next free unit id and first frame; units = [{ id, anim, frame_start, frames }] (default: the group as previewed). */
function nextFreeUnit(units = S.others.map((u) => ({ ...u.def, frames: (u.def.use || u.frames) }))) {
  const taken = new Set(units.map((u) => u.id));
  let k = 1; while (taken.has(`u${k}`)) k++;
  S.meta.unit_id = `u${k}`; $('unitId').value = S.meta.unit_id;
  const ends = units.filter((u) => u.anim === S.meta.anim).map((u) => (u.frame_start || 0) + u.frames.length);
  S.meta.frame_start = ends.length ? Math.max(...ends) : 0; $('frameStart').value = S.meta.frame_start;
}
$('stopEdit').onclick = () => {
  setEditing(null); nextFreeUnit();
  note('ok', `Stopped editing: the next Add creates a new unit ${S.meta.unit_id} at ${S.meta.anim} frame ${String(S.meta.frame_start).padStart(2, '0')}.`); schedule();
};

/** FR-24: copy image-independent settings from another unit (or the last one added / exported). */
async function useSettingsFrom() {
  const opts = [];
  if (S.lastSettings) opts.push(['last', `Last: ${S.lastSettings.label}`]);
  const found = {};
  if (serverApi) {
    for (const gid of serverApi.groupIds().filter((g) => g.startsWith(S.meta.species + '_s'))) {
      const d = await serverApi.get(`/api/group/${encodeURIComponent(gid)}`);
      if (!d.batch) continue;
      for (const u of d.batch.units) { const k = `${gid}/${u.id}`; found[k] = settingsOf(d.sidecars[u.frames[0].name], k); opts.push([k, `${gid} · ${u.id} · ${u.anim}${u.source_name ? ` · ${u.source_name}` : ''}`]); }
    }
  }
  if (!opts.length) { note('warn', S.server ? `No units of ${S.meta.species} yet.` : 'Export a fragment first; its settings can then be reused here.'); return; }
  const pick = await choose($, 'Copy key colour, tolerance, grid, tones and toggles from:', [...opts, ['', 'Cancel']]);
  if (!pick) return;
  const st0 = pick === 'last' ? S.lastSettings : found[pick];
  const st = st0.grid && st0.grid.x && st0.grid.x.period ? { ...st0, grid: rephase(st0.grid, st0.roi, S.params.roi) } : st0;
  applyParams(st);
  if (!st.fallback_target_h && !(st.grid && st.grid.x && st.grid.x.period)) setGridModeUI('auto');
  S.strip.dividers = null; S.cache = new Map(); schedule();
  note('ok', `Using the settings of ${st.label}. Check the grid overlay: lines snap to this image's edges.`);
}
$('settingsFrom').onclick = () => runSafe(useSettingsFrom);

function exportFragment() {
  const frag = buildFragment();
  S.lastSettings = settingsOf(frag.unit.params, `${frag.batch_id} · ${frag.unit.id} (exported)`);
  const blob = new Blob([JSON.stringify(frag, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${frag.batch_id}.${S.meta.unit_id}.fragment.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('messages').insertAdjacentHTML('afterbegin', `<li class="ok">Exported ${a.download}. Run: pixelpipe add ${a.download}</li>`);
}

// ------------------------------------------------------------ events
const toSrc = (ev) => { const b = $('stage').getBoundingClientRect(); return [(ev.clientX - b.left - S.view.ox) / S.view.scale, (ev.clientY - b.top - S.view.oy) / S.view.scale]; };
const setPressed = (ids, on) => ids.forEach((id) => $(id).setAttribute('aria-pressed', String(id === on)));
function setTool(t) { S.tool = t; $('roiBtn').setAttribute('aria-pressed', String(t === 'roi')); $('eyedropBtn').setAttribute('aria-pressed', String(t === 'eyedrop')); $('divBtn').setAttribute('aria-pressed', String(t === 'divider')); $('stage').style.cursor = t === 'eyedrop' ? 'crosshair' : t === 'divider' ? 'ew-resize' : 'crosshair'; }

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$('groupBtn').onclick = () => $('groupInput').click();
$('groupInput').onchange = (e) => e.target.files.length && loadGroup(e.target.files);
$('exportBtn').onclick = exportFragment;
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', (e) => {
  e.preventDefault(); stage.classList.remove('drop');
  const files = e.dataTransfer.files;
  if (files.length > 1) loadGroup(files);
  else if (files[0]) (files[0].name.endsWith('.batch.json') || parseName(files[0].name) ? loadGroup([files[0]]) : loadFile(files[0]));
});

stage.addEventListener('wheel', (e) => {
  if (!S.img || editor.isShown()) return; e.preventDefault();
  const b = stage.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  const f = Math.exp(-e.deltaY * 0.0015), s2 = Math.min(32, Math.max(0.05, S.view.scale * f));
  S.view.ox = mx - ((mx - S.view.ox) * s2) / S.view.scale; S.view.oy = my - ((my - S.view.oy) * s2) / S.view.scale; S.view.scale = s2;
  drawSource(); drawOverlay();
}, { passive: false });

stage.addEventListener('pointerdown', (e) => {
  if (!S.img || editor.isShown()) return; // the Clean Editor lives inside #stage: never capture its clicks
  stage.setPointerCapture(e.pointerId);
  const [x, y] = toSrc(e);
  if (e.button === 1 || e.altKey || e.shiftKey) { S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; return; }
  if (S.tool === 'eyedrop') {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi >= 0 && yi >= 0 && xi < S.img.w && yi < S.img.h) { const q = (yi * S.img.w + xi) * 4; S.params.key = [S.img.rgba[q], S.img.rgba[q + 1], S.img.rgba[q + 2]]; setKeySwatch(S.params.key); setTool('roi'); schedule(); }
    return;
  }
  if (S.tool === 'divider' && S.result && S.result.resolved.lines) {
    const r = S.result.resolved, rx = r.lines.roiOffset[0];
    let best = -1, bd = Infinity;
    r.dividers.forEach((d, i) => { const dd = Math.abs(rx + r.lines.x[d] - x); if (dd < bd) { bd = dd; best = i; } });
    if (best >= 0) S.drag = { kind: 'divider', i: best };
    return;
  }
  S.drag = { kind: 'roi', x0: x, y0: y, rect: null };
});
stage.addEventListener('pointermove', (e) => {
  if (!S.drag) return;
  if (S.drag.kind === 'pan') { S.view.ox = S.drag.ox + e.clientX - S.drag.sx; S.view.oy = S.drag.oy + e.clientY - S.drag.sy; drawSource(); drawOverlay(); return; }
  const [x, y] = toSrc(e);
  if (S.drag.kind === 'roi') {
    const cl = (v, m) => Math.max(0, Math.min(m, Math.round(v)));
    const x0 = cl(Math.min(S.drag.x0, x), S.img.w), y0 = cl(Math.min(S.drag.y0, y), S.img.h), x1 = cl(Math.max(S.drag.x0, x), S.img.w), y1 = cl(Math.max(S.drag.y0, y), S.img.h);
    S.drag.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; drawOverlay();
  } else if (S.drag.kind === 'divider') {
    const r = S.result.resolved, rx = r.lines.roiOffset[0];
    let cell = 0, bd = Infinity;
    r.lines.x.forEach((lx, i) => { const dd = Math.abs(rx + lx - x); if (dd < bd) { bd = dd; cell = i; } });
    const d = r.dividers.slice(); d[S.drag.i] = cell;
    const W = r.lines.x.length - 1;
    if (d.every((v, i) => v >= 1 && v <= W - 1 && (i === 0 || v > d[i - 1]))) { S.strip.dividers = d; schedule(); }
  }
});
stage.addEventListener('pointerup', () => {
  if (S.drag && S.drag.kind === 'roi' && S.drag.rect && S.drag.rect.w > 4 && S.drag.rect.h > 4) {
    if (S.gridMode === 'manual' && S.params.grid && S.params.grid.x) { // keep manual grid lines on the same image positions
      S.params.grid = rephase(S.params.grid, S.params.roi, S.drag.rect);
      $('phx').value = String(S.params.grid.x.phase); $('phy').value = String(S.params.grid.y.phase);
    }
    S.params.roi = S.drag.rect; S.strip.dividers = null; schedule();
  }
  S.drag = null; drawOverlay();
});
window.addEventListener('resize', () => { if (S.img) { fitView(); drawSource(); drawOverlay(); } });

$('roiBtn').onclick = () => setTool('roi');
$('roiReset').onclick = () => {
  if (S.gridMode === 'manual' && S.params.grid && S.params.grid.x) { S.params.grid = rephase(S.params.grid, S.params.roi, null); $('phx').value = String(S.params.grid.x.phase); $('phy').value = String(S.params.grid.y.phase); }
  S.params.roi = null; S.strip.dividers = null; schedule();
};
$('eyedropBtn').onclick = () => setTool(S.tool === 'eyedrop' ? 'roi' : 'eyedrop');
$('autoKeyBtn').onclick = () => { S.params.key = null; schedule(); };
$('tol').oninput = (e) => { S.params.tolerance = +e.target.value; S.strip.dividers = null; $('tolOut').textContent = e.target.value; schedule(); };
$('flood').onchange = (e) => { S.params.flood_fill = e.target.checked; schedule(); };

function setGridMode(m) {
  S.gridMode = m; S.strip.dividers = null; setPressed(['gridAuto', 'gridManual', 'gridFallback'], { auto: 'gridAuto', manual: 'gridManual', fallback: 'gridFallback' }[m]);
  $('gridFields').hidden = m === 'fallback'; $('fallbackRow').hidden = m !== 'fallback';
  if (m === 'manual') readManualGrid();
  schedule();
}
function readManualGrid() {
  const snap = $('snap').checked;
  S.strip.dividers = null;
  const clampP = (v) => Math.max(2, Math.min(64, Number.isFinite(v) ? v : 8));
  S.params.grid = { x: { period: clampP(+$('px').value), phase: +$('phx').value || 0, snapping: snap }, y: { period: clampP(+$('py').value), phase: +$('phy').value || 0, snapping: snap } };
}
$('gridAuto').onclick = () => setGridMode('auto');
$('gridManual').onclick = () => setGridMode('manual');
$('gridFallback').onclick = () => setGridMode('fallback');
for (const id of ['px', 'phx', 'py', 'phy']) $(id).oninput = () => { if (S.gridMode !== 'manual') setGridMode('manual'); else { readManualGrid(); schedule(); } };
$('snap').onchange = () => { if (S.gridMode === 'manual') readManualGrid(); S.strip.dividers = null; schedule(); };
$('fbh').oninput = (e) => { S.params.fallback_target_h = +e.target.value; S.strip.dividers = null; schedule(); };
S.params.fallback_target_h = 40;

function setThresholds(t) {
  S.params.thresholds = t;
  ['t1', 't2', 't3'].forEach((id, i) => { $(id).value = t[i]; $(id + 'Out').textContent = t[i]; });
  schedule();
}
for (const [i, id] of ['t1', 't2', 't3'].entries()) $(id).oninput = (e) => {
  const t = S.params.thresholds.slice(); t[i] = +e.target.value;
  for (let k = 0; k < 3; k++) { if (k < i && t[k] > t[i]) t[k] = t[i]; if (k > i && t[k] < t[i]) t[k] = t[i]; }
  setThresholds(t);
};
$('autoTones').onclick = () => { if (S.result) setThresholds(S.result.resolved.autoThresholds()); };

$('nFrames').oninput = (e) => { S.strip.n = Math.max(1, Math.min(16, +e.target.value || 1)); S.strip.dividers = null; S.strip.use = null; S.frame = 0; fillUse(); schedule(); };

// FR-23: one Use checkbox per strip segment
function fillUse() {
  $('useRow').hidden = S.strip.n < 2;
  const used = S.strip.use || Array.from({ length: S.strip.n }, (_, i) => i);
  $('useBoxes').innerHTML = Array.from({ length: S.strip.n }, (_, i) => `<label class="u"><input type="checkbox" data-seg="${i}"${used.includes(i) ? ' checked' : ''}>${i + 1}</label>`).join('');
  $('useBoxes').querySelectorAll('input').forEach((cb) => {
    cb.onchange = () => {
      const use = [...$('useBoxes').querySelectorAll('input')].filter((x) => x.checked).map((x) => +x.dataset.seg);
      if (!use.length) { cb.checked = true; note('warn', 'Use at least one frame of the strip.'); return; }
      S.strip.use = use.length === S.strip.n ? null : use; S.frame = 0; schedule();
    };
  });
}
fillUse();
$('divBtn').onclick = () => setTool(S.tool === 'divider' ? 'roi' : 'divider');
$('divReset').onclick = () => { S.strip.dividers = null; schedule(); };
$('stray').onchange = (e) => { S.params.stray_removal = e.target.checked; schedule(); };
$('outline').onchange = (e) => { S.params.auto_outline = e.target.checked; schedule(); };
$('dx').oninput = (e) => { S.meta.dx = +e.target.value | 0; schedule(); };
$('dy').oninput = (e) => { S.meta.dy = +e.target.value | 0; schedule(); };

/** FR-26: mirror a finished rename in the page (config, selection, editor, settings cache). */
function onRenamed(r) {
  for (const s of Object.values(cfg.stages)) s.species = s.species.map((x) => (x === r.old ? r.new : x));
  if (S.meta.species === r.old) S.meta.species = r.new;
  if (S.srcSpecies === r.old) S.srcSpecies = r.new;
  S.lastSettings = null;
  if (editor.isOpen() && editor.E.batchId && parseGroupId(editor.E.batchId)?.species === r.old) editor.close();
  if (S.editing && parseGroupId(S.editing.batchId)?.species === r.old) setEditing(null);
  S.others = [];
  fillSpecies(); fillAnims(); schedule();
  const drafts = []; try { for (const g of r.groups) { const o = g.split(' → ')[0]; if (localStorage.getItem(`pp-draft:${o}`) != null) drafts.push(o); } } catch { /* no storage */ }
  if (drafts.length) note('warn', `A saved Clean Editor draft exists under the old name (${drafts.join(', ')}); it is not carried over to the new name.`);
  note('ok', `Renamed species "${r.old}" to "${r.new}": ${r.moved} file(s) moved, ${r.rewritten} JSON file(s) updated${r.exported.length ? `, export regenerated for ${r.exported.join(', ')}` : ''}${r.export_not_regenerated.length ? `; no export for ${r.export_not_regenerated.join(', ')} until its Validator FAILs are fixed` : ''}. Record the change in your project's species list${r.symbols.length ? ` and the firmware (${r.symbols.map((x) => x.symbol_prefix).join('; ')})` : ''}.`);
  if (r.rebuild_check !== 'unchanged') note('warn', `Rebuild check differs after the rename: ${JSON.stringify(r.rebuild_check)}`);
}

function setSpecies(sp, st) { S.meta.species = sp; S.meta.stage = st; if (!cfg.fat_stages.includes(S.meta.stage)) { S.meta.variant = 'base'; $('variant').value = 'base'; } S.others = []; fillAnims(); schedule(); if (serverApi) serverApi.followSpecies(); }
$('species').onchange = async (e) => {
  if (e.target.value === '__new__') {
    $('species').value = S.meta.species ? `${S.meta.species}|${S.meta.stage}` : '';
    const r = serverApi && await serverApi.addSpecies();
    if (!r) return;
    cfg.stages[String(r.stage)].species.push(r.id); // the server wrote the config; mirror it without a reload (FR-18)
    S.meta.species = r.id; S.meta.stage = r.stage; fillSpecies();
    note('ok', `Added species "${r.id}" to stage ${r.stage} (${r.stage_name}) in the config. Also record its display name in your project's species list.`);
    setSpecies(r.id, r.stage);
    return;
  }
  if (e.target.value === '__rename__') {
    $('species').value = S.meta.species ? `${S.meta.species}|${S.meta.stage}` : '';
    const r = serverApi && await serverApi.renameSpecies();
    if (!r) return;
    onRenamed(r);
    await serverApi.refresh();
    return;
  }
  if (e.target.value === '__remove__') {
    $('species').value = S.meta.species ? `${S.meta.species}|${S.meta.stage}` : '';
    const r = serverApi && await serverApi.removeSpecies();
    if (!r) return;
    const st = cfg.stages[String(r.stage)];
    st.species = st.species.filter((x) => x !== r.id); // mirror the config the server wrote (FR-21)
    if (S.meta.species === r.id) { const first = Object.entries(cfg.stages).find(([, s]) => s.species.length); if (first) { S.meta.species = first[1].species[0]; S.meta.stage = +first[0]; } }
    fillSpecies();
    note('ok', `Removed species "${r.id}" from the config${r.moved.length ? `; ${r.moved.length} leftover file(s) moved to ${r.removed_dir}` : ''}. Also record the change in your project's species list.`);
    setSpecies(S.meta.species, S.meta.stage);
    return;
  }
  const [sp, st] = e.target.value.split('|'); setSpecies(sp, +st);
};
$('variant').onchange = (e) => { S.meta.variant = e.target.value; S.others = []; fillAnims(); schedule(); if (serverApi) serverApi.followSpecies(); };
$('anim').onchange = (e) => { S.meta.anim = e.target.value; S.frame = 0; schedule(); };
$('unitId').oninput = (e) => { S.meta.unit_id = e.target.value.trim(); schedule(); };
$('frameStart').oninput = (e) => { S.meta.frame_start = Math.max(0, +e.target.value | 0); schedule(); };

$('modeNormal').onclick = () => { S.mode = 'normal'; setPressed(['modeNormal', 'modeDialog'], 'modeNormal'); drawEink(); };
$('modeDialog').onclick = () => { S.mode = 'dialog'; setPressed(['modeNormal', 'modeDialog'], 'modeDialog'); drawEink(); };
$('ancCanvas').onclick = () => { S.anchor = 'canvas'; setPressed(['ancCanvas', 'ancSprite'], 'ancCanvas'); drawEink(); };
$('ancSprite').onclick = () => { S.anchor = 'sprite'; setPressed(['ancCanvas', 'ancSprite'], 'ancSprite'); drawEink(); };
const step = (d) => { const n = currentOutputs().length; if (n) { S.frame = (S.frame + d + n) % n; drawSprite(); drawEink(); } };
$('prevF').onclick = () => step(-1);
$('nextF').onclick = () => step(1);
function setPlay(fps) {
  clearInterval(S.timer); S.play = S.play === fps ? 0 : fps;
  $('play1').setAttribute('aria-pressed', String(S.play === 1)); $('play2').setAttribute('aria-pressed', String(S.play === 2));
  if (S.play) S.timer = setInterval(() => step(1), 1000 / S.play);
}
$('play1').onclick = () => setPlay(1);
$('play2').onclick = () => setPlay(2);

let serverApi = null;
const runSafe = async (fn) => { try { await fn(); } catch (e) { note('fail', e.message); } };
const editor = initEditor({
  cfg, $, S, note, renderAll,
  confirm: (m, ok) => askConfirm($, m, ok), choose: (m, o) => choose($, m, o), run: runSafe,
  srv: () => serverApi, refreshGroups: (id) => (serverApi ? serverApi.refresh(id) : null),
});
if (S.server) serverApi = initServerMode({ S, cfg, $, note, schedule, renderAll, applyGroup, applyCleanFrames, buildFragment, editor, editUnit, setEditing, settingsOf, nextFreeUnit, onRenamed, choose: (m, o) => choose($, m, o), groupIdOf: (m) => groupId(m.species, m.stage, m.variant), loadBytes: (name, bytes) => loadFile(new File([bytes], name)) });
$('viewConv').onclick = () => editor.hide();
$('viewEdit').onclick = () => runSafe(async () => {
  if (editor.isOpen()) return editor.show();
  if (serverApi && $('groupSel').value) return serverApi.openEditor($('groupSel').value);
  note('warn', S.server ? 'Pick a group in the Group panel first.' : 'Drop clean PNG frames on the page to open them in the Clean Editor (unsaved sandbox).');
});
$('edSave').onclick = () => runSafe(() => editor.save(serverApi));
$('edReload').onclick = () => runSafe(async () => {
  if (!editor.isOpen()) return;
  if (!editor.E.server) { note('warn', 'Sandbox: drop the files again to reload them.'); return; }
  if (editor.E.dirty && !(await askConfirm($, `Discard your unsaved changes to ${editor.E.batchId} and load the files from disk?`, 'Discard and reload'))) return;
  try { localStorage.removeItem(`pp-draft:${editor.E.batchId}`); } catch { /* ignore */ }
  await editor.openServerGroup(serverApi, editor.E.batchId, { anim: editor.E.anim, quiet: true });
});
renderAll();

// Test hook (CI checks that the bundled core equals the CLI's core, FR-10 AC).
window.PixelPipe = { cfg, decodeImage, processUnit, placeUnits, state: S, editor, loadBytes: (name, bytes) => loadFile(new File([bytes], name)) };
