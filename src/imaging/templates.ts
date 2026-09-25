/**
 * Procedural product templates for the demo tenant (§3.2 categories). Stand-ins until real
 * blank-product photography arrives via ProductDataProvider — the RENDER CONTRACT is the same:
 *
 *   template = body mask + grayscale shading map + fixed-colour parts + authored imprint zones
 *   colourway(template, hex) = hex × shading   (shading > 1 mixes toward white = specular)
 *
 * This is how production mockup systems do colourways from one photo, so swapping in a real
 * photo means supplying a mask + shading (luminance) map; nothing downstream changes.
 * Zones here are authored, so their confidence is 1.0 and they bypass the vision gate (§3.3).
 */
import { createRaster, type Raster } from './raster';
import { parseHex } from './palette';
import {
  type Mask,
  type Pt,
  createMask,
  ellipsePts,
  polygonMask,
  roundRectPts,
  strokePts,
  subtract,
  union,
  addComplementary,
} from './draw';

export type TemplateKind = 'tee' | 'polo' | 'cap' | 'tumbler' | 'tote' | 'journal';
export type Substrate = 'fabric' | 'metal' | 'paper' | 'canvas';

export interface Zone {
  x: number; // normalized 0..1 of template width/height
  y: number;
  w: number;
  h: number;
  confidence: number;
  /** Vertical anchoring of artwork inside the zone. Full-front prints hang from the top. */
  anchor?: 'center' | 'top';
}

export interface ProductTemplate {
  kind: TemplateKind;
  width: number;
  height: number;
  body: Mask; // takes the product colour
  shade: Float32Array; // per-pixel multiplier; 1 = neutral
  fixed: Array<{ mask: Mask; rgb: [number, number, number] }>;
  zones: Record<string, Zone>;
  substrate: Substrate;
}

/* ------------------------------ helpers ------------------------------ */

function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function distToSeg(px: number, py: number, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

function distToPath(px: number, py: number, path: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < path.length; i++) d = Math.min(d, distToSeg(px, py, path[i]!, path[i + 1]!));
  return d;
}

const gauss = (d: number, sigma: number) => Math.exp(-((d / sigma) ** 2));

/** Scale normalized points to pixels. */
const px = (S: number, pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [x * S, y * S] as Pt);

function shadeField(S: number, fn: (u: number, v: number, x: number, y: number) => number): Float32Array {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) out[y * S + x] = fn((x + 0.5) / S, (y + 0.5) / S, x, y);
  }
  return out;
}

const zone = (x: number, y: number, w: number, h: number, anchor: Zone['anchor'] = 'center'): Zone => ({
  x,
  y,
  w,
  h,
  confidence: 1,
  anchor,
});

/* ------------------------------ builders ------------------------------ */

function teeBody(S: number, polo: boolean): { body: Mask; extraShade: (u: number, v: number) => number } {
  const neckArc = ellipsePts(0.5, polo ? 0.13 : 0.14, 0.1, polo ? 0.001 : 0.07, 24, 0, Math.PI);
  const outline: Pt[] = [
    [0.6, polo ? 0.13 : 0.14],
    [0.75, 0.19],
    [0.92, 0.33],
    [0.83, 0.44],
    [0.73, 0.38],
    [0.73, 0.9],
    [0.27, 0.9],
    [0.27, 0.38],
    [0.17, 0.44],
    [0.08, 0.33],
    [0.25, 0.19],
    [0.4, polo ? 0.13 : 0.14],
    ...neckArc.slice().reverse().slice(1, -1),
  ];
  let body = polygonMask(S, S, px(S, outline));
  const folds: Array<[Pt, Pt]> = [
    [[0.31, 0.56], [0.44, 0.88]],
    [[0.69, 0.5], [0.6, 0.86]],
    [[0.47, 0.62], [0.52, 0.86]],
  ];
  const seams: Array<[Pt, Pt]> = [
    [[0.25, 0.19], [0.27, 0.38]],
    [[0.75, 0.19], [0.73, 0.38]],
    [[0.27, 0.875], [0.73, 0.875]],
    [[0.12, 0.37], [0.2, 0.425]],
    [[0.88, 0.37], [0.8, 0.425]],
  ];
  if (!polo) {
    const backNeck = subtract(polygonMask(S, S, px(S, ellipsePts(0.5, 0.152, 0.096, 0.068))), body); // must extend past the collar arc (bottom 0.21)
    body = addComplementary(body, backNeck);
  }
  const collarArc = ellipsePts(0.5, 0.14, 0.1, 0.07, 24, 0, Math.PI);
  const extraShade = (u: number, v: number): number => {
    let s = 1.03 - 0.08 * v;
    const inTorso = u >= 0.27 && u <= 0.73 && v >= 0.18;
    if (inTorso) {
      const dx = (u - 0.5) / 0.23;
      s *= 1 - 0.13 * dx ** 4;
    } else if (v > 0.19) s *= 0.93;
    for (const [a, b] of folds) {
      const d = distToSeg(u, v, a, b);
      s *= 1 - 0.045 * gauss(d, 0.02);
      s *= 1 + 0.02 * gauss(d - 0.028, 0.016);
    }
    for (const [a, b] of seams) s *= 1 - 0.1 * gauss(distToSeg(u, v, a, b), 0.005);
    if (!polo) {
      // back of neck visible through opening is in shadow; front collar rib is a raised band
      const dy = (v - 0.152) / 0.068;
      const dxn = (u - 0.5) / 0.096;
      const insideEllipse = dxn * dxn + dy * dy < 1;
      const belowArc = v > 0.14 + 0.07 * Math.sqrt(Math.max(0, 1 - ((u - 0.5) / 0.1) ** 2));
      if (insideEllipse && !belowArc) s *= 0.6;
      s *= 1 - 0.12 * gauss(distToPath(u, v, collarArc) - 0.012, 0.004);
      s *= 1 + 0.03 * gauss(distToPath(u, v, collarArc) - 0.006, 0.005);
    }
    return s;
  };
  return { body, extraShade };
}

