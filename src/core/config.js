// Config helpers (§2). The config object itself is loaded by the caller
// (fs in the CLI, inlined at build time in the browser tool).
import { sha256 } from './sha256.js';

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Integer Rec.601 luma (§2.1): (299R + 587G + 114B + 500) div 1000. */
export function luma(r, g, b) {
  return Math.floor((299 * r + 587 * g + 114 * b + 500) / 1000);
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** §2.6 pixel_hash over pixel-affecting keys only. */
export function pixelHash(cfg) {
  const p = cfg.processing;
  const subset = {
    canvas: cfg.canvas,
    palette: cfg.palette,
    luma: cfg.luma,
    baseline_y: cfg.baseline_y,
    boxes: Object.fromEntries(Object.entries(cfg.stages).map(([k, s]) => [k, s.box])),
    transparent: cfg.transparent,
    processing: { min_island_px: p.min_island_px, cell_alpha_min: p.cell_alpha_min, auto_merge_luma: p.auto_merge_luma },
  };
  return sha256(canonical(subset));
}

export const TRANSPARENT = 4;

/** Fail fast if the config asks for something this code does not implement (NFR-05). */
export function checkConfig(cfg) {
  const L = cfg.luma || {};
  if (L.wr !== 299 || L.wg !== 587 || L.wb !== 114 || L.div !== 1000 || L.round !== 500) {
    throw new Error('config.luma differs from the implemented Rec.601 integer formula (299/587/114, +500, div 1000); update src/core/config.js luma() together with the config');
  }
  if (cfg.transparent.index !== TRANSPARENT) throw new Error('config.transparent.index must be 4');
  if (cfg.palette.length !== 4) throw new Error('config.palette must have exactly 4 entries');
  return cfg;
}
