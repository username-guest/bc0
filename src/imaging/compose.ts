/**
 * Brand-Exact proof rendering (§3.3 Stage C, ADR 0004). Fully deterministic — no image model.
 *
 * The logo is placed into the authored/detected imprint zone and passed through a per-method
 * "shader" that encodes that method's PHYSICAL constraints, so the proof doesn't promise what the
 * decorator can't produce:
 *
 *   screen_print / pad_printing   spot inks snapped to the brand palette, crisp edges, sits in folds
 *   heat_transfer_htv             spot colours, flatter/opaque vinyl with a slight sheen
 *   embroidery                    thread colours, satin-stitch texture, raised shadow
 *   dtg                           full colour, soft hand (fabric shows through slightly)
 *   dtf                           full colour, opaque film, slight sheen
 *   sublimation                   full colour dye, MULTIPLY into substrate — cannot print white
 *   laser_engraving               single etch tone derived from the substrate (never logo colours)
 *   deboss_emboss                 blind impression: recessed tone + bevel, no ink
 *
 * Brand colours are preserved exactly for spot-colour methods: every inked pixel IS one of the
 * extracted palette hexes. Output is a new raster; inputs are not mutated.
 */
import type { DecorationMethodKey } from '@/pricing/types';
import { type Raster, cloneRaster, createRaster, luma, resize } from './raster';
import { nearestPaletteIndex, parseHex, rgbToLab, type Lab, type PaletteColor } from './palette';
import { type ProductTemplate, type Zone, shadeChannel } from './templates';

export interface ProofRequest {
  product: Raster; // colourway of `template`
  template: ProductTemplate;
  zone: Zone;
  logo: Raster; // background removed + trimmed
  palette: PaletteColor[]; // from extractPalette (significant colours)
  method: DecorationMethodKey;
  substrateHex: string; // product colour
  maxSpotColors?: number;
}

export interface ProofResult {
  raster: Raster;
  placed: { x: number; y: number; w: number; h: number };
  notes: string[]; // user-facing caveats (e.g. "white areas can't be sublimated")
}

/** Below this WCAG contrast ratio an ink is flagged as hard to see on the product colour. */
export const LOW_CONTRAST_RATIO = 1.8;

export function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Fit the logo inside the zone (contain), centred. Returns the scaled logo + pixel placement. */
export function fitToZone(logo: Raster, zone: Zone, W: number, H: number) {
  const zx = zone.x * W;
  const zy = zone.y * H;
  const zw = zone.w * W;
  const zh = zone.h * H;
  const scale = Math.min(zw / logo.width, zh / logo.height);
  const w = Math.max(1, Math.round(logo.width * scale));
  const h = Math.max(1, Math.round(logo.height * scale));
  const x = Math.round(zx + (zw - w) / 2);
  const y = Math.round(zone.anchor === 'top' ? zy : zy + (zh - h) / 2);
  return { scaled: resize(logo, w, h), x, y, w, h };
}

/** Snap every pixel to the nearest of the first N palette colours and harden alpha. */
function spotSnap(src: Raster, palette: PaletteColor[], maxColors: number, edge: [number, number]): Raster {
  const inks = palette.slice(0, Math.max(1, maxColors));
  const labs: Lab[] = inks.map((c) => rgbToLab(...c.rgb));
  const out = cloneRaster(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]! / 255;
    if (a <= 0.02) {
      d[i + 3] = 0;
      continue;
    }
    const ink = inks[nearestPaletteIndex(rgbToLab(d[i]!, d[i + 1]!, d[i + 2]!), labs)]!;
    d[i] = ink.rgb[0];
    d[i + 1] = ink.rgb[1];
    d[i + 2] = ink.rgb[2];
    d[i + 3] = smoothstep(edge[0], edge[1], a) * 255;
  }
  return out;
}

