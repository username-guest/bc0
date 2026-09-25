/**
 * Local background removal (§3.3 Stage A) — the `BG_REMOVAL_PROVIDER=local` implementation.
 *
 * Handles the dominant real-world case: a logo on a solid (usually white) background. Seeds a
 * flood fill from every border pixel matching the dominant border colour.
 *
 * Enclosed regions of the background colour are AMBIGUOUS: the counter of an "O" should be
 * knocked out, but white text inside a red badge is intentional ink. Pixels can't distinguish
 * them, so we don't guess: by default they are kept, counted in `enclosedRegions`, and confidence
 * drops to 'medium' so the UI can offer "knock out enclosed areas" (`removeEnclosed: true`).
 *
 * It never guesses on photos: if the border isn't a single dominant colour it returns the image
 * untouched with `confidence: 'low'` so the pipeline routes to review / an ML provider instead of
 * silently shipping a bad cut-out (§17 guardrail).
 */
import { type Raster, cloneRaster } from './raster';
import { rgbToLab, deltaE, type Lab } from './palette';

export type BgConfidence = 'high' | 'medium' | 'low';

export interface BgRemovalResult {
  raster: Raster;
  removed: boolean;
  alreadyTransparent: boolean;
  confidence: BgConfidence;
  backgroundHex?: string;
  reason: string;
  /** Enclosed regions matching the background colour (letter counters OR intentional fill). */
  enclosedRegions: number;
}

export interface BgRemovalOptions {
  tolerance?: number; // ΔE within which a pixel is "background" (default 10)
  feather?: number; // ΔE band beyond tolerance that becomes partially transparent (default 14)
  minBorderDominance?: number; // fraction of border that must match (default 0.9)
  removeEnclosed?: boolean; // also knock out enclosed bg-colour regions (default false — see header)
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function removeUniformBackground(img: Raster, opts: BgRemovalOptions = {}): BgRemovalResult {
  const tolerance = opts.tolerance ?? 10;
  const feather = opts.feather ?? 14;
  const minDominance = opts.minBorderDominance ?? 0.9;
  const removeEnclosed = opts.removeEnclosed ?? false;
  const { width: w, height: h, data } = img;

  // Border sample.
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  const transparentBorder = border.filter((p) => data[p * 4 + 3]! < 16).length / border.length;
  if (transparentBorder > 0.5) {
    return {
      raster: img,
      removed: false,
      alreadyTransparent: true,
      confidence: 'high',
      reason: 'Image already has a transparent background',
      enclosedRegions: 0,
    };
  }

  // Dominant border colour: average of border pixels near the border median luminance-ish seed.
  const seedIdx = border[0]!;
  let seed: Lab = rgbToLab(data[seedIdx * 4]!, data[seedIdx * 4 + 1]!, data[seedIdx * 4 + 2]!);
  // Refine: pick the border colour that the most border pixels agree with (sample a few seeds).
  let bestAgree = -1;
  for (const cand of [border[0]!, border[w - 1]!, border[border.length - 1]!, border[Math.floor(border.length / 2)]!]) {
    const lab = rgbToLab(data[cand * 4]!, data[cand * 4 + 1]!, data[cand * 4 + 2]!);
    const agree = border.filter(
      (p) => deltaE(lab, rgbToLab(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!)) < tolerance,
    ).length;
    if (agree > bestAgree) {
      bestAgree = agree;
      seed = lab;
    }
  }
  const dominance = bestAgree / border.length;
  if (dominance < minDominance) {
    return {
      raster: img,
      removed: false,
      alreadyTransparent: false,
      confidence: 'low',
      reason: `Background is not uniform (${Math.round(dominance * 100)}% of border matches) — needs review or an ML provider`,
      enclosedRegions: 0,
    };
  }

  // Per-pixel distance to the background colour (cached).
  const dist = new Float32Array(w * h);
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgN = 0;
  for (let p = 0; p < w * h; p++) {
    const lab = rgbToLab(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!);
    const dE = deltaE(lab, seed);
    dist[p] = dE;
    if (dE < tolerance) {
      bgR += data[p * 4]!;
      bgG += data[p * 4 + 1]!;
      bgB += data[p * 4 + 2]!;
      bgN++;
    }
  }
  const bgRgb: [number, number, number] = [bgR / bgN, bgG / bgN, bgB / bgN];

  // Flood fill from border through pixels within tolerance + feather band.
  const reached = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const p of border) {
    if (dist[p]! < tolerance + feather && !reached[p]) {
      reached[p] = 1;
      stack.push(p);
    }
  }
  while (stack.length) {
    const p = stack.pop()!;
    if (dist[p]! >= tolerance) continue; // feather pixels are reached but don't propagate
    const x = p % w;
    const y = (p - x) / w;
    const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nbrs) {
      if (q >= 0 && !reached[q] && dist[q]! < tolerance + feather) {
        reached[q] = 1;
        stack.push(q);
      }
    }
  }

  // Find enclosed bg-colour regions (counters in O/A/e, or intentional fill) above a size floor.
  let enclosedRegions = 0;
  {
    const minRegion = Math.max(16, Math.floor(w * h * 0.0005));
    const seen = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (reached[p] || seen[p] || dist[p]! >= tolerance) continue;
      const region: number[] = [];
      const st = [p];
      seen[p] = 1;
      while (st.length) {
        const q = st.pop()!;
        region.push(q);
        const x = q % w;
        const y = (q - x) / w;
        const nb = [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1];
        for (const r of nb) {
          if (r >= 0 && !seen[r] && !reached[r] && dist[r]! < tolerance) {
            seen[r] = 1;
            st.push(r);
          }
        }
      }
      if (region.length >= minRegion) {
        enclosedRegions++;
        if (!removeEnclosed) continue;
        for (const q of region) reached[q] = 1;
        // Include its feather ring.
        for (const q of region) {
          const x = q % w;
          const y = (q - x) / w;
          for (const r of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
            if (r >= 0 && !reached[r] && dist[r]! < tolerance + feather) reached[r] = 1;
          }
        }
      }
    }
  }

  // Write alpha: fully clear inside tolerance; ramp across feather band; decontaminate colour.
  const out = cloneRaster(img);
  for (let p = 0; p < w * h; p++) {
    if (!reached[p]) continue;
    const dE = dist[p]!;
    const i = p * 4;
    if (dE < tolerance) {
      out.data[i + 3] = 0;
      continue;
    }
    const t = Math.min(1, (dE - tolerance) / feather); // 0 = background, 1 = foreground
    const a = t * (data[i + 3]! / 255);
    // Un-mix the background from the edge colour: c = a·fg + (1−a)·bg  ⇒  fg = (c − (1−a)·bg)/a
    if (a > 0.02) {
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = (data[i + c]! - (1 - a) * bgRgb[c]!) / a;
      }
    }
    out.data[i + 3] = a * 255;
  }

  return {
    raster: out,
    removed: true,
    alreadyTransparent: false,
    confidence: dominance > 0.98 && (enclosedRegions === 0 || removeEnclosed) ? 'high' : 'medium',
    backgroundHex: hexOf(...bgRgb),
    reason:
      `Removed uniform background (${Math.round(dominance * 100)}% border agreement)` +
      (enclosedRegions && !removeEnclosed
        ? `; kept ${enclosedRegions} enclosed background-coloured area(s) — confirm whether they should be knocked out`
        : ''),
    enclosedRegions,
  };
}
