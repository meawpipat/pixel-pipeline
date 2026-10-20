// FR-16 local workbench server: node:http on 127.0.0.1. Every endpoint calls a Node command
// function (the same ones the CLI uses); the server only translates HTTP ⇄ function calls.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { PKG_ROOT, loadConfig, readJson, sha256File, artPaths, safeJoin } from '../cli/store.js';
import { cmdArchiveBytes, cmdAddFragment, batchPath } from '../cli/commands.js';
import { cmdPromote, cmdRetranslate, cmdValidate, cmdExport } from '../cli/commands3.js';
import { loadPlacement, groupCleanFiles, placementPath, pendingMarker, rawContentHash } from '../cli/cleanstore.js';
import { cmdCleanSave, cmdCleanRestore } from '../cli/cleansave.js';
import { cmdSpeciesAdd } from '../cli/species.js';
import { cmdUnitRemove, cmdGroupRemove, cmdSpeciesRemove } from '../cli/remove.js';
import { cmdSpeciesRename, assertNoRename, renameMarkerPath } from '../cli/rename.js';
import { parseGroupId, groupId } from '../core/naming.js';
import { isGroupExportFile } from '../core/exportfmt.js';
import { TOOL_VERSION } from '../core/pipeline.js';

const MAX_BODY = 64 * 1024 * 1024; // NFR-06

class HttpError extends Error { constructor(status, body) { super(body.error || body.confirm || 'error'); this.status = status; this.body = body; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; return; } // keep draining without storing, answer 413 at the end
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, { error: `request body over ${MAX_BODY} bytes` }));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, { error: 'body must be JSON' })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(data);
}

/** Map command errors to HTTP (FR-16 responses). */
function errorResponse(e) {
  if (e instanceof HttpError) return [e.status, e.body];
  if (e.code === 'CONFIRM') return [409, { confirm: e.message }];
  if (e.code === 'CONFLICT') return [412, { conflict: e.conflict || [], error: e.message }];
  // programming errors stay visible as 500; rule refusals from commands are 422
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return [500, { error: `internal error: ${e.message}` }];
  return [422, { error: e.message }];
}

function listGroups(root) {
  const rawRoot = path.join(root, 'art', 'raw');
  if (!fs.existsSync(rawRoot)) return [];
  const out = [];
  for (const sp of fs.readdirSync(rawRoot)) {
    const d = path.join(rawRoot, sp);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.batch.json') && parseGroupId(f.replace(/\.batch\.json$/, ''))) out.push(f.replace(/\.batch\.json$/, ''));
  }
  // a group whose batch file a crashed group-remove already moved is still listed (FR-20), so the page can finish it
  const cleanRoot = path.join(root, 'art', 'clean');
  if (fs.existsSync(cleanRoot)) for (const sp of fs.readdirSync(cleanRoot)) {
    const d = path.join(cleanRoot, sp);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) { const id = f.replace(/\.remove\.pending\.json$/, ''); if (f.endsWith('.remove.pending.json') && parseGroupId(id) && !out.includes(id)) out.push(id); }
  }
  return out.sort();
}

function groupSummary(root, id) {
  const g = parseGroupId(id);
  const dirs = artPaths(root, g.species);
  const batch = readJson(batchPath(root, id));
  let v;
  try { v = cmdValidate(root, id); } catch (e) { v = { fails: [e.message], warns: [] }; }
  return {
    batch_id: id, species: g.species, stage: g.stage, variant: g.variant,
    raw_frames: batch.units.reduce((n, u) => n + u.frames.length, 0),
    clean_frames: groupCleanFiles(dirs.clean, id).length,
    exported: fs.existsSync(dirs.export) && fs.readdirSync(dirs.export).some((f) => isGroupExportFile(f, id)),
    validator: { fails: v.fails.length, warns: v.warns.length },
  };
}

