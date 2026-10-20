// Image decode dispatch (FR-01, §3.3): header size check before decoding,
// animated-input rejection, EXIF orientation for JPEG.
import jpeg from 'jpeg-js';
import { isPng, pngHeader, pngIsAnimated, decodePng } from './png.js';

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isGif = (b) => b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
const isWebp = (b) => b.length > 12 && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';

/** Parse JPEG markers: { w, h, orientation }. */
export function jpegHeader(b) {
  let o = 2, w = 0, h = 0, orientation = 1;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }
    const m = b[o + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xe1 && String.fromCharCode(...b.subarray(o + 4, o + 8)) === 'Exif') {
      orientation = exifOrientation(b, o + 10) || 1;
    }
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      h = (b[o + 5] << 8) | b[o + 6];
      w = (b[o + 7] << 8) | b[o + 8];
      break;
    }
    if (m === 0xda) break;
    o += 2 + len;
  }
  return { w, h, orientation };
}

function exifOrientation(b, t) {
  const le = b[t] === 0x49;
  const r16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
  const r32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
  const ifd = t + r32(t + 4);
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 1;
}

/** Rotate/flip RGBA according to EXIF orientation 1–8. */
export function applyOrientation(img, orientation) {
  if (!orientation || orientation === 1) return img;
  const { w, h, rgba } = img;
  const swap = orientation >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X, Y;
    switch (orientation) {
      case 2: X = w - 1 - x; Y = y; break;
      case 3: X = w - 1 - x; Y = h - 1 - y; break;
      case 4: X = x; Y = h - 1 - y; break;
      case 5: X = y; Y = x; break;
      case 6: X = h - 1 - y; Y = x; break;
      case 7: X = h - 1 - y; Y = w - 1 - x; break;
      case 8: X = y; Y = w - 1 - x; break;
      default: X = x; Y = y;
    }
    const s = (y * w + x) * 4, d = (Y * W + X) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
  }
  return { w: W, h: H, rgba: out };
}

/** Header-only inspection. Throws on unsupported / animated / oversize input. */
export function inspect(bytes, maxPx = 4096) {
  let info;
  if (isPng(bytes)) {
    if (pngIsAnimated(bytes)) throw new Error('animated PNG (APNG) is not accepted');
    info = { format: 'png', ...pngHeader(bytes), orientation: 1 };
  } else if (isJpeg(bytes)) {
    info = { format: 'jpeg', ...jpegHeader(bytes) };
  } else if (isGif(bytes)) {
    throw new Error('GIF is not accepted (convert a still frame to PNG first)');
  } else if (isWebp(bytes)) {
    throw new Error('WebP is not accepted — convert to PNG first (§3.3)');
  } else {
    throw new Error('unknown image format (PNG or JPEG only)');
  }
  if (!info.w || !info.h) throw new Error('could not read image size from header');
  if (info.w > maxPx || info.h > maxPx) throw new Error(`image ${info.w}x${info.h} exceeds ${maxPx}x${maxPx}`);
  return info;
}

/** Decode to { w, h, rgba } with orientation applied. */
export function decodeImage(bytes, maxPx = 4096) {
  const info = inspect(bytes, maxPx);
  let img;
  if (info.format === 'png') {
    const d = decodePng(bytes);
    img = { w: d.w, h: d.h, rgba: d.rgba };
  } else {
    const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 17, tolerantDecoding: false });
    img = { w: d.width, h: d.height, rgba: new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.length) };
  }
  return applyOrientation(img, info.orientation);
}
