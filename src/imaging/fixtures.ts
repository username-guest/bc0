/**
 * Deterministic sample logo for tests and the offline demo. Deliberately exercises the hard
 * parts of real uploads: a white background to remove, anti-aliased edges (many in-between
 * colours), exactly three spot inks, and an ENCLOSED white area inside the ring (the counter
 * ambiguity handled in background.ts).
 */
import { createRaster, type Raster } from './raster';
import { ellipsePts, polygonMask, roundRectPts, type Mask, subtract } from './draw';
import { parseHex } from './palette';

export const SAMPLE_LOGO_INKS = {
  navy: '#1B2A4A',
  red: '#D7263D',
  gold: '#F2A900',
} as const;

function paint(r: Raster, m: Mask, hex: string): void {
  const [cr, cg, cb] = parseHex(hex);
  for (let p = 0; p < m.data.length; p++) {
    const a = m.data[p]!;
    if (a <= 0) continue;
    const i = p * 4;
    r.data[i] = cr * a + r.data[i]! * (1 - a);
    r.data[i + 1] = cg * a + r.data[i + 1]! * (1 - a);
    r.data[i + 2] = cb * a + r.data[i + 2]! * (1 - a);
  }
}

export function sampleLogo(width = 600, height = 300, bg: [number, number, number] = [255, 255, 255]): Raster {
  const r = createRaster(width, height, [bg[0], bg[1], bg[2], 255]);
  const sx = width / 600;
  const sy = height / 300;
  const e = (cx: number, cy: number, rad: number) => ellipsePts(cx * sx, cy * sy, rad * sx, rad * sy, 128);
  const ring = subtract(polygonMask(width, height, e(150, 150, 110)), polygonMask(width, height, e(150, 150, 62)));
  paint(r, ring, SAMPLE_LOGO_INKS.red);
  paint(r, polygonMask(width, height, e(150, 150, 30)), SAMPLE_LOGO_INKS.gold);
  for (const [x, y, w, h] of [
    [290, 80, 270, 42],
    [290, 138, 205, 42],
    [290, 196, 140, 30],
  ] as const) {
    paint(r, polygonMask(width, height, roundRectPts(x * sx, y * sy, w * sx, h * sy, 10 * sx)), SAMPLE_LOGO_INKS.navy);
  }
  return r;
}
