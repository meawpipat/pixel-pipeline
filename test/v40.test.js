// v3.9 (D17): project resolution (fixture 27), init (fixture 28), pages and publishability (fixture 29)
import { FIXTURE_CONFIG } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoot, CONFIG_NAME, PKG_ROOT } from '../src/cli/store.js';
import { cmdInit } from '../src/cli/init.js';

const CLI = path.join(PKG_ROOT, 'src/cli/index.js');
const tmp = (p = 'pp40-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** Run the CLI as a user would: no PP_CONFIG test hook. */
function cli(args, { cwd, env = {} } = {}) {
  const e = { ...process.env, ...env }; delete e.PP_CONFIG; if (!('PIXELPIPE_ROOT' in env)) delete e.PIXELPIPE_ROOT;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const project = (species = { 0: ['egg'], 1: ['blob'] }) => {
  const d = tmp('ppproj-');
  const cfg = JSON.parse(fs.readFileSync(FIXTURE_CONFIG, 'utf8'));
  for (const [k, st] of Object.entries(cfg.stages)) st.species = species[k] || [];
  fs.writeFileSync(path.join(d, CONFIG_NAME), JSON.stringify(cfg, null, 2) + '\n');
  return d;
};
const speciesOf = (d) => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(d, CONFIG_NAME), 'utf8')).stages).map(([k, s]) => [k, s.species]));
const walk = (d, r = '') => (fs.existsSync(d) ? fs.readdirSync(d).sort().flatMap((f) => (fs.statSync(path.join(d, f)).isDirectory() ? [`${r}${f}/`, ...walk(path.join(d, f), `${r}${f}/`)] : [`${r}${f}`])) : []);

test('fixture 27: resolveRoot — upward search, PIXELPIPE_ROOT, --root, refusals', () => {
  const a = project(), b = project();
  const sub = path.join(a, 'art/raw/x'); fs.mkdirSync(sub, { recursive: true });
  const env = {};
  assert.deepEqual(resolveRoot({ env, cwd: sub }), { root: a, source: 'search' });
  assert.deepEqual(resolveRoot({ env: { PIXELPIPE_ROOT: b }, cwd: sub }), { root: b, source: 'env' });
  assert.deepEqual(resolveRoot({ env: { PIXELPIPE_ROOT: '' }, cwd: sub }), { root: a, source: 'search' }, 'empty = unset');
  assert.deepEqual(resolveRoot({ rootOpt: b, env: { PIXELPIPE_ROOT: a }, cwd: sub }), { root: b, source: 'option' });
  assert.deepEqual(resolveRoot({ rootOpt: path.relative(sub, b), env, cwd: sub }).root, b, 'relative --root resolved against cwd');
  const none = tmp('ppnone-');
  assert.throws(() => resolveRoot({ rootOpt: none, env, cwd: sub }), /--root .* has no pixelpipe\.config\.json/);
  assert.throws(() => resolveRoot({ env: { PIXELPIPE_ROOT: none }, cwd: sub }), /PIXELPIPE_ROOT = .* has no pixelpipe\.config\.json/);
  assert.throws(() => resolveRoot({ env, cwd: none }), /no pixelpipe project found .*pixelpipe init/);
  // nested project: the nearest wins
  const inner = path.join(a, 'inner'); fs.mkdirSync(inner); fs.copyFileSync(path.join(a, CONFIG_NAME), path.join(inner, CONFIG_NAME));
  assert.equal(resolveRoot({ env, cwd: inner }).root, inner);
});

