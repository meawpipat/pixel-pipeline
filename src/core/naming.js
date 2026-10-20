// FR-11 filenames, §2.2 species/stage membership, §2.8 animation budget.

export const NAME_RE = /^([a-z0-9]+(?:_[a-z0-9]+)*)_s([0-4])(-fat)?_([a-z0-9]+)_(\d{2})\.png$/;
export const BATCH_RE = /^([a-z0-9]+(?:_[a-z0-9]+)*)_s([0-4])(-fat)?$/;

export function parseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return { species: m[1], stage: Number(m[2]), variant: m[3] ? 'fat' : 'base', anim: m[4], frame: Number(m[5]) };
}

export function groupId(species, stage, variant) {
  return `${species}_s${stage}${variant === 'fat' ? '-fat' : ''}`;
}

export function parseGroupId(id) {
  const m = BATCH_RE.exec(id);
  if (!m) return null;
  return { species: m[1], stage: Number(m[2]), variant: m[3] ? 'fat' : 'base' };
}

export function frameName(species, stage, variant, anim, frame) {
  if (!/^[a-z0-9]+$/.test(anim)) throw new Error(`anim name "${anim}" must match [a-z0-9]+`);
  if (!(frame >= 0 && frame <= 99)) throw new Error('frame number must be 00..99');
  return `${groupId(species, stage, variant)}_${anim}_${String(frame).padStart(2, '0')}.png`;
}

/** Returns an error string or null. */
export function checkMembership(cfg, species, stage, variant) {
  const st = cfg.stages[String(stage)];
  if (!st) return `unknown stage ${stage}`;
  if (!st.species.includes(species)) return `species "${species}" does not belong to stage ${stage} (${st.name})`;
  if (variant === 'fat' && !cfg.fat_stages.includes(stage)) return `variant "fat" is not allowed on stage ${stage} (D6: stages ${cfg.fat_stages.join(', ')} only)`;
  return null;
}

/** §2.8 budget check for a group. anims: { animName: [frameNumbers] }. Returns warnings[]. */
export function budgetWarnings(cfg, stage, variant, anims) {
  const budget = (cfg.animations[String(stage)] || {})[variant] || {};
  const warn = [];
  for (const [a, frames] of Object.entries(anims)) {
    if (!budget[a]) { warn.push(`anim "${a}" is not in the §2.8 budget for stage ${stage} ${variant}`); continue; }
    const [lo, hi] = budget[a];
    if (frames.length < lo || frames.length > hi) warn.push(`anim "${a}" has ${frames.length} frames; budget is ${lo === hi ? lo : lo + '–' + hi}`);
  }
  for (const a of Object.keys(budget)) if (!anims[a]) warn.push(`budgeted anim "${a}" is missing`);
  return warn;
}
