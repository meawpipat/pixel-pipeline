// Orchestration shared by the CLI and the browser tool:
// one unit (strip or single image) → frames; a group of units → placed 64x64 canvases.
import { TRANSPARENT, hexToRgb, pixelHash } from './config.js';
import { cropRoi, autoKey, keyImage } from './key.js';
import { edgeProfiles, detectAxis } from './grid.js';
import { sampleCells, sampleFallback } from './sample.js';
import { quantize, autoThresholds, ditherRatio } from './quantize.js';
import { cellRangeInRoi, splitStrip, removeStray, strayPixels, outlineRatio, addOutline } from './frame.js';
import { unitReference, frameG, placeGroup, renderToCanvas } from './place.js';
import { frameName, groupId, checkMembership } from './naming.js';
import { encodePng } from './png.js';

export const TOOL_VERSION = '0.1.0';

/** Parameters every unit needs (sidecar "processing" fields). */
export const PARAM_KEYS = ['roi', 'key', 'tolerance', 'flood_fill', 'grid', 'fallback_target_h', 'thresholds', 'stray_removal', 'auto_outline'];

/**
 * Run FR-02…FR-09 on one unit.
 * params: { roi, key?, tolerance, flood_fill, grid?: {x:{period,phase,snapping}, y:{…}}, fallback_target_h?,
 *           thresholds?, stray_removal, auto_outline }, strip: { n, dividers? }
 * When key / grid / thresholds are missing they are auto-detected and returned in `resolved`.
 */
export function processUnit(img, params, strip, cfg, cache = null) {
  const P = cfg.processing;
  const warnings = [];
  // Optional memo (browser tool): same code path, cached by the exact inputs of each stage.
  const memo = (k, fn) => {
    if (!cache) return fn();
    if (!cache.has(k)) cache.set(k, fn());
    return cache.get(k);
  };
  const roi = params.roi || { x: 0, y: 0, w: img.w, h: img.h };
  const cropKey = 'crop:' + JSON.stringify(roi);
  const crop = memo(cropKey, () => cropRoi(img, roi));
  const key = params.key || memo(cropKey + ':autokey', () => autoKey(crop));
  if (!key) throw new Error('could not determine key colour');
  const keyKey = cropKey + ':key:' + JSON.stringify([key, params.tolerance ?? P.key_tolerance_default, params.flood_fill !== false]);
  const keyed = memo(keyKey, () => keyImage(crop, { key, tolerance: params.tolerance ?? P.key_tolerance_default, floodFill: params.flood_fill !== false, minIsland: P.min_island_px }));

  const sampled = memo(keyKey + ':grid:' + JSON.stringify([params.grid || null, params.fallback_target_h || null]), () => {
    const w = [];
    if (params.fallback_target_h) {
      w.push('Fallback mode: expect heavy cleanup');
      return { nat: sampleFallback(keyed, params.fallback_target_h, { cellAlphaMin: P.cell_alpha_min }), grid: null, confidence: null, lines: null, warnings: w };
    }
    const { gx, gy } = edgeProfiles(keyed);
    const g = params.grid || {};
    const range = P.grid_auto_period_range || [4, 64];
    const ax = detectAxis(gx, g.x || {}, range);
    const ay = detectAxis(gy, g.y || {}, range);
    if (!ax.lines.length || !ay.lines.length) throw new Error('no grid found — use Fallback mode');
    const confidence = Math.min(ax.confidence, ay.confidence);
    if (confidence < P.grid_confidence_min) w.push(`No reliable grid (confidence ${confidence.toFixed(2)}) — check overlay or use Fallback mode`);
    const grid = {
      x: { period: ax.period, phase: ax.phase, snapping: (g.x || {}).snapping !== false },
      y: { period: ay.period, phase: ay.phase, snapping: (g.y || {}).snapping !== false },
    };
    const [xa, xb] = cellRangeInRoi(ax.lines, keyed.w), [ya, yb] = cellRangeInRoi(ay.lines, keyed.h);
    const lx = ax.lines.slice(xa, xb + 2), ly = ay.lines.slice(ya, yb + 2);
    return { nat: sampleCells(keyed, lx, ly, { cellAlphaMin: P.cell_alpha_min }), grid, confidence, lines: { x: lx, y: ly, roiOffset: [roi.x, roi.y] }, warnings: w };
  });
  const { nat, grid, confidence, lines } = sampled;
  warnings.push(...sampled.warnings);
  const thresholds = params.thresholds || P.thresholds_default;
  const q = quantize(nat, thresholds);
  const dr = ditherRatio(q);
  if (dr > P.dither_detect_ratio) warnings.push(`Input contains dithering (${(dr * 100).toFixed(1)}% of opaque pixels)`);

  const n = strip && strip.n ? strip.n : 1;
  const split = splitStrip(q, n, strip && strip.dividers, strip && strip.use);
  if (n > 1) {
    const b = [0, ...split.dividers, q.w], widths = b.slice(1).map((v, i) => v - b[i]);
    if (new Set(widths).size > 1) warnings.push(`strip segments have unequal widths (${widths.join(', ')} cells) — frames may shift; fit the ROI to the strip or adjust dividers`);
  }
  const frames = split.frames.map((f, i) => {
    let fr = f;
    const stray = strayPixels(fr);
    if (params.stray_removal) fr = removeStray(fr);
    if (!fr.I.some((v) => v !== TRANSPARENT)) {
      if (strip && strip.use && !strip.use.includes(i)) return { ...fr, stray }; // an unused empty segment (FR-23)
      if (i > 0) throw new Error(`segment ${i} is empty${params.stray_removal ? ' after stray removal' : ''}`);
    }
    if (strip && strip.use && !strip.use.includes(i)) return { ...fr, stray }; // unused: never output, no warnings
    const ratio = outlineRatio(fr);
    if (ratio > P.outline_warn_ratio) warnings.push(`frame ${i}: Open/grey outline (${(ratio * 100).toFixed(0)}% of edge pixels not black)`);
    if (params.auto_outline) fr = addOutline(fr);
    return { ...fr, stray };
  });
  return {
    frames,
    native: q,
    nat,
    warnings,
    resolved: { key, grid, lines, thresholds, dividers: split.dividers, confidence, autoThresholds: () => autoThresholds(nat, P.auto_merge_luma).thresholds },
  };
}

