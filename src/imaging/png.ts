/**
 * Dependency-free PNG codec (server-only; uses node:zlib). Covers what logo uploads and our own
 * proof output need: colour types 0/2/3/4/6, bit depths 1/2/4/8/16 (16-bit is reduced to 8),
 * palette + tRNS transparency, all five scanline filters. Interlaced (Adam7) PNGs are rejected
 * with a clear error — the production `ImageCodec` adapter (sharp) handles those, plus JPEG/SVG.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { createRaster, type Raster } from './raster';

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/* ------------------------------- encode ------------------------------- */

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length);
  const typeAndData = out.subarray(4, 8 + payload.length);
  for (let i = 0; i < 4; i++) typeAndData[i] = type.charCodeAt(i);
  typeAndData.set(payload, 4);
  dv.setUint32(8 + payload.length, crc32(typeAndData));
  return out;
}

export function encodePng(r: Raster): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, r.width);
  dv.setUint32(4, r.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression, filter, interlace = 0

  const stride = r.width * 4;
  const raw = new Uint8Array((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None (deflate does the heavy lifting)
    raw.set(r.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ------------------------------- decode ------------------------------- */

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): Raster {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > bytes.length) throw new Error('Truncated PNG');
    if (crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== dv.getUint32(pos + 8 + len)) {
      throw new Error(`Corrupt PNG: bad CRC in ${type}`);
    }
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (!width || !height || !(ctype in CHANNELS)) throw new Error('Invalid PNG header');
  if (interlace !== 0) throw new Error('Interlaced PNG not supported by the local codec');
  if (width * height > 40_000_000) throw new Error('PNG too large'); // decompression-bomb guard
  const channels = CHANNELS[ctype]!;
  if (depth < 8 && ctype !== 0 && ctype !== 3) throw new Error(`Unsupported bit depth ${depth}`);
  if (ctype === 3 && !palette) throw new Error('Palette PNG missing PLTE');

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // filter byte distance
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = new Uint8Array(inflateSync(joined));
  if (raw.length < (stride + 1) * height) throw new Error('Truncated PNG image data');

  // Unfilter in place into `rows`.
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= bpp ? prev[i - bpp]! : 0;
      const x = src[i]!;
      switch (f) {
        case 0: cur[i] = x; break;
        case 1: cur[i] = (x + a) & 0xff; break;
        case 2: cur[i] = (x + b) & 0xff; break;
        case 3: cur[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (x + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`Bad PNG filter type ${f}`);
      }
    }
  }

  const out = createRaster(width, height);
  const sample = (row: Uint8Array, idx: number): number => {
    // idx = sample index within the row
    if (depth === 8) return row[idx]!;
    if (depth === 16) return row[idx * 2]!; // high byte
    const perByte = 8 / depth;
    const byte = row[Math.floor(idx / perByte)]!;
    const shift = 8 - depth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scaleToByte = (v: number): number => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));

  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      if (ctype === 3) {
        const i = sample(row, x);
        out.data[d] = palette![i * 3] ?? 0;
        out.data[d + 1] = palette![i * 3 + 1] ?? 0;
        out.data[d + 2] = palette![i * 3 + 2] ?? 0;
        out.data[d + 3] = trns && i < trns.length ? trns[i]! : 255;
      } else if (ctype === 0 || ctype === 4) {
        const raw0 = sample(row, x * channels);
        const g = scaleToByte(raw0);
        out.data[d] = out.data[d + 1] = out.data[d + 2] = g;
        let a = ctype === 4 ? sample(row, x * channels + 1) : 255;
        if (ctype === 0 && trns && trns.length >= 2) {
          const key = (trns[0]! << 8) | trns[1]!;
          const keyAtDepth = depth === 16 ? key : key & ((1 << depth) - 1);
          const cmp = depth === 16 ? (row[x * 2]! << 8) | row[x * 2 + 1]! : raw0;
          if (cmp === keyAtDepth) a = 0;
        }
        out.data[d + 3] = a;
      } else {
        out.data[d] = sample(row, x * channels);
        out.data[d + 1] = sample(row, x * channels + 1);
        out.data[d + 2] = sample(row, x * channels + 2);
        out.data[d + 3] = ctype === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return out;
}
