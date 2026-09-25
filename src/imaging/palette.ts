/**
 * Logo colour analysis (§3.3 Stage A). Produces the colour count that drives screen-print /
 * pad-print tiering and embroidery thread count, plus the brand palette used by Brand-Exact
 * spot-colour rendering.
 *
 * Why this is not a histogram count: anti-aliased edges and JPEG noise generate dozens of
 * in-between colours. A naive count would call a 2-colour logo "40 colours" and quote a 40-screen
 * job. We therefore (1) ignore mostly-transparent pixels, (2) bucket, (3) merge buckets that are
 * perceptually indistinct (CIE76 ΔE in Lab), (4) re-assign edge pixels to their nearest real
 * cluster, and (5) only count clusters above a coverage floor.
 */
import type { Raster } from './raster';

export interface Lab {
  L: number;
  a: number;
  b: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // D65
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE(p: Lab, q: Lab): number {
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

export function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export interface PaletteColor {
  hex: string;
  rgb: [number, number, number];
  coverage: number; // fraction of opaque logo pixels, 0..1
}

export interface PaletteResult {
  colors: PaletteColor[]; // significant colours, by coverage desc
  colorCount: number; // spot colours a decorator would separate
  /** Many significant colours / smooth gradients → photographic art; steer to DTG/DTF/sublimation. */
  isPhotographic: boolean;
  opaquePixels: number;
}

export interface PaletteOptions {
  alphaThreshold?: number; // pixels at/below are ignored (default 128)
  mergeDeltaE?: number; // clusters closer than this are the same ink (default 12)
  minCoverage?: number; // clusters below this are AA/noise (default 0.015)
  photographicThreshold?: number; // > this many significant colours ⇒ photographic (default 8)
  /** Minor clusters within this ΔE of the mixing line between two larger inks are blends (default 6). */
  blendDeltaE?: number;
  /** Only clusters below this coverage can be classified as blends (default 0.08). */
  blendMaxCoverage?: number;
}

interface Cluster {
  r: number;
  g: number;
  b: number;
  n: number;
  lab: Lab;
}

export function extractPalette(img: Raster, opts: PaletteOptions = {}): PaletteResult {
  const alphaThreshold = opts.alphaThreshold ?? 128;
  const mergeDeltaE = opts.mergeDeltaE ?? 12;
  const minCoverage = opts.minCoverage ?? 0.015;
  const photoThreshold = opts.photographicThreshold ?? 8;
  const blendDeltaE = opts.blendDeltaE ?? 6;
  const blendMaxCoverage = opts.blendMaxCoverage ?? 0.08;

  // 1–2. Bucket opaque pixels at 5 bits/channel.
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let opaque = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! <= alphaThreshold) continue;
    opaque++;
    const key = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
    const bk = buckets.get(key);
    if (bk) {
      bk.r += d[i]!;
      bk.g += d[i + 1]!;
      bk.b += d[i + 2]!;
      bk.n++;
    } else buckets.set(key, { r: d[i]!, g: d[i + 1]!, b: d[i + 2]!, n: 1 });
  }
  if (opaque === 0) return { colors: [], colorCount: 0, isPhotographic: false, opaquePixels: 0 };

  // 3. Greedy merge, largest buckets first, so big flat areas become the cluster seeds.
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const clusters: Cluster[] = [];
  for (const bk of sorted) {
    const r = bk.r / bk.n;
    const g = bk.g / bk.n;
    const b = bk.b / bk.n;
    const lab = rgbToLab(r, g, b);
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const dist = deltaE(lab, c.lab);
      if (dist < bestD) {
        bestD = dist;
        best = c;
      }
    }
    if (best && bestD < mergeDeltaE) {
      const n = best.n + bk.n;
      best.r = (best.r * best.n + r * bk.n) / n;
      best.g = (best.g * best.n + g * bk.n) / n;
      best.b = (best.b * best.n + b * bk.n) / n;
      best.n = n;
      best.lab = rgbToLab(best.r, best.g, best.b);
    } else clusters.push({ r, g, b, n: bk.n, lab });
  }

  // 4. Keep significant clusters; fold minor (edge/noise) clusters into their nearest survivor.
  let significant = clusters.filter((c) => c.n / opaque >= minCoverage);

  // 4b. Blend rejection. Lossy compression (JPEG chroma subsampling) and wide anti-aliasing
  // produce a band of MIXED colour wherever two inks meet — enough pixels to clear the coverage
  // floor. A small cluster that lies on the mixing line between two larger inks is a blend of
  // them, not an ink. Measured: JPEG phantoms sit 2–4 ΔE from the line; real inks (incl. close
  // brand tints) sit 35+ ΔE away. Checked smallest-first so a blend can't anchor another blend.
  significant = rejectBlends(significant, opaque, blendDeltaE, blendMaxCoverage);
  const survivors = significant.length ? significant : [clusters[0]!];
  for (const c of clusters) {
    if (survivors.includes(c)) continue;
    let best = survivors[0]!;
    let bestD = Infinity;
    for (const s of survivors) {
      const dist = deltaE(c.lab, s.lab);
      if (dist < bestD) {
        bestD = dist;
        best = s;
      }
    }
    best.n += c.n; // coverage only; don't shift the ink colour toward AA mixes
  }

  survivors.sort((a, b) => b.n - a.n);
  const colors: PaletteColor[] = survivors.map((c) => ({
    hex: toHex(c.r, c.g, c.b),
    rgb: [Math.round(c.r), Math.round(c.g), Math.round(c.b)],
    coverage: c.n / opaque,
  }));

  // Photographic: many significant clusters OR very many raw clusters with none dominant.
  const isPhotographic =
    colors.length > photoThreshold || (clusters.length > 60 && (colors[0]?.coverage ?? 1) < 0.35);

  return { colors, colorCount: colors.length, isPhotographic, opaquePixels: opaque };
}

function mixDistance(c: Cluster, a: Cluster, b: Cluster): number {
  let best = Infinity;
  for (let i = 2; i <= 38; i++) {
    const t = i / 40; // interior of the segment only; endpoints are handled by the merge step
    const lab = rgbToLab(a.r * (1 - t) + b.r * t, a.g * (1 - t) + b.g * t, a.b * (1 - t) + b.b * t);
    best = Math.min(best, deltaE(c.lab, lab));
  }
  return best;
}

function rejectBlends(sig: Cluster[], opaque: number, maxDE: number, maxCov: number): Cluster[] {
  const kept = [...sig].sort((x, y) => y.n - x.n);
  for (let i = kept.length - 1; i >= 2; i--) {
    const c = kept[i]!;
    if (c.n / opaque >= maxCov) continue;
    const larger = kept.slice(0, i);
    let isBlend = false;
    for (let a = 0; a < larger.length && !isBlend; a++) {
      for (let b = a + 1; b < larger.length && !isBlend; b++) {
        if (mixDistance(c, larger[a]!, larger[b]!) <= maxDE) isBlend = true;
      }
    }
    if (isBlend) kept.splice(i, 1); // folded into the nearest survivor by step 4's reassignment
  }
  return kept;
}

/** Nearest palette entry (perceptual) — used to snap pixels to spot inks / thread colours. */
export function nearestPaletteIndex(lab: Lab, paletteLab: Lab[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < paletteLab.length; i++) {
    const dist = deltaE(lab, paletteLab[i]!);
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  }
  return best;
}
