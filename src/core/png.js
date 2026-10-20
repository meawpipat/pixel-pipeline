// PNG decoder (all standard colour types / bit depths, Adam7) and a
// deterministic encoder (FR-11 canonical indexed PNG, §6 4-grey PNGs).
import { unzlibSync, zlibSync } from 'fflate';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function isPng(bytes) {
  return bytes.length >= 8 && SIG.every((v, i) => bytes[i] === v);
}

/** Read width/height from the IHDR without decoding pixels. */
export function pngHeader(bytes) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  return { w: u32(bytes, 16), h: u32(bytes, 20), bitDepth: bytes[24], colorType: bytes[25], interlace: bytes[28] };
}

/** True if the PNG is animated (APNG acTL chunk before IDAT). */
export function pngIsAnimated(bytes) {
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = u32(bytes, o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    o += 12 + len;
  }
  return false;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(raw, offset, w, h, bpp, rowBytes) {
  const out = new Uint8Array(h * rowBytes);
  let ip = offset;
  for (let y = 0; y < h; y++) {
    const ft = raw[ip++];
    const ro = y * rowBytes, po = ro - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[ip++];
      const a = x >= bpp ? out[ro + x - bpp] : 0;
      const b = y > 0 ? out[po + x] : 0;
      const c = x >= bpp && y > 0 ? out[po + x - bpp] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error('bad PNG filter ' + ft);
      }
      out[ro + x] = r & 255;
    }
  }
  return { out, consumed: ip - offset };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode PNG → { w, h, rgba: Uint8Array, indexed?: { data, palette, trns, bitDepth } }.
 * `indexed` is present for colour type 3 (palette images), with raw indices.
 */
export function decodePng(bytes, maxPx = 4096) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  let o = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (o < bytes.length) {
    const len = u32(bytes, o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const d = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = { w: u32(d, 0), h: u32(d, 4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
    else if (type === 'PLTE') plte = d.slice();
    else if (type === 'tRNS') trns = d.slice();
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  const { w, h, bitDepth, colorType, interlace } = ihdr;
  if (!w || !h || w > maxPx || h > maxPx) throw new Error(`PNG ${w}x${h} outside 1..${maxPx}`);
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error('unsupported PNG colour type ' + colorType);
  let total = 0; for (const c of idat) total += c.length;
  const z = new Uint8Array(total); let p = 0; for (const c of idat) { z.set(c, p); p += c.length; }
  const raw = unzlibSync(z);
  const bitsPP = ch * bitDepth;
  const bpp = Math.max(1, bitsPP >> 3);

  const samples = new Uint16Array(w * h * ch); // full-precision samples
  const place = (sub, sw, sh, xs, ys, dx, dy) => {
    const rowBytes = Math.ceil((sw * bitsPP) / 8);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const tx = xs + x * dx, ty = ys + y * dy;
        for (let c = 0; c < ch; c++) {
          let v;
          if (bitDepth === 16) { const bo = y * rowBytes + (x * ch + c) * 2; v = (sub[bo] << 8) | sub[bo + 1]; }
          else if (bitDepth === 8) v = sub[y * rowBytes + x * ch + c];
          else { const bit = (x * ch + c) * bitDepth; const byte = sub[y * rowBytes + (bit >> 3)]; v = (byte >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1); }
          samples[(ty * w + tx) * ch + c] = v;
        }
      }
    }
  };
  if (interlace === 0) {
    const rowBytes = Math.ceil((w * bitsPP) / 8);
    place(unfilter(raw, 0, w, h, bpp, rowBytes).out, w, h, 0, 0, 1, 1);
  } else {
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    let off = 0;
    for (const [xs, ys, dx, dy] of passes) {
      const sw = Math.ceil((w - xs) / dx), sh = Math.ceil((h - ys) / dy);
      if (sw <= 0 || sh <= 0) continue;
      const rowBytes = Math.ceil((sw * bitsPP) / 8);
      const { out, consumed } = unfilter(raw, off, sw, sh, bpp, rowBytes);
      off += consumed;
      place(out, sw, sh, xs, ys, dx, dy);
    }
  }

  const rgba = new Uint8Array(w * h * 4);
  const max = (1 << bitDepth) - 1;
  const to8 = (v) => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / max));
  let indexed = null;
  if (colorType === 3) indexed = { data: new Uint8Array(w * h), palette: plte, trns, bitDepth };
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, q = i * 4;
    if (colorType === 0) {
      const g = to8(samples[s]);
      const transparent = trns && trns.length >= 2 && samples[s] === ((trns[0] << 8) | trns[1]);
      rgba[q] = rgba[q + 1] = rgba[q + 2] = g; rgba[q + 3] = transparent ? 0 : 255;
    } else if (colorType === 2) {
      rgba[q] = to8(samples[s]); rgba[q + 1] = to8(samples[s + 1]); rgba[q + 2] = to8(samples[s + 2]);
      const transparent = trns && trns.length >= 6 &&
        samples[s] === ((trns[0] << 8) | trns[1]) && samples[s + 1] === ((trns[2] << 8) | trns[3]) && samples[s + 2] === ((trns[4] << 8) | trns[5]);
      rgba[q + 3] = transparent ? 0 : 255;
    } else if (colorType === 3) {
      const idx = samples[s];
      indexed.data[i] = idx;
      if (!plte || idx * 3 + 2 >= plte.length) { rgba[q + 3] = 0; continue; }
      rgba[q] = plte[idx * 3]; rgba[q + 1] = plte[idx * 3 + 1]; rgba[q + 2] = plte[idx * 3 + 2];
      rgba[q + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 4) {
      const g = to8(samples[s]); rgba[q] = rgba[q + 1] = rgba[q + 2] = g; rgba[q + 3] = to8(samples[s + 1]);
    } else {
      rgba[q] = to8(samples[s]); rgba[q + 1] = to8(samples[s + 1]); rgba[q + 2] = to8(samples[s + 2]); rgba[q + 3] = to8(samples[s + 3]);
    }
  }
  return { w, h, rgba, indexed, colorType, bitDepth };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Deterministic PNG encoder: filter 0 on every row, zlib level 9,
 * chunk order IHDR, PLTE, tRNS, IDAT, IEND. No ancillary chunks.
 * opts: { w, h, colorType: 0|3|6, bitDepth: 1|8, data, palette?: [[r,g,b]], trns?: [a] }
 * data: one sample per pixel for colorType 0/3, RGBA bytes for 6.
 */
export function encodePng({ w, h, colorType, bitDepth, data, palette, trns }) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const ch = colorType === 6 ? 4 : 1;
  const rowBytes = Math.ceil((w * ch * bitDepth) / 8);
  const raw = new Uint8Array(h * (rowBytes + 1));
  for (let y = 0; y < h; y++) {
    const ro = y * (rowBytes + 1);
    raw[ro] = 0;
    if (bitDepth === 8) {
      raw.set(data.subarray(y * w * ch, (y + 1) * w * ch), ro + 1);
    } else {
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x] & ((1 << bitDepth) - 1);
        const bit = x * bitDepth;
        raw[ro + 1 + (bit >> 3)] |= v << (8 - bitDepth - (bit & 7));
      }
    }
  }
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', new Uint8Array(palette.flat())));
  if (trns) parts.push(chunk('tRNS', new Uint8Array(trns)));
  parts.push(chunk('IDAT', zlibSync(raw, { level: 9 })));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}