function tee(S: number): ProductTemplate {
  const { body, extraShade } = teeBody(S, false);
  return {
    kind: 'tee',
    width: S,
    height: S,
    body,
    shade: shadeField(S, (u, v) => extraShade(u, v)),
    fixed: [],
    zones: {
      full_front: zone(0.33, 0.27, 0.34, 0.4, 'top'),
      left_chest: zone(0.575, 0.26, 0.13, 0.11),
    },
    substrate: 'fabric',
  };
}

function polo(S: number): ProductTemplate {
  const { body: shirt, extraShade } = teeBody(S, true);
  const backBand = polygonMask(S, S, px(S, [[0.39, 0.1], [0.61, 0.1], [0.6, 0.135], [0.4, 0.135]]));
  const flapL: Pt[] = [[0.39, 0.12], [0.5, 0.2], [0.465, 0.255], [0.355, 0.2]];
  const flapR: Pt[] = flapL.map(([x, y]) => [1 - x, y] as Pt);
  const flaps = union(polygonMask(S, S, px(S, flapL)), polygonMask(S, S, px(S, flapR)));
  const body = union(union(shirt, backBand), flaps);
  const buttons = union(
    polygonMask(S, S, px(S, ellipsePts(0.5, 0.25, 0.008, 0.008, 20))),
    polygonMask(S, S, px(S, ellipsePts(0.5, 0.305, 0.008, 0.008, 20))),
  );
  const flapEdges: Pt[][] = [flapL, flapR].map((f) => [...f, f[0]!]);
  const shade = shadeField(S, (u, v) => {
    let s = extraShade(u, v);
    if (v < 0.137 && u > 0.39 && u < 0.61) s *= 0.8; // back collar band in shadow
    for (const e of flapEdges) s *= 1 - 0.18 * gauss(distToPath(u, v, e), 0.0045);
    // placket
    if (u > 0.485 && u < 0.515 && v > 0.2 && v < 0.34) s *= 0.97;
    s *= 1 - 0.12 * gauss(distToPath(u, v, [[0.485, 0.2], [0.485, 0.34], [0.515, 0.34], [0.515, 0.2]]), 0.003);
    // flap cast shadow
    s *= 1 - 0.1 * gauss(distToPath(u, v, [[0.355, 0.205], [0.465, 0.262], [0.535, 0.262], [0.645, 0.205]]), 0.012);
    return s;
  });
  return {
    kind: 'polo',
    width: S,
    height: S,
    body,
    shade,
    fixed: [{ mask: buttons, rgb: [236, 236, 232] }],
    zones: {
      left_chest: zone(0.585, 0.29, 0.12, 0.1),
      full_front: zone(0.33, 0.36, 0.34, 0.34, 'top'),
    },
    substrate: 'fabric',
  };
}