test('fixture 27: CLI — refuses outside a project and writes nothing; species-add writes the project config only; env root is announced', () => {
  const none = tmp('ppnone-');
  const before = walk(none);
  const r = cli(['species-add', 'fox', '--stage', '3'], { cwd: none });
  assert.notEqual(r.code, 0); assert.match(r.err, /no pixelpipe project found/);
  assert.deepEqual(walk(none), before);
  const exampleBefore = fs.readFileSync(FIXTURE_CONFIG, 'utf8');
  const p = project();
  const sub = path.join(p, 'art'); fs.mkdirSync(sub, { recursive: true });
  const ok = cli(['species-add', 'newbie', '--stage', '1'], { cwd: sub });
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(speciesOf(p)['1'], ['blob', 'newbie']);
  assert.equal(fs.readFileSync(FIXTURE_CONFIG, 'utf8'), exampleBefore, 'the tool example is never written');
  const viaEnv = cli(['species-add', 'other', '--stage', '1'], { cwd: none, env: { PIXELPIPE_ROOT: p } });
  assert.equal(viaEnv.code, 0, viaEnv.err); assert.match(viaEnv.err, /project .* \(from PIXELPIPE_ROOT\)/);
  const bad = cli(['validate', 'blob_s1'], { cwd: none, env: { PIXELPIPE_ROOT: none } });
  assert.notEqual(bad.code, 0); assert.match(bad.err, /PIXELPIPE_ROOT = .* has no/);
  assert.equal(cli([], { cwd: none }).code, 0, 'bare pixelpipe prints usage anywhere');
  assert.equal(cli(['help'], { cwd: none }).code, 0);
  const typo = cli(['bogus'], { cwd: none }); assert.equal(typo.code, 2); assert.match(typo.out, /pixelpipe <command>/, 'unknown command → usage, not a project error');
});

test('fixture 27: species-rename re-run against a different config is refused by sha_before', async () => {
  const { hooks, cmdSpeciesRename } = await import('../src/cli/rename.js');
  const { cmdArchiveBytes, cmdAddFragment } = await import('../src/cli/commands.js');
  const { makeSprite, LV } = await import('./fixtures.js');
  const { encodePng } = await import('../src/core/png.js');
  const p = project({ 1: ['blob'] });
  const saved = process.env.PP_CONFIG; delete process.env.PP_CONFIG;
  try {
    const s = makeSprite(18, 20, 7), F = 10, W = 20 * F, H = 23 * F, rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4 + 1] = 255; rgba[i * 4 + 3] = 255; }
    for (let y = 0; y < 20; y++) for (let x = 0; x < 18; x++) { const v = s.I[y * 18 + x]; if (v === 4) continue; for (let py = 0; py < F; py++) for (let px = 0; px < F; px++) { const q = (((y + 2) * F + py) * W + (1 + x) * F + px) * 4; rgba[q] = rgba[q + 1] = rgba[q + 2] = LV[v]; } }
    const a = cmdArchiveBytes(p, encodePng({ w: W, h: H, colorType: 6, bitDepth: 8, data: rgba }), 'blob');
    cmdAddFragment(p, { species: 'blob', stage: 1, variant: 'base', unit: { id: 'u1', source: a.path, source_sha256: a.sha256, anim: 'idle', frame_start: 0, strip: { n: 1 }, params: {} } });
    hooks.afterJson = () => { throw new Error('crash'); };
    try { assert.throws(() => cmdSpeciesRename(p, 'blob', 'blobby', { yes: true }), /crash/); } finally { hooks.afterJson = null; }
    // someone edits the config before the re-run → refused, nothing written to it
    const cfgFile = path.join(p, CONFIG_NAME);
    const edited = fs.readFileSync(cfgFile, 'utf8').replace('"config_version"', '"config_version_note": "x",\n  "config_version"');
    fs.writeFileSync(cfgFile, edited);
    assert.throws(() => cmdSpeciesRename(p, 'blob', 'blobby', { yes: true }), /config changed since the rename was planned/);
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), edited);
  } finally { process.env.PP_CONFIG = saved; }
});