function groupDetail(root, id) {
  const g = parseGroupId(id);
  if (!g) throw new HttpError(400, { error: `invalid batch id ${id}` });
  const bp = batchPath(root, id);
  const dirs = artPaths(root, g.species);
  if (!fs.existsSync(bp)) {
    // a crashed group-remove already moved the batch file: report only what is pending (FR-20)
    const m = pendingMarker(dirs.clean, id);
    if (m && m.kind === 'group-remove') return { batch: null, sidecars: {}, placement: null, placement_sha256: null, raw: [], clean: [], raw_changed: [], notes: {}, validator: { fails: [`${id}: interrupted group-remove — run it again to finish it`], warns: [], infos: [] }, pending: { kind: m.kind, trash: null, args: m.data.args || null, via_unit: m.data.via_unit || null } };
    throw new HttpError(404, { error: `no group ${id}` });
  }
  const batch = readJson(bp);
  const files = (dir, names) => names.filter((n) => fs.existsSync(path.join(dir, n))).map((n) => ({ name: n, sha256: sha256File(path.join(dir, n)) }));
  const rawNames = batch.units.flatMap((u) => u.frames.map((f) => f.name));
  const sidecars = {};
  for (const u of batch.units) for (const f of u.frames) {
    const p = path.join(root, f.sidecar);
    if (fs.existsSync(p)) sidecars[f.name] = readJson(p);
  }
  const { placement, exists } = loadPlacement(dirs.clean, dirs.raw, id);
  const pp = placementPath(dirs.clean, id);
  return {
    batch, sidecars,
    placement: exists ? placement : null,
    placement_sha256: fs.existsSync(pp) ? sha256File(pp) : null,
    pending: (() => { const m = pendingMarker(dirs.clean, id); return m ? { kind: m.kind, trash: (m.data && m.data.trash) || null, args: (m.data && m.data.args) || null, via_unit: (m.data && m.data.via_unit) || null } : null; })(),
    raw_changed: rawChanged(dirs, placement),
    notes: Object.fromEntries(groupCleanFiles(dirs.clean, id).filter((n) => fs.existsSync(path.join(dirs.clean, n.replace(/\.png$/, '.notes.json')))).map((n) => { try { return [n, readJson(path.join(dirs.clean, n.replace(/\.png$/, '.notes.json')))]; } catch { return [n, null]; } })),
    raw: files(dirs.raw, rawNames),
    clean: files(dirs.clean, groupCleanFiles(dirs.clean, id)),
    validator: cmdValidate(root, id),
  };
}

/** FR-16 v3.4: clean files with a "raw changed" WARN (entry hash null or ≠ current raw content). */
function rawChanged(dirs, placement) {
  const out = [];
  for (const [clean, e] of Object.entries(placement.files)) {
    if (e.origin !== 'raw' || !e.raw_name || !fs.existsSync(path.join(dirs.raw, e.raw_name)) || !fs.existsSync(path.join(dirs.clean, clean))) continue;
    if (e.raw_content_sha256 == null) out.push({ clean, raw_name: e.raw_name, recorded_null: true });
    else if (e.raw_content_sha256 !== rawContentHash(dirs.raw, e.raw_name)) out.push({ clean, raw_name: e.raw_name, recorded_null: false });
  }
  return out;
}