function cap(S: number): ProductTemplate {
  const crownPts: Pt[] = [...ellipsePts(0.5, 0.64, 0.3, 0.37, 64, Math.PI, Math.PI * 2)];
  const brimPts: Pt[] = [...ellipsePts(0.5, 0.63, 0.35, 0.12, 64, 0, Math.PI)];
  const crown = polygonMask(S, S, px(S, crownPts));
  const brim = polygonMask(S, S, px(S, brimPts));
  const button = polygonMask(S, S, px(S, ellipsePts(0.5, 0.272, 0.022, 0.014, 24)));
  const body = union(union(crown, brim), button);
  const seamC: Pt[] = [[0.5, 0.28], [0.5, 0.64]];
  const seamL: Pt[] = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    return [0.5 - 0.2 * Math.sin(t * Math.PI * 0.5), 0.28 + 0.36 * t] as Pt;
  });
  const seamR: Pt[] = seamL.map(([x, y]) => [1 - x, y] as Pt);
  const shade = shadeField(S, (u, v) => {
    if (v < 0.64 + 1e-3 && ((u - 0.5) / 0.3) ** 2 + ((v - 0.64) / 0.37) ** 2 <= 1.02) {
      const dx = (u - 0.5) / 0.3;
      const dy = (v - 0.55) / 0.37;
      let s = 1.06 - 0.3 * Math.min(1, dx * dx + dy * dy) ** 1.4;
      s *= 1 - 0.15 * gauss(distToPath(u, v, seamC), 0.004);
      s *= 1 - 0.15 * gauss(distToPath(u, v, seamL), 0.004);
      s *= 1 - 0.15 * gauss(distToPath(u, v, seamR), 0.004);
      s *= 1 - 0.25 * gauss(v - 0.635, 0.006); // sweatband line
      if (((u - 0.5) / 0.022) ** 2 + ((v - 0.272) / 0.014) ** 2 < 1) s *= 0.85;
      for (const ex of [0.36, 0.64]) s *= 1 - 0.5 * gauss(Math.hypot(u - ex, v - 0.4), 0.006); // eyelets
      return s;
    }
    const dx = (u - 0.5) / 0.35;
    const vn = (v - 0.63) / 0.12;
    return (0.82 + 0.1 * (1 - dx * dx)) * (1 - 0.25 * gauss(vn - 0.93, 0.08)) * (1 - 0.1 * gauss(distToPath(u, v, ellipsePts(0.5, 0.63, 0.32, 0.1, 40, 0.15, Math.PI - 0.15)), 0.003));
  });
  return {
    kind: 'cap',
    width: S,
    height: S,
    body,
    shade,
    fixed: [],
    zones: { front_panel: zone(0.38, 0.39, 0.24, 0.17) },
    substrate: 'fabric',
  };
}

function tumbler(S: number): ProductTemplate {
  const bodyPts: Pt[] = [
    [0.3, 0.215],
    [0.7, 0.215],
    [0.655, 0.885],
    ...ellipsePts(0.5, 0.885, 0.155, 0.025, 24, 0, Math.PI).slice(1, -1),
    [0.345, 0.885],
  ];
  const body = polygonMask(S, S, px(S, bodyPts));
  const lid = union(
    polygonMask(S, S, px(S, roundRectPts(0.285, 0.14, 0.43, 0.09, 0.02))),
    polygonMask(S, S, px(S, roundRectPts(0.37, 0.11, 0.26, 0.045, 0.015))),
  );
  const halfW = (v: number) => 0.2 - 0.045 * ((v - 0.215) / 0.67);
  const shade = shadeField(S, (u, v) => {
    const dx = (u - 0.5) / halfW(v);
    let s = 0.74 + 0.3 * Math.cos((Math.min(1, Math.abs(dx)) * Math.PI) / 2) ** 0.6;
    s += 0.5 * gauss(dx + 0.52, 0.075) + 0.22 * gauss(dx - 0.6, 0.05) + 0.08 * gauss(dx + 0.1, 0.15);
    s *= 1 - 0.18 * gauss(v - 0.228, 0.008); // lid shadow
    return s;
  });
  return {
    kind: 'tumbler',
    width: S,
    height: S,
    body: subtract(body, lid),
    shade,
    fixed: [{ mask: lid, rgb: [31, 35, 43] }],
    zones: {
      wrap: zone(0.385, 0.4, 0.23, 0.27),
      one_side: zone(0.385, 0.4, 0.23, 0.27),
    },
    substrate: 'metal',
  };
}