test('fixture 27/29: serve uses the live project config; editing it does not rebuild the tool page', async () => {
  const { startServer, loadPage } = await import('../src/server/serve.js');
  loadPage();
  const stamp = path.join(PKG_ROOT, 'dist/pixel-tool.sources.sha256');
  const st0 = fs.statSync(stamp).mtimeMs, page0 = fs.statSync(path.join(PKG_ROOT, 'dist/pixel-tool.html')).mtimeMs;
  const p = project({ 1: ['blob'] });
  const saved = process.env.PP_CONFIG; delete process.env.PP_CONFIG;
  const srv = await startServer({ root: p, port: 0 });
  const get = (u) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.port, path: u, headers: { Host: `127.0.0.1:${srv.port}` } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(Buffer.concat(c).toString())); }).on('error', rej));
  try {
    assert.match(await get('/'), /"species":\["blob"\]/);
    const f = path.join(p, CONFIG_NAME);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"species": [\n          "blob"\n        ]', '"species": ["blob", "fresh"]').replace('"species": [ "blob" ]', '"species": ["blob", "fresh"]'));
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8')); cfg.stages['1'].species = ['blob', 'fresh']; fs.writeFileSync(f, JSON.stringify(cfg));
    const html = await get('/');
    assert.match(html, /"species":\["blob","fresh"\]/);
    assert.match(html, /"root":"ppproj-/);
    // POST /api/species writes the project config (PP_CONFIG unset), never the tool's example
    const exampleBefore = fs.readFileSync(FIXTURE_CONFIG, 'utf8');
    const token = /"token":"([0-9a-f]+)"/.exec(html)[1];
    const body = JSON.stringify({ id: 'viaserve', stage: 2 });
    const st = await new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/species', headers: { Host: `127.0.0.1:${srv.port}`, 'X-PP-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }); q.on('error', rej); q.end(body); });
    assert.equal(st, 200);
    assert.deepEqual(speciesOf(p)['2'], ['viaserve']);
    assert.equal(fs.readFileSync(FIXTURE_CONFIG, 'utf8'), exampleBefore);
    assert.equal(fs.statSync(stamp).mtimeMs, st0, 'no rebuild stamp change');
    assert.equal(fs.statSync(path.join(PKG_ROOT, 'dist/pixel-tool.html')).mtimeMs, page0, 'no rebuild');
  } finally { await srv.close(); process.env.PP_CONFIG = saved; }
});

test('fixture 28: init — new folder, refusal, existing art, nested warning, --root refused', () => {
  const base = tmp('ppinit-');
  const d = path.join(base, 'new/proj');
  const r = cmdInit(d);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, CONFIG_NAME), 'utf8'));
  const ex = JSON.parse(fs.readFileSync(FIXTURE_CONFIG, 'utf8'));
  for (const st of Object.values(ex.stages)) st.species = [];
  assert.deepEqual(cfg, ex, 'example with empty species lists');
  for (const k of ['source', 'raw', 'clean', 'export']) assert.ok(fs.statSync(path.join(d, 'art', k)).isDirectory());
  assert.match(fs.readFileSync(path.join(d, 'art/.gitignore'), 'utf8'), /_removed\//);
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /pixel-tool\.html/);
  assert.deepEqual(r.warnings, []);
  const snap = walk(d).map((f) => [f, f.endsWith('/') ? '' : fs.readFileSync(path.join(d, f), 'utf8')]);
  assert.throws(() => cmdInit(d), /already exists/);
  assert.deepEqual(walk(d).map((f) => [f, f.endsWith('/') ? '' : fs.readFileSync(path.join(d, f), 'utf8')]), snap, 'nothing changed');
  // a folder with only art/ (and a file in it): config created, existing files untouched
  const e = tmp('ppinit2-'); fs.mkdirSync(path.join(e, 'art/raw/x'), { recursive: true }); fs.writeFileSync(path.join(e, 'art/raw/x/keep.png'), 'k'); fs.writeFileSync(path.join(e, 'art/.gitignore'), 'mine\n'); fs.writeFileSync(path.join(e, '.gitignore'), 'mine\n');
  cmdInit(e);
  assert.equal(fs.readFileSync(path.join(e, 'art/raw/x/keep.png'), 'utf8'), 'k');
  assert.equal(fs.readFileSync(path.join(e, 'art/.gitignore'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(e, '.gitignore'), 'utf8'), 'mine\n');
  // art exists as a file → refused before anything is written
  const f = tmp('ppinit4-'); fs.writeFileSync(path.join(f, 'art'), 'x');
  assert.throws(() => cmdInit(f), /is not a folder/);
  assert.deepEqual(fs.readdirSync(f), ['art']);
  const ff = path.join(tmp('ppinit5-'), 'afile'); fs.writeFileSync(ff, 'x');
  assert.throws(() => cmdInit(ff), /exists and is not a folder \(nothing changed\)/);
  // inside a project → warning, created
  const n = cmdInit(path.join(d, 'nested'));
  assert.match(n.warnings[0], /already a pixelpipe project/);
  // CLI: works outside any project; --root refused
  const outside = tmp('ppinit3-');
  assert.equal(cli(['init', 'p1'], { cwd: outside }).code, 0);
  assert.ok(fs.existsSync(path.join(outside, 'p1', CONFIG_NAME)));
  const rr = cli(['init', '--root', 'x'], { cwd: outside });
  assert.notEqual(rr.code, 0); assert.match(rr.err, /use `pixelpipe init x`/);
});

