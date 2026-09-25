/**
 * Anti-aliased coverage masks (0..1) via 4×4 supersampled scanline fill (even-odd rule).
 * Used to build procedural product templates; also usable for print-area overlays in admin UI.
 */
export interface Mask {
  width: number;
  height: number;
  data: Float32Array; // coverage 0..1
}

export type Pt = readonly [number, number];

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Float32Array(width * height) };
}

const SS = 4;

/** Coverage of one polygon (even-odd). Returned as a fresh mask. */
export function polygonMask(width: number, height: number, pts: readonly Pt[]): Mask {
  const m = createMask(width, height);
  const n = pts.length;
  const w = 1 / (SS * SS);
  const xs: number[] = [];
  for (let sy = 0; sy < height * SS; sy++) {
    const y = (sy + 0.5) / SS;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i]!;
      const [x1, y1] = pts[(i + 1) % n]!;
      if (y0 <= y !== y1 <= y) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = Math.floor(sy / SS) * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! * SS - 0.5));
      const b = Math.min(width * SS - 1, Math.floor(xs[k + 1]! * SS - 0.5));
      for (let sx = a; sx <= b; sx++) m.data[row + Math.floor(sx / SS)]! += w;
    }
  }
  for (let i = 0; i < m.data.length; i++) m.data[i] = Math.min(1, m.data[i]!);
  return m;
}

export function ellipsePts(cx: number, cy: number, rx: number, ry: number, segs = 96, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const pts: Pt[] = [];
  const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-9;
  const count = full ? segs : segs + 1;
  for (let i = 0; i < count; i++) {
    const t = a0 + ((a1 - a0) * i) / segs;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

export function roundRectPts(x: number, y: number, w: number, h: number, r: number, segs = 10): Pt[] {
  const rr = Math.min(r, w / 2, h / 2);
  const pts: Pt[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= segs; i++) {
      const t = a0 + (Math.PI / 2) * (i / segs);
      pts.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
    }
  };
  corner(x + w - rr, y + rr, -Math.PI / 2);
  corner(x + w - rr, y + h - rr, 0);
  corner(x + rr, y + h - rr, Math.PI / 2);
  corner(x + rr, y + rr, Math.PI);
  return pts;
}

/** Thick polyline as a polygon strip (for handles, seams). */
export function strokePts(path: readonly Pt[], thickness: number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i]!;
    const [px, py] = path[Math.max(0, i - 1)]!;
    const [nx, ny] = path[Math.min(path.length - 1, i + 1)]!;
    let dx = nx - px;
    let dy = ny - py;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const hx = -dy * (thickness / 2);
    const hy = dx * (thickness / 2);
    left.push([x + hx, y + hy]);
    right.push([x - hx, y - hy]);
  }
  return [...left, ...right.reverse()];
}

/**
 * Coverage union as "a over b" (a + b − ab). NOT max(): max leaves a half-transparent seam where
 * two complementary anti-aliased edges meet (e.g. collar vs. body), which shows as a light line.
 */
export function union(a: Mask, b: Mask): Mask {
  const m = createMask(a.width, a.height);
  for (let i = 0; i < m.data.length; i++) {
    const x = a.data[i]!;
    const y = b.data[i]!;
    m.data[i] = x + y - x * y;
  }
  return m;
}

/**
 * Sum of coverages, clamped. The correct union when `b` was built as `something × (1 − a)`
 * (complementary edges): a + b − ab would under-count there and leave a translucent seam.
 */
export function addComplementary(a: Mask, b: Mask): Mask {
  const m = createMask(a.width, a.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = Math.min(1, a.data[i]! + b.data[i]!);
  return m;
}

export function subtract(a: Mask, b: Mask): Mask {
  const m = createMask(a.width, a.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = a.data[i]! * (1 - b.data[i]!);
  return m;
}