function tote(S: number): ProductTemplate {
  const bag = polygonMask(S, S, px(S, [[0.245, 0.35], [0.755, 0.35], [0.77, 0.9], [0.23, 0.9]]));
  const handleBack = polygonMask(S, S, px(S, strokePts(ellipsePts(0.5, 0.36, 0.13, 0.22, 48, Math.PI, Math.PI * 2), 0.028)));
  const handleFront = polygonMask(S, S, px(S, strokePts(ellipsePts(0.5, 0.37, 0.15, 0.24, 48, Math.PI * 1.02, Math.PI * 1.98), 0.03)));
  const body = union(union(bag, handleBack), handleFront);
  const shade = shadeField(S, (u, v, x, y) => {
    const onBag = v >= 0.35;
    let s = onBag ? 1.0 : 0.94;
    if (!onBag && Math.abs(Math.hypot((u - 0.5) / 0.13, (v - 0.36) / 0.22) - 1) < 0.07) s = 0.8; // back handle
    s *= 1 + 0.04 * Math.sin(x * 2.3) * Math.sin(y * 2.3) + 0.02 * (hash01(x, y) - 0.5);
    if (onBag) {
      const dx = (u - 0.5) / 0.26;
      s *= 1 - 0.1 * dx ** 6;
      s *= 1 - 0.12 * gauss(v - 0.385, 0.004); // top hem stitch
      s *= 1 - 0.08 * gauss(v - 0.35, 0.01);
      for (const hx of [0.37, 0.63]) s *= 1 - 0.12 * gauss(Math.abs(u - hx) - 0.015, 0.003) * (v < 0.43 ? 1 : 0);
    }
    return s;
  });
  return {
    kind: 'tote',
    width: S,
    height: S,
    body,
    shade,
    fixed: [],
    zones: { center_front: zone(0.32, 0.45, 0.36, 0.36, 'top') },
    substrate: 'canvas',
  };
}

function journal(S: number): ProductTemplate {
  const cover = polygonMask(S, S, px(S, roundRectPts(0.28, 0.14, 0.44, 0.72, 0.018)));
  const pages = polygonMask(S, S, px(S, [[0.715, 0.16], [0.735, 0.17], [0.735, 0.84], [0.715, 0.85]]));
  const shade = shadeField(S, (u, v, x, y) => {
    let s = 1.02 - 0.06 * v;
    if (u < 0.325) s *= 0.8; // spine wrap
    s *= 1 - 0.2 * gauss(u - 0.325, 0.003);
    if (u > 0.63 && u < 0.652) s *= 0.72; // elastic band
    s *= 1 - 0.15 * gauss(Math.abs(u - 0.641) - 0.011, 0.002);
    s *= 1 + 0.03 * (hash01(x, y) - 0.5);
    return s;
  });
  return {
    kind: 'journal',
    width: S,
    height: S,
    body: subtract(cover, pages),
    shade,
    fixed: [{ mask: pages, rgb: [240, 234, 216] }],
    zones: { front_cover: zone(0.37, 0.33, 0.24, 0.22) },
    substrate: 'paper',
  };
}

const BUILDERS: Record<TemplateKind, (S: number) => ProductTemplate> = { tee, polo, cap, tumbler, tote, journal };
const cache = new Map<string, ProductTemplate>();

export function getTemplate(kind: TemplateKind, size = 420): ProductTemplate {
  const key = `${kind}:${size}`;
  let t = cache.get(key);
  if (!t) {
    t = BUILDERS[kind](size);
    cache.set(key, t);
  }
  return t;
}

/**
 * Build every template once (≈1.5 s total, cached per process) so the first prospect after a
 * deploy doesn't pay it on their first proof. Call at server start.
 */
export function warmTemplates(size = 420): void {
  for (const k of Object.keys(BUILDERS) as TemplateKind[]) getTemplate(k, size);
}

/** Apply shading to a colour: s ≤ 1 darkens multiplicatively, s > 1 mixes toward white. */
export function shadeChannel(c: number, s: number): number {
  return s <= 1 ? c * s : c + (255 - c) * Math.min(1, s - 1);
}

/** Render a colourway of a template (transparent background). */
export function colorway(t: ProductTemplate, hex: string): Raster {
  const [r, g, b] = parseHex(hex);
  const out = createRaster(t.width, t.height);
  for (let p = 0; p < t.width * t.height; p++) {
    const i = p * 4;
    const a = t.body.data[p]!;
    if (a > 0) {
      const s = t.shade[p]!;
      out.data[i] = shadeChannel(r, s);
      out.data[i + 1] = shadeChannel(g, s);
      out.data[i + 2] = shadeChannel(b, s);
      out.data[i + 3] = a * 255;
    }
    for (const f of t.fixed) {
      const fa = f.mask.data[p]!;
      if (fa <= 0) continue;
      const s = Math.min(1.1, t.shade[p]! * 0.5 + 0.5);
      const da = out.data[i + 3]! / 255;
      const oa = fa + da * (1 - fa);
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = (shadeChannel(f.rgb[c]!, s) * fa + out.data[i + c]! * da * (1 - fa)) / oa;
      }
      out.data[i + 3] = oa * 255;
    }
  }
  return out;
}

export { createMask };