test('fixture 29: page with project species and no notice; the tool page is the example; no fixture copy; repository hygiene', async () => {
  const p = project({ 0: ['egg'], 1: ['blob', 'zzproj'] });
  const r = cli(['page'], { cwd: p });
  assert.equal(r.code, 0, r.err);
  const html = fs.readFileSync(path.join(p, 'pixel-tool.html'), 'utf8');
  assert.match(html, /"zzproj"/); assert.match(html, /window\.PP_EXAMPLE = false/);
  const broken = tmp('ppbroken-'); fs.writeFileSync(path.join(broken, CONFIG_NAME), '{bad');
  const rb = cli(['page'], { cwd: broken }); assert.notEqual(rb.code, 0); assert.ok(!/at file:/.test(rb.err), 'no stack trace'); assert.ok(!fs.existsSync(path.join(broken, 'pixel-tool.html')));
  const dirCfg = tmp('ppdircfg-'); fs.mkdirSync(path.join(dirCfg, CONFIG_NAME));
  assert.throws(() => resolveRoot({ env: {}, cwd: dirCfg }), /no pixelpipe project found/);
  const out = path.join(tmp('pppage-'), 'x.html');
  assert.equal(cli(['page', '--out', out], { cwd: p }).code, 0);
  assert.ok(fs.existsSync(out));
  const { loadPage } = await import('../src/server/serve.js');
  const dist = loadPage();
  assert.match(dist, /window\.PP_EXAMPLE = true/);
  assert.ok(!/zzproj/.test(dist));
  assert.ok(!fs.existsSync(path.join(PKG_ROOT, 'test/fixture.config.json')), 'tests read the example directly');
  assert.ok(!fs.existsSync(path.join(PKG_ROOT, 'config/pixel_pipeline.config.json')), 'no project config in the tool');
  // tool messages use the generic wording (a project's own document names are checked by the project's pre-publish script)
  for (const f of ['src/cli/rename.js', 'src/tool/app.js', 'src/tool/template.html']) assert.match(fs.readFileSync(path.join(PKG_ROOT, f), 'utf8'), /your project's species list/, f);
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pixel-pipeline'); assert.equal(pkg.license, 'MIT');
  assert.ok(fs.existsSync(path.join(PKG_ROOT, 'LICENSE')));
  const git = spawnSync('git', ['ls-files'], { cwd: PKG_ROOT, encoding: 'utf8' });
  if (git.status === 0 && fs.existsSync(path.join(PKG_ROOT, '.git'))) {
    const files = git.stdout.split('\n').filter(Boolean);
    assert.ok(!files.some((f) => f.startsWith('art/') || f.endsWith(CONFIG_NAME)), 'no art/ and no project config tracked');
  }
});

test('fixture 29: a project with no species — the Species list offers only + New species… and Add explains why (Chromium)', async (t) => {
  let pw; try { pw = await import('playwright-core'); } catch { t.skip('playwright-core missing'); return; }
  let browser = null;
  for (const executablePath of [process.env.PP_CHROMIUM, undefined]) { try { browser = await pw.chromium.launch(executablePath ? { executablePath } : {}); break; } catch { /* next */ } }
  if (!browser) { t.skip('no Chromium'); return; }
  const p = tmp('ppempty-'); cmdInit(p);
  const saved = process.env.PP_CONFIG; delete process.env.PP_CONFIG;
  const { startServer, loadPage } = await import('../src/server/serve.js');
  const srv = await startServer({ root: p, port: 0, page: loadPage() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url);
    await page.waitForFunction(() => window.PP_SERVER && document.getElementById('species').options.length >= 1);
    assert.deepEqual(await page.evaluate(() => [...document.getElementById('species').options].map((o) => o.value)), ['', '__new__']);
    assert.equal(await page.evaluate(() => document.getElementById('species').selectedIndex), 0, 'placeholder shown, not a blank control');
    await page.waitForFunction(() => /No species in this project yet/.test(document.getElementById('messages').textContent));
    assert.ok(!/Example config/.test(await page.textContent('#messages')), 'no example notice in server mode');
    assert.deepEqual(errors, []);
  } finally { await srv.close(); await browser.close(); process.env.PP_CONFIG = saved; }
});
