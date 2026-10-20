// §2.3 group coordinates, placement, FR-07 fit checks.
import { TRANSPARENT } from './config.js';
import { opaqueBox } from './frame.js';

/**
 * Unit reference point: bottom-centre of the opaque bbox of the unit's first frame,
 * in segment-local coordinates: ( floor((left+right)/2), bottom ).
 */
export function unitReference(firstFrame) {
  const b = opaqueBox(firstFrame);
  if (!b) throw new Error('segment 0 anchors the unit and must contain pixels — move the first divider or the region (or turn off Remove strays)');
  const left = firstFrame.ox + b.left, right = firstFrame.ox + b.right, bottom = firstFrame.oy + b.bottom;
  return [Math.floor((left + right) / 2), bottom];
}

/** G offset of a frame's I[0]: frame origin − unit reference + (dx, dy). */
export function frameG(frame, ref, dx = 0, dy = 0) {
  return [frame.ox - ref[0] + dx, frame.oy - ref[1] + dy];
}

/**
 * Place a whole group. frames: [{ frame, g:[gx,gy] }].
 * Returns { U:{left,top,right,bottom,w,h}, T:[tx,ty], exceedsBox, blocked, reason }.
 */
export function placeGroup(frames, { canvas = { w: 64, h: 64 }, baselineY = 61, box }) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const { frame, g } of frames) {
    const b = opaqueBox(frame);
    if (!b) continue;
    left = Math.min(left, g[0] + b.left); right = Math.max(right, g[0] + b.right);
    top = Math.min(top, g[1] + b.top); bottom = Math.max(bottom, g[1] + b.bottom);
  }
  if (!isFinite(left)) throw new Error('group has no opaque pixels');
  const U = { left, top, right, bottom, w: right - left + 1, h: bottom - top + 1 };
  const x0 = Math.floor((canvas.w - U.w) / 2);
  const T = [x0 - U.left, baselineY - U.bottom];
  const maxH = baselineY + 1;
  let blocked = null;
  if (U.w > canvas.w || U.h > maxH) blocked = `group ${U.w}x${U.h} cannot fit the ${canvas.w}x${canvas.h} canvas with bottom at y=${baselineY} (max ${canvas.w}x${maxH})`;
  const exceedsBox = box ? U.w > box[0] || U.h > box[1] : false;
  return { U, T, exceedsBox, blocked };
}

/** Render a frame into the canvas with translation T. Returns { w, h, I }. */
export function renderToCanvas(frame, g, T, canvas = { w: 64, h: 64 }) {
  const I = new Uint8Array(canvas.w * canvas.h).fill(TRANSPARENT);
  const ox = g[0] + T[0], oy = g[1] + T[1];
  for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) {
    const v = frame.I[y * frame.w + x];
    if (v === TRANSPARENT) continue;
    const cx = ox + x, cy = oy + y;
    if (cx < 0 || cy < 0 || cx >= canvas.w || cy >= canvas.h) throw new Error(`pixel outside canvas at (${cx},${cy})`);
    I[cy * canvas.w + cx] = v;
  }
  return { w: canvas.w, h: canvas.h, I };
}
