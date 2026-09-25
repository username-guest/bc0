/**
 * Minimal RGBA raster toolkit (§3.3 Stage A/C). Pure TypeScript, no native deps, deterministic.
 * Brand-Exact proofs are built entirely from these primitives — no image model (ADR 0004).
 *
 * Pixels are straight (non-premultiplied) RGBA8. Resampling is done in premultiplied space to
 * avoid dark fringes around transparent edges — the classic logo-mockup artefact.
 */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray; // length = width * height * 4
}

export type Rgba = readonly [number, number, number, number];

export function createRaster(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid raster size ${width}x${height}`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill[0] || fill[1] || fill[2] || fill[3]) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function cloneRaster(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

export function crop(r: Raster, x: number, y: number, w: number, h: number): Raster {
  const out = createRaster(w, h);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= r.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= r.width) continue;
      const s = (sy * r.width + sx) * 4;
      const d = (j * w + i) * 4;
      out.data[d] = r.data[s]!;
      out.data[d + 1] = r.data[s + 1]!;
      out.data[d + 2] = r.data[s + 2]!;
      out.data[d + 3] = r.data[s + 3]!;
    }
  }
  return out;
}

/** Tight bounding box of pixels with alpha > threshold, or null if fully transparent. */
export function alphaBounds(
  r: Raster,
  threshold = 8,
): { x: number; y: number; w: number; h: number } | null {
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop to visible content with a small uniform padding (px). */
export function trimToContent(r: Raster, pad = 2): Raster {
  const b = alphaBounds(r);
  if (!b) return r;
  return crop(r, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
}

/** 2× box downsample in premultiplied space (used for supersampled AA and large shrinks). */
export function downsample2x(r: Raster): Raster {
  const w = Math.max(1, Math.floor(r.width / 2));
  const h = Math.max(1, Math.floor(r.height / 2));
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(r.width - 1, x * 2 + dx);
          const sy = Math.min(r.height - 1, y * 2 + dy);
          const s = (sy * r.width + sx) * 4;
          const a = r.data[s + 3]!;
          pr += r.data[s]! * a;
          pg += r.data[s + 1]! * a;
          pb += r.data[s + 2]! * a;
          pa += a;
        }
      }
      const d = (y * w + x) * 4;
      if (pa > 0) {
        out.data[d] = pr / pa;
        out.data[d + 1] = pg / pa;
        out.data[d + 2] = pb / pa;
      }
      out.data[d + 3] = pa / 4;
    }
  }
  return out;
}

/** Bilinear resize in premultiplied space; halves first when shrinking >2× to avoid aliasing. */
export function resize(r: Raster, width: number, height: number): Raster {
  let src = r;
  while (src.width >= width * 2 && src.height >= height * 2) src = downsample2x(src);
  if (src.width === width && src.height === height) return cloneRaster(src);

  const out = createRaster(width, height);
  const sxScale = src.width / width;
  const syScale = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * syScale - 0.5);
    const y0 = Math.min(src.height - 1, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sxScale - 0.5);
      const x0 = Math.min(src.width - 1, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      const taps: Array<[number, number, number]> = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ];
      for (const [sx, sy, wgt] of taps) {
        const s = (sy * src.width + sx) * 4;
        const a = src.data[s + 3]! * wgt;
        pr += src.data[s]! * a;
        pg += src.data[s + 1]! * a;
        pb += src.data[s + 2]! * a;
        pa += a;
      }
      const d = (y * width + x) * 4;
      if (pa > 0) {
        out.data[d] = pr / pa;
        out.data[d + 1] = pg / pa;
        out.data[d + 2] = pb / pa;
      }
      out.data[d + 3] = pa;
    }
  }
  return out;
}

/** Source-over composite `src` onto `dst` at (dx, dy). Mutates `dst`. */
export function over(dst: Raster, src: Raster, dx: number, dy: number, opacity = 1): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const sa = (src.data[s + 3]! / 255) * opacity;
      if (sa <= 0) continue;
      const d = (ty * dst.width + tx) * 4;
      const da = dst.data[d + 3]! / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        const sc = src.data[s + c]!;
        const dc = dst.data[d + c]!;
        dst.data[d + c] = (sc * sa + dc * da * (1 - sa)) / oa;
      }
      dst.data[d + 3] = oa * 255;
    }
  }
}

/** Relative luminance (0..1) of an sRGB8 triple, Rec.709 weights. */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