/**
 * Place a group. units: [{ def: { dx, dy, anim, frame_start, use? }, frames }] — frames = every strip segment;
 * def.use = the used segment indices (FR-23, default all). Names are positional over the used segments.
 * The unit's reference point always comes from segment 0 (FR-13).
 * Returns { U, T, exceedsBox, blocked, outputs: [{ unitIndex, segment, name, canvas }] }.
 */
export function placeUnits(units, { species, stage, variant }, cfg) {
  const err = checkMembership(cfg, species, stage, variant);
  if (err) throw new Error(err);
  const box = cfg.stages[String(stage)].box;
  const items = [];
  units.forEach((u, ui) => {
    const ref = unitReference(u.frames[0]);
    const use = u.def.use || u.frames.map((_, s) => s);
    use.forEach((s, i) => items.push({ ui, s, i, frame: u.frames[s], g: frameG(u.frames[s], ref, u.def.dx || 0, u.def.dy || 0) }));
  });
  const pl = placeGroup(items, { canvas: cfg.canvas, baselineY: cfg.baseline_y, box });
  if (pl.blocked) return { ...pl, outputs: [] };
  const outputs = items.map((it) => ({
    unitIndex: it.ui,
    segment: it.s,
    g: it.g,
    name: frameName(species, stage, variant, units[it.ui].def.anim, (units[it.ui].def.frame_start || 0) + it.i),
    canvas: renderToCanvas(it.frame, it.g, pl.T, cfg.canvas),
  }));
  const names = new Set();
  for (const o of outputs) { if (names.has(o.name)) throw new Error(`duplicate output name ${o.name}`); names.add(o.name); }
  return { ...pl, outputs };
}

/** FR-11 canonical PNG bytes for a 64x64 index canvas. */
export function encodeCanonical(canvas, cfg) {
  const palette = cfg.palette.map(hexToRgb).concat([hexToRgb(cfg.transparent.rgb)]);
  return encodePng({ w: canvas.w, h: canvas.h, colorType: 3, bitDepth: 8, data: canvas.I, palette, trns: [255, 255, 255, 255, 0] });
}

/** Sidecar object for one frame (FR-11). */
export function makeSidecar({ batchId, unit, params, segment, index = segment, name, species, stage, variant, exceedsBox, cfg }) {
  const p = Object.fromEntries(PARAM_KEYS.map((k) => [k, params[k] ?? null]));
  return {
    tool_version: TOOL_VERSION,
    pixel_hash: pixelHash(cfg),
    batch_id: batchId,
    unit_id: unit.id,
    segment,
    name,
    species, stage, variant,
    anim: unit.anim,
    frame: (unit.frame_start || 0) + index, // positional over used segments (FR-23)
    source: unit.source,
    source_sha256: unit.source_sha256,
    ...p,
    flags: { fallback: !!params.fallback_target_h, auto_outline: !!params.auto_outline, exceeds_box: !!exceedsBox },
  };
}

export { groupId, TRANSPARENT };
