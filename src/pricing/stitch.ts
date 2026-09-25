/** Stitch-count estimation for embroidery (§3.1, §12). PLACEHOLDER densities. */
export type StitchDensity = 'light' | 'standard' | 'dense';

const STITCHES_PER_SQ_IN: Record<StitchDensity, number> = {
  light: 1200,
  standard: 1800,
  dense: 2600,
};

export function estimateStitchCount(
  widthIn: number,
  heightIn: number,
  density: StitchDensity = 'standard',
  complexity = 1,
): number {
  const area = Math.max(0, widthIn) * Math.max(0, heightIn);
  return Math.round(area * STITCHES_PER_SQ_IN[density] * complexity);
}

/** Imprint area → size tier for per-size decoration pricing (DTG/DTF/sublimation). */
export function sizeTier(widthIn: number, heightIn: number): 'small' | 'medium' | 'large' {
  const area = widthIn * heightIn;
  if (area <= 12) return 'small';
  if (area <= 45) return 'medium';
  return 'large';
}
