// FR-28 `pixelpipe init [DIR]` and FR-29 `pixelpipe page` (v3.9, D17).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PKG_ROOT, CONFIG_NAME, EXAMPLE_CONFIG, configPath, loadConfig } from './store.js';
import { checkConfig } from '../core/config.js';

const ART_GITIGNORE = `# pixelpipe: local-only files (crash markers, temp files, replaced and removed work)
clean/*/.trash/
*.pending.json
*.tmp
_removed/
`;

/**
 * Create a project in `dir`: config = the example with every species list emptied, art/ folders, art/.gitignore,
 * and a root .gitignore (pixel-tool.html) only if the project has none. Never changes an existing file.
 */
export function cmdInit(dir) {
  const root = path.resolve(dir);
  const warnings = [];
  for (let d = path.dirname(root); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, CONFIG_NAME))) { warnings.push(`${d} is already a pixelpipe project; this project will shadow it when you work inside ${root}`); break; }
    if (path.dirname(d) === d) break;
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error(`${root} exists and is not a folder (nothing changed)`);
  fs.mkdirSync(root, { recursive: true });
  for (const rel of ['art', 'art/source', 'art/raw', 'art/clean', 'art/export']) {
    const d = path.join(root, rel);
    if (fs.existsSync(d) && !fs.statSync(d).isDirectory()) throw new Error(`${d} exists and is not a folder — move it away, then run init again (nothing changed)`);
  }
  const cfg = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
  for (const st of Object.values(cfg.stages)) st.species = [];
  checkConfig(cfg);
  const text = fs.readFileSync(EXAMPLE_CONFIG, 'utf8').replace(/("species"\s*:\s*)\[[^\]]*\]/g, '$1[]');
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(cfg)) throw new Error('internal: could not empty the example species lists');
  try {
    fs.writeFileSync(path.join(root, CONFIG_NAME), text, { flag: 'wx' }); // exclusive: refuses if it exists, even in a race
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${path.join(root, CONFIG_NAME)} already exists — this folder is already a project (nothing changed)`);
    throw e;
  }
  const created = [CONFIG_NAME];
  for (const k of ['source', 'raw', 'clean', 'export']) {
    const d = path.join(root, 'art', k);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); created.push(`art/${k}/`); }
  }
  const writeIfAbsent = (rel, body) => { try { fs.writeFileSync(path.join(root, rel), body, { flag: 'wx' }); created.push(rel); } catch (e) { if (e.code !== 'EEXIST') throw e; } };
  writeIfAbsent('art/.gitignore', ART_GITIGNORE);
  writeIfAbsent('.gitignore', '# pixelpipe page (derived; rebuild with `pixelpipe page`)\npixel-tool.html\n');
  return {
    root, created, warnings,
    next: ['add species: pixelpipe species-add <id> --stage N (or + New species… in the page)', 'start the workbench: pixelpipe serve'],
  };
}

/** FR-29: offline (file-mode) page with this project's config. */
export function cmdPage(root, { out = null } = {}) {
  loadConfig(root); // the normal config check first (a broken config must not reach the page build)
  const file = path.resolve(out || path.join(root, 'pixel-tool.html'));
  execFileSync(process.execPath, [path.join(PKG_ROOT, 'src/tool/build.js'), '--config', configPath(root), '--out', file], { stdio: 'pipe' });
  return { page: file, config: configPath(root) };
}
