// FR-18 species-add: append a species id to stages[N].species in the config, keeping the file's hand formatting.
import fs from 'node:fs';
import { configPath as projectConfigPath } from './store.js';
import { writeAtomic } from './cleanstore.js';
import { checkConfig } from '../core/config.js';

export const SPECIES_RE = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$/;

export function checkSpeciesId(id, cfg) {
  if (typeof id !== 'string' || !SPECIES_RE.test(id)) return `species id "${id}" must be lowercase letters and digits in _-separated parts, each starting with a letter (e.g. fire_egg)`;
  if (id.length > 24) return `species id "${id}" is longer than 24 characters`;
  if (id.split('_').some((seg) => /^s[0-9]+$/.test(seg))) return `species id "${id}" has a part like "s1", which would make filenames ambiguous`;
  for (const [st, s] of Object.entries(cfg.stages)) if (s.species.includes(id)) return `species "${id}" already exists (stage ${st})`;
  return null;
}

/** Returns { id, stage, config_path, rewritten: 'line' | 'full' }. Throws on any rule violation. */
export function cmdSpeciesAdd(root, id, stage, { configPath = projectConfigPath(root) } = {}) {
  const text = fs.readFileSync(configPath, 'utf8');
  const cfg = checkConfig(JSON.parse(text));
  const n = typeof stage === 'string' && /^[0-9]+$/.test(stage) ? Number(stage) : stage;
  if (!Number.isInteger(n) || !Object.prototype.hasOwnProperty.call(cfg.stages, String(n))) throw new Error(`stage must be one of ${Object.keys(cfg.stages).join(', ')}`);
  const err = checkSpeciesId(id, cfg);
  if (err) throw new Error(err);
  const want = JSON.parse(text);
  want.stages[String(n)].species.push(id);
  // textual edit of the one "species": [ … ] array inside stage N, verified by parsing
  let out = null, mode = 'full';
  const stageRe = new RegExp(`("${n}"\\s*:\\s*\\{[^{}]*?"species"\\s*:\\s*\\[)([^\\]]*)(\\])`, 'g');
  const hits = [...text.matchAll(stageRe)];
  if (hits.length === 1) {
    const h = hits[0];
    const inner = h[2];
    const sep = inner.trim() ? `${inner.replace(/\s+$/, '')}, ` : '';
    const trailing = inner.match(/\s*$/)[0];
    const cand = text.slice(0, h.index) + h[1] + sep + JSON.stringify(id) + trailing + h[3] + text.slice(h.index + h[0].length);
    try { if (JSON.stringify(JSON.parse(cand)) === JSON.stringify(want)) { out = cand; mode = 'line'; } } catch { /* fall back */ }
  }
  if (!out) out = JSON.stringify(want, null, 2) + '\n';
  checkConfig(JSON.parse(out));
  writeAtomic(configPath, out);
  return { id, stage: n, stage_name: cfg.stages[String(n)].name, config_path: configPath, rewritten: mode };
}
