/**
 * Color families for faceted search (§3.4). Every named product color maps to EXACTLY one family.
 * `mapColorToFamily` assigns by nearest anchor in a weighted RGB space — good enough for facet
 * bucketing and deterministic (no model needed). Anchors are illustrative and admin-tunable later.
 *
 * The families list is copied verbatim from §3.4 (15 families). It is reference data: it is global,
 * NOT tenant-scoped, and seeded once.
 */
export const COLOR_FAMILIES = [
  { key: 'black', label: 'Black', anchor: '#000000' },
  { key: 'white_neutral', label: 'White/Neutral', anchor: '#F5F3EC' },
  { key: 'gray', label: 'Gray', anchor: '#808080' },
  { key: 'navy', label: 'Navy', anchor: '#1B2A4A' },
  { key: 'royal_blue', label: 'Royal/Blue', anchor: '#1F45C6' },
  { key: 'light_blue', label: 'Light Blue', anchor: '#8EC6E6' },
  { key: 'teal', label: 'Teal', anchor: '#0E8C8C' },
  { key: 'green', label: 'Green (Forest/Kelly/Lime)', anchor: '#2E8B2E' },
  { key: 'yellow_gold', label: 'Yellow/Gold', anchor: '#F2C21A' },
  { key: 'orange', label: 'Orange', anchor: '#E8722A' },
  { key: 'red', label: 'Red', anchor: '#C6242A' },
  { key: 'maroon', label: 'Maroon', anchor: '#6E1F2A' },
  { key: 'pink', label: 'Pink', anchor: '#E88AB0' },
  { key: 'purple', label: 'Purple', anchor: '#6B3FA0' },
  { key: 'brown_tan', label: 'Brown/Tan', anchor: '#8A6A45' },
] as const;

export type ColorFamilyKey = (typeof COLOR_FAMILIES)[number]['key'];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (mx === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/**
 * Map any hex color to exactly one family (§3.4).
 *
 * A pure nearest-RGB-anchor assignment mis-buckets desaturated colors (charcoal → navy, khaki →
 * pink) because RGB distance conflates hue with lightness. This classifier instead works in HSL:
 * it peels off near-white / near-black / low-saturation neutrals first, routes muted warm colors
 * to brown/tan, then assigns the remaining saturated colors by hue band, using lightness to split
 * the dark/light variants within a band (navy vs royal vs light-blue; maroon vs red).
 *
 * Validated to map all 15 family anchors to themselves and to bucket the seeded catalog colors
 * sensibly. Thresholds are heuristic and intentionally simple — this is admin-tunable reference
 * data for faceting, not a colorimetric guarantee.
 */
export function mapColorToFamily(hex: string): ColorFamilyKey {
  const { h, s, l } = rgbToHsl(hexToRgb(hex));

  // Near-white / near-black dominate regardless of a faint tint.
  if (l > 0.88) return 'white_neutral';
  if (l > 0.85 && s < 0.45) return 'white_neutral';
  if (l < 0.08) return 'black';

  // Low-saturation neutrals split by lightness.
  if (s < 0.12) {
    if (l < 0.2) return 'black';
    if (l > 0.82) return 'white_neutral';
    return 'gray';
  }

  // Muted warm mid-tones read as brown/tan (khaki, camel, tan).
  if (h >= 20 && h < 70 && s < 0.45 && l >= 0.3 && l <= 0.75) return 'brown_tan';

  // Saturated colors by hue band; lightness disambiguates dark/light siblings.
  if (h < 11 || h >= 345) return l < 0.3 ? 'maroon' : 'red';
  if (h < 41) return l < 0.32 ? 'brown_tan' : 'orange';
  if (h < 64) return 'yellow_gold';
  if (h < 160) return 'green';
  if (h < 196) return 'teal';
  if (h < 256) {
    if (l < 0.3) return 'navy';
    if (l > 0.68) return 'light_blue';
    return 'royal_blue';
  }
  if (h < 292) return 'purple';
  // Magenta/rose band.
  if (l < 0.32) return 'maroon';
  return 'pink';
}

export function isColorFamilyKey(x: string): x is ColorFamilyKey {
  return COLOR_FAMILIES.some((f) => f.key === x);
}