const MIME = { '.png': 'image/png', '.json': 'application/json', '.h': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream' };

/**
 * Start the server. Returns { server, url, token, port, close() }.
 * opts: { root, port = 4870, page?: string (HTML with the /*__SERVER__*\/ placeholder) }
 */
export async function startServer({ root, port = 4870, page = null } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const getPage = () => page ?? loadPage(); // rebuilt only when the tool sources or the example config change (FR-29)
  getPage();
  let queue = Promise.resolve(); // serialised writes
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const handler = async (req, res) => {
    const actualPort = server.address().port;
    const okHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    try {
      // NFR-06: Host (DNS rebinding) and Origin (CSRF) checks on every request.
      if (!okHosts.includes(req.headers.host || '')) throw new HttpError(403, { error: 'bad Host' });
      const origin = req.headers.origin;
      if (origin !== undefined && !okHosts.map((h) => `http://${h}`).includes(origin)) throw new HttpError(403, { error: 'bad Origin' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) throw new HttpError(404, { error: 'not found' });
        const pageHtml = getPage().replace('/*__SERVER__*/null', () => JSON.stringify({ token, root: path.basename(root), config: loadConfig(root) }).replace(/</g, '\\u003c'));
        return send(res, 200, pageHtml, 'text/html; charset=utf-8');
      }
      const t = req.headers['x-pp-token'] || '';
      if (!/^[0-9a-f]{32}$/.test(t) || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) throw new HttpError(401, { error: 'missing or wrong X-PP-Token' });

      const route = `${req.method} ${url.pathname}`;
      if (req.method === 'GET') {
        if (route === 'GET /api/state') {
          const cfg = loadConfig(root);
          const ids = listGroups(root);
          const withGroups = new Set(ids.map((id) => parseGroupId(id).species));
          const species_removable = Object.values(cfg.stages).flatMap((st) => st.species).filter((sp) => !withGroups.has(sp));
          return send(res, 200, { mode: 'server', tool_version: TOOL_VERSION, root: path.basename(root), config: cfg, species_removable, rename_pending: (() => { try { const m = readJson(renameMarkerPath(root)); return { old: m.old, new: m.new }; } catch { return null; } })(), groups: ids.map((id) => { try { return groupSummary(root, id); } catch (e) { return { batch_id: id, error: e.message, raw_frames: 0, clean_frames: 0, exported: false, validator: { fails: 1, warns: 0 } }; } }) });
        }
        if (url.pathname.startsWith('/api/group/')) return send(res, 200, groupDetail(root, decodeURIComponent(url.pathname.slice('/api/group/'.length))));
        if (route === 'GET /api/file') {
          const rel = url.searchParams.get('path') || '';
          const abs = safeJoin(root, rel, 'art');
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, { error: `no file ${rel}` });
          return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs)] || 'application/octet-stream');
        }
        throw new HttpError(404, { error: 'not found' });
      }
      if (req.method !== 'POST') throw new HttpError(405, { error: 'method not allowed' });
      const body = await readBody(req);
      const result = await serial(() => {
        if (route !== 'POST /api/species/rename' && route !== 'POST /api/validate') assertNoRename(root); // FR-26 central check
        switch (route) {
          case 'POST /api/archive': {
            if (typeof body.bytes_b64 !== 'string') throw new HttpError(400, { error: 'bytes_b64 required' });
            return cmdArchiveBytes(root, new Uint8Array(Buffer.from(body.bytes_b64, 'base64')), body.species, { allowExisting: true });
          }
          case 'POST /api/add': {
            const frag = body.fragment;
            if (!frag || typeof frag !== 'object') throw new HttpError(400, { error: 'fragment required' });
            let before = null, hadClean = false;
            try {
              const id = frag.batch_id || groupId(frag.species, Number(frag.stage), frag.variant || 'base');
              const bp = batchPath(root, id);
              if (fs.existsSync(bp)) before = readJson(bp).T;
              const g = parseGroupId(id);
              hadClean = g && groupCleanFiles(artPaths(root, g.species).clean, id).length > 0;
            } catch { /* invalid ids are reported by add itself */ }
            const added = cmdAddFragment(root, frag, { yes: !!body.yes });
            const out = { added: true, report: added, retranslate_needed: hadClean && before !== null && JSON.stringify(before) !== JSON.stringify(added.T) };
            try { out.promote = cmdPromote(root, added.batch_id, { anim: frag.unit && frag.unit.anim }); } catch (e) { out.promote_error = e.message; }
            return out;
          }
          case 'POST /api/promote':
            for (const k of ['batch_id', 'anim', 'force', 'to', 'adopt', 'accept_raw']) if (body[k] != null && typeof body[k] !== 'string') throw new HttpError(400, { error: `${k} must be a string` });
            return cmdPromote(root, body.batch_id, { anim: body.anim || null, force: body.force || null, to: body.to || null, adopt: body.adopt || null, acceptRaw: body.accept_raw || null, yes: !!body.yes });
          case 'POST /api/retranslate': return cmdRetranslate(root, body.batch_id, { yes: !!body.yes });
          case 'POST /api/validate': return cmdValidate(root, body.batch_id, { raw: !!body.raw });
          case 'POST /api/export': return cmdExport(root, body.batch_id, { formats: body.formats || 'h,bin,png' });
          case 'POST /api/clean/save':
            if (typeof body.batch_id !== 'string' || !body.payload || typeof body.payload !== 'object') throw new HttpError(400, { error: 'batch_id and payload required' });
            return cmdCleanSave(root, body.batch_id, body.payload, { yes: !!body.yes });
          case 'POST /api/species':
            if (typeof body.id !== 'string' || !(typeof body.stage === 'number' || typeof body.stage === 'string')) throw new HttpError(400, { error: 'id (string) and stage required' });
            return cmdSpeciesAdd(root, body.id, body.stage);
          case 'POST /api/unit/remove':
            for (const k of ['batch_id', 'unit_id']) if (typeof body[k] !== 'string') throw new HttpError(400, { error: `${k} required` });
            if (body.edited != null && typeof body.edited !== 'string') throw new HttpError(400, { error: 'edited must be a string' });
            return cmdUnitRemove(root, body.batch_id, body.unit_id, { edited: body.edited || 'keep', yes: !!body.yes });
          case 'POST /api/group/remove':
            if (typeof body.batch_id !== 'string') throw new HttpError(400, { error: 'batch_id required' });
            return cmdGroupRemove(root, body.batch_id, { yes: !!body.yes });
          case 'POST /api/species/rename':
            if (typeof body.old !== 'string' || typeof body.new !== 'string') throw new HttpError(400, { error: 'old and new required' });
            return cmdSpeciesRename(root, body.old, body.new, { yes: !!body.yes });
          case 'POST /api/species/remove':
            if (typeof body.id !== 'string') throw new HttpError(400, { error: 'id required' });
            return cmdSpeciesRemove(root, body.id, { yes: !!body.yes });
          case 'POST /api/clean/restore':
            if (typeof body.batch_id !== 'string') throw new HttpError(400, { error: 'batch_id required' });
            return cmdCleanRestore(root, body.batch_id, { yes: !!body.yes });
          default: throw new HttpError(404, { error: 'not found' });
        }
      });
      return send(res, 200, result);
    } catch (e) {
      const [status, b] = errorResponse(e);
      return send(res, status, b);
    }
  };

  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((resolve, reject) => {
    const tryListen = (p, left) => {
      server.once('error', (err) => { if (err.code === 'EADDRINUSE' && left > 0) tryListen(p + 1, left - 1); else reject(err); });
      server.listen(p, '127.0.0.1', resolve);
    };
    tryListen(port, port === 0 ? 0 : 20);
  });
  const actual = server.address().port;
  return { server, token, port: actual, url: `http://127.0.0.1:${actual}/`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * The built tool page; builds it first if it is missing or was built from different sources.
 * Staleness is a hash of the sources (not mtimes), so unzipping or copying older files is detected too.
 */
export function loadPage() {
  const dist = path.join(PKG_ROOT, 'dist/pixel-tool.html');
  const stamp = path.join(PKG_ROOT, 'dist/pixel-tool.sources.sha256');
  const list = (d, re) => (fs.existsSync(path.join(PKG_ROOT, d)) ? fs.readdirSync(path.join(PKG_ROOT, d)).filter((f) => re.test(f)).sort().map((f) => path.join(PKG_ROOT, d, f)) : []);
  const srcs = [...list('src/tool', /\.(js|html)$/), ...list('src/core', /\.js$/), path.join(PKG_ROOT, 'config/example.config.json')]; // FR-29: example config only; the live project config is injected per request
  const h = crypto.createHash('sha256');
  h.update('example\0'); // FR-29: the stamp covers the --example build mode too
  for (const s of srcs) h.update(path.relative(PKG_ROOT, s)).update('\0').update(fs.readFileSync(s)).update('\0');
  const want = h.digest('hex');
  const have = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null;
  if (!fs.existsSync(dist) || have !== want) {
    execFileSync(process.execPath, [path.join(PKG_ROOT, 'src/tool/build.js'), '--example'], { stdio: 'inherit' });
    fs.writeFileSync(stamp, want + '\n');
  }
  return fs.readFileSync(dist, 'utf8');
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print only */ }
}
