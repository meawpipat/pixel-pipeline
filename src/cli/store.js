// Filesystem helpers for the CLI (the only place that touches disk).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkConfig } from '../core/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(here, '../..');

export const CONFIG_NAME = 'pixelpipe.config.json';
export const EXAMPLE_CONFIG = path.join(PKG_ROOT, 'config/example.config.json');

/** FR-27: the project's config file. PP_CONFIG (test hook only) wins; otherwise {root}/pixelpipe.config.json. */
export function configPath(root) {
  if (process.env.PP_CONFIG) return process.env.PP_CONFIG;
  if (!root) throw new Error('internal: configPath needs the project root');
  return path.join(root, CONFIG_NAME);
}

export function loadConfig(root) {
  return checkConfig(JSON.parse(fs.readFileSync(configPath(root), 'utf8')));
}

/**
 * FR-27 root resolution: --root > PIXELPIPE_ROOT (empty = unset) > nearest folder upward from cwd holding the config.
 * Returns { root, source: 'option'|'env'|'search' }. Throws with a message naming what to do.
 */
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export function resolveRoot({ rootOpt = null, env = process.env, cwd = process.cwd() } = {}) {
  const hasCfg = (d) => isFile(path.join(d, CONFIG_NAME)) || !!env.PP_CONFIG;
  if (rootOpt) {
    const d = path.resolve(cwd, rootOpt);
    if (!hasCfg(d)) throw new Error(`--root ${d} has no ${CONFIG_NAME} — run \`pixelpipe init ${d}\` or point --root at a project`);
    return { root: d, source: 'option' };
  }
  if (env.PIXELPIPE_ROOT) {
    const d = path.resolve(cwd, env.PIXELPIPE_ROOT);
    if (!hasCfg(d)) throw new Error(`PIXELPIPE_ROOT = ${d} has no ${CONFIG_NAME} — fix or unset PIXELPIPE_ROOT`);
    return { root: d, source: 'env' };
  }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (isFile(path.join(d, CONFIG_NAME))) return { root: d, source: 'search' };
    if (path.dirname(d) === d) break;
  }
  throw new Error(`no pixelpipe project found from ${cwd} — cd into a project, set PIXELPIPE_ROOT, pass --root, or run \`pixelpipe init\``);
}

export const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const sha256Bytes = (b) => createHash('sha256').update(b).digest('hex');

export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

export function artPaths(root, species) {
  const a = (k) => path.join(root, 'art', k, species);
  return { source: a('source'), raw: a('raw'), clean: a('clean'), export: a('export') };
}

/** Resolve a repo-relative path and refuse anything escaping the allowed directory. */
export function safeJoin(root, rel, allowedDir) {
  if (typeof rel !== 'string' || rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`unsafe path: ${rel}`);
  }
  const abs = path.resolve(root, rel);
  const allow = path.resolve(root, allowedDir) + path.sep;
  if (!abs.startsWith(allow)) throw new Error(`path ${rel} must be inside ${allowedDir}/`);
  return abs;
}