export function renderBrandExact(req: ProofRequest): ProofResult {
  const { product, template, zone, method } = req;
  const W = product.width;
  const H = product.height;
  const notes: string[] = [];
  const fit = fitToZone(req.logo, zone, W, H);
  const out = cloneRaster(product);
  const [sr, sg, sb] = parseHex(req.substrateHex);
  const substrateLuma = luma(sr, sg, sb);
  const palette = req.palette.length ? req.palette : [{ hex: '#000000', rgb: [0, 0, 0] as [number, number, number], coverage: 1 }];

  // 1. Method-specific ink layer, same size as the placed logo.
  let ink: Raster;
  let opacity = 1;
  let shadeStrength = 1; // how much the fabric's folds/shading show through the ink
  let blend: 'normal' | 'multiply' = 'normal';
  let grain = 0.03;

  switch (method) {
    case 'screen_print':
      ink = spotSnap(fit.scaled, palette, req.maxSpotColors ?? 8, [0.35, 0.65]);
      opacity = 0.97;
      if (palette.length > (req.maxSpotColors ?? 8)) notes.push('Artwork reduced to the top spot colours for screen printing.');
      break;
    case 'pad_printing':
      ink = spotSnap(fit.scaled, palette, req.maxSpotColors ?? 4, [0.35, 0.65]);
      grain = 0.015;
      if (palette.length > (req.maxSpotColors ?? 4)) notes.push('Pad printing supports up to 4 spot colours; extra colours merged.');
      break;
    case 'heat_transfer_htv':
      ink = spotSnap(fit.scaled, palette, req.maxSpotColors ?? 3, [0.4, 0.6]);
      shadeStrength = 0.55;
      grain = 0.01;
      break;
    case 'embroidery':
      ink = embroider(fit.scaled, palette, req.maxSpotColors ?? 15);
      shadeStrength = 0.6;
      grain = 0;
      notes.push('Thread colours are matched to your logo. Very fine details may be simplified for stitching.');
      break;
    case 'dtg':
      ink = cloneRaster(fit.scaled);
      opacity = 0.93;
      break;
    case 'dtf':
      ink = cloneRaster(fit.scaled);
      shadeStrength = 0.7;
      grain = 0.01;
      break;
    case 'sublimation':
      ink = sublimate(fit.scaled);
      blend = 'multiply';
      grain = 0.01;
      notes.push("Sublimation can't print white: white areas take the product colour.");
      if (substrateLuma < 0.6) notes.push('Sublimation is only suitable for light-coloured polyester/coated items.');
      break;
    case 'laser_engraving':
      ink = etch(fit.scaled, sr, sg, sb, substrateLuma, template.substrate);
      shadeStrength = 0.5;
      grain = 0.04;
      notes.push('Laser engraving is single-tone: the mark shows as the etched material, not your brand colours.');
      break;
    case 'deboss_emboss':
      ink = deboss(fit.scaled, sr, sg, sb);
      shadeStrength = 1;
      grain = 0.02;
      notes.push('Blind deboss: pressed into the material with no ink.');
      break;
  }

  // Legibility check: inks that nearly vanish on this substrate get called out, so the proof
  // doesn't look fine at thumbnail size and disappoint in production. Uses the WCAG luminance
  // contrast ratio — perceptual ΔE over-rates hue/chroma differences on dark colours (navy on
  // black is ΔE≈25 yet barely visible, contrast ≈1.4:1).
  const INKED: DecorationMethodKey[] = ['screen_print', 'pad_printing', 'heat_transfer_htv', 'embroidery', 'dtg', 'dtf'];
  if (INKED.includes(method)) {
    const subL = relLuminance(sr, sg, sb);
    for (const c of palette) {
      if (c.coverage >= 0.05 && contrastRatio(relLuminance(...c.rgb), subL) < LOW_CONTRAST_RATIO) {
        notes.push(`${c.hex} will be hard to see on this product colour.`);
      }
    }
  }

  // 2. Composite into the product, clipped to the product body so ink never floats off-edge.
  for (let y = 0; y < fit.h; y++) {
    const ty = fit.y + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < fit.w; x++) {
      const tx = fit.x + x;
      if (tx < 0 || tx >= W) continue;
      const s = (y * fit.w + x) * 4;
      const p = ty * W + tx;
      const bodyCov = template.body.data[p]!;
      const a = (ink.data[s + 3]! / 255) * opacity * bodyCov;
      if (a <= 0) continue;
      const d = p * 4;
      const shade = 1 + (template.shade[p]! - 1) * shadeStrength;
      const g = 1 + (hash01(tx, ty) - 0.5) * 2 * grain;
      for (let c = 0; c < 3; c++) {
        let v = shadeChannel(ink.data[s + c]!, shade) * g;
        if (blend === 'multiply') v = (v / 255) * out.data[d + c]!;
        out.data[d + c] = clamp255(v * a + out.data[d + c]! * (1 - a));
      }
    }
  }

  return { raster: out, placed: { x: fit.x, y: fit.y, w: fit.w, h: fit.h }, notes };
}

/* ------------------------------ shaders ------------------------------ */

function alphaAt(r: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return 0;
  return r.data[(y * r.width + x) * 4 + 3]! / 255;
}

function embroider(src: Raster, palette: PaletteColor[], maxThreads: number): Raster {
  const snapped = spotSnap(src, palette, maxThreads, [0.45, 0.55]);
  const out = createRaster(src.width, src.height);
  const shadowOff = Math.max(1, Math.round(src.width / 120));
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const a = snapped.data[i + 3]! / 255;
      // raised shadow cast down-right, beneath the stitches
      const sh = alphaAt(snapped, x - shadowOff, y - shadowOff) * (1 - a) * 0.45;
      if (a <= 0 && sh <= 0) continue;
      // satin stitches run diagonally; alternate direction per colour region for realism
      const hue = snapped.data[i]! + snapped.data[i + 1]! * 3 + snapped.data[i + 2]! * 7;
      const dir = hue % 2 === 0 ? x + y : x - y;
      const stitch = 0.88 + 0.16 * (0.5 + 0.5 * Math.sin((dir * Math.PI * 2) / 3.4));
      // bevel: lit from top-left
      const edge = a - alphaAt(snapped, x - 1, y - 1);
      const bevel = 1 + 0.25 * Math.max(-1, Math.min(1, edge));
      const k = stitch * bevel;
      out.data[i] = a > 0 ? clamp255(snapped.data[i]! * k) : 0;
      out.data[i + 1] = a > 0 ? clamp255(snapped.data[i + 1]! * k) : 0;
      out.data[i + 2] = a > 0 ? clamp255(snapped.data[i + 2]! * k) : 0;
      out.data[i + 3] = Math.max(a, sh) * 255;
    }
  }
  return out;
}

/** Remove white/near-white (sublimation has no white ink); alpha by "ink amount". */
function sublimate(src: Raster): Raster {
  const out = cloneRaster(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const whiteness = (minc / 255) * (1 - (maxc - minc) / 255); // bright AND unsaturated
    d[i + 3] = d[i + 3]! * (1 - smoothstep(0.78, 0.95, whiteness));
  }
  return out;
}

function etch(src: Raster, sr: number, sg: number, sb: number, substrateLuma: number, substrate: string): Raster {
  // Coated/dark items reveal bright bare metal; bare/light items darken (oxidised etch).
  const etchRgb: [number, number, number] =
    substrate === 'metal' && substrateLuma < 0.55
      ? [206, 210, 216]
      : substrate === 'metal'
        ? [92, 96, 102]
        : [Math.round(sr * 0.45), Math.round(sg * 0.4), Math.round(sb * 0.35)]; // burned wood/leather/paper
  const out = createRaster(src.width, src.height);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = smoothstep(0.4, 0.6, src.data[i + 3]! / 255);
    if (a <= 0) continue;
    out.data[i] = etchRgb[0];
    out.data[i + 1] = etchRgb[1];
    out.data[i + 2] = etchRgb[2];
    out.data[i + 3] = a * 255;
  }
  return out;
}

function deboss(src: Raster, sr: number, sg: number, sb: number): Raster {
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const a = smoothstep(0.4, 0.6, alphaAt(src, x, y));
      // Recessed: inner top-left edge in shadow, inner bottom-right edge catches light.
      const tl = a - smoothstep(0.4, 0.6, alphaAt(src, x - 1, y - 1));
      const br = a - smoothstep(0.4, 0.6, alphaAt(src, x + 1, y + 1));
      const ring = Math.max(tl, br, 0);
      if (a <= 0 && ring <= 0) continue;
      let k = 0.8; // recessed floor is darker
      if (tl > 0.2) k = 0.55;
      else if (br > 0.2) k = 1.18;
      const i = (y * src.width + x) * 4;
      out.data[i] = clamp255(k <= 1 ? sr * k : sr + (255 - sr) * (k - 1));
      out.data[i + 1] = clamp255(k <= 1 ? sg * k : sg + (255 - sg) * (k - 1));
      out.data[i + 2] = clamp255(k <= 1 ? sb * k : sb + (255 - sb) * (k - 1));
      out.data[i + 3] = Math.max(a, ring) * 255;
    }
  }
  return out;
}
