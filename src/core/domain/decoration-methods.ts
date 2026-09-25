/**
 * Canonical decoration-method registry (§3.1). Global reference data — NOT tenant-scoped.
 * The pricing engine (src/pricing) owns the *math*; this module owns the *domain facts*
 * (labels, MOQ defaults, substrate constraints, color/visual traits) used for catalog display,
 * compatibility filtering (§5: "sublimation hidden on dark cotton"), and seeding.
 *
 * Keys are the single source of truth and match `DecorationMethodKey` in src/pricing/types.ts.
 */
import type { DecorationMethodKey } from '@/pricing/types';

export interface DecorationMethodMeta {
  key: DecorationMethodKey;
  label: string;
  bestFor: string;
  /** Pricing shape, for UI hints only — the engine implements the real math. */
  pricingShape: 'setup_plus_run' | 'run_only';
  defaultMoq: number;
  maxColors: number | 'full_color';
  /** Hard substrate rules used to filter incompatible method/product combos. */
  constraints: {
    polyesterOrCoatedOnly?: boolean; // sublimation
    cannotPrintWhite?: boolean; // sublimation
    cannotDoDarkGarments?: boolean; // sublimation
    hardGoodsOnly?: boolean; // laser, pad, deboss
    apparelOnly?: boolean; // screen, dtg, htv
  };
  visualTraits: string;
}

export const DECORATION_METHODS: Record<DecorationMethodKey, DecorationMethodMeta> = {
  screen_print: {
    key: 'screen_print',
    label: 'Screen Printing',
    bestFor: 'Apparel, flat fabric',
    pricingShape: 'setup_plus_run',
    defaultMoq: 12,
    maxColors: 8,
    constraints: { apparelOnly: true },
    visualTraits: 'Flat, matte, opaque ink; spot colors; limited color count. Dark garments add a white underbase (+1 effective color).',
  },
  embroidery: {
    key: 'embroidery',
    label: 'Embroidery',
    bestFor: 'Polos, caps, bags, outerwear, patches',
    pricingShape: 'setup_plus_run',
    defaultMoq: 12,
    maxColors: 15,
    constraints: {},
    visualTraits: 'Raised thread texture; premium feel; thread-color matching (Madeira/Isacord). Priced by stitch count.',
  },
  dtg: {
    key: 'dtg',
    label: 'DTG (Direct-to-Garment)',
    bestFor: 'Cotton apparel, low quantity, full color',
    pricingShape: 'run_only',
    defaultMoq: 1,
    maxColors: 'full_color',
    constraints: { apparelOnly: true },
    visualTraits: 'Photographic, gradients, unlimited color; soft hand. Darks need pretreat/underbase.',
  },
  dtf: {
    key: 'dtf',
    label: 'DTF (Direct-to-Film) Transfer',
    bestFor: 'Wide fabric range, heat-pressed',
    pricingShape: 'run_only',
    defaultMoq: 1,
    maxColors: 'full_color',
    constraints: {},
    visualTraits: 'Full color; slight sheen; durable. Minimal/no setup.',
  },
  sublimation: {
    key: 'sublimation',
    label: 'Sublimation',
    bestFor: 'Polyester/poly-coated & light substrates; performance wear, mugs, mousepads, lanyards',
    pricingShape: 'run_only',
    defaultMoq: 12,
    maxColors: 'full_color',
    constraints: { polyesterOrCoatedOnly: true, cannotPrintWhite: true, cannotDoDarkGarments: true },
    visualTraits: 'Full color, permanent, no hand; supports all-over prints. Cannot print white or on dark.',
  },
  laser_engraving: {
    key: 'laser_engraving',
    label: 'Laser Engraving',
    bestFor: 'Drinkware, pens, metal, wood, leather, awards',
    pricingShape: 'setup_plus_run',
    defaultMoq: 12,
    maxColors: 1,
    constraints: { hardGoodsOnly: true },
    visualTraits: 'Monochromatic etched/burned look; premium. Single "etch color".',
  },
  pad_printing: {
    key: 'pad_printing',
    label: 'Pad Printing',
    bestFor: 'Curved/small hard goods (pens, golf balls, electronics)',
    pricingShape: 'setup_plus_run',
    defaultMoq: 24,
    maxColors: 4,
    constraints: { hardGoodsOnly: true },
    visualTraits: 'Spot color; small imprint footprint.',
  },
  deboss_emboss: {
    key: 'deboss_emboss',
    label: 'Deboss / Emboss',
    bestFor: 'Leather, journals, PU',
    pricingShape: 'setup_plus_run',
    defaultMoq: 24,
    maxColors: 1,
    constraints: { hardGoodsOnly: true },
    visualTraits: 'Recessed/raised impression; usually blind (no ink).',
  },
  heat_transfer_htv: {
    key: 'heat_transfer_htv',
    label: 'Heat Transfer / HTV Vinyl',
    bestFor: 'Names/numbers, small runs',
    pricingShape: 'setup_plus_run',
    defaultMoq: 1,
    maxColors: 3,
    constraints: { apparelOnly: true },
    visualTraits: 'Spot color; solid. Small setup.',
  },
};

export const DECORATION_METHOD_KEYS = Object.keys(DECORATION_METHODS) as DecorationMethodKey[];

/**
 * Compatibility check used by the catalog to hide impossible combos (§5).
 * `productTraits` come from the seeded product row.
 */
export function isMethodCompatible(
  method: DecorationMethodKey,
  productTraits: { isApparel: boolean; isHardGood: boolean; isPolyester: boolean; isDark: boolean },
): boolean {
  const c = DECORATION_METHODS[method].constraints;
  if (c.apparelOnly && !productTraits.isApparel) return false;
  if (c.hardGoodsOnly && !productTraits.isHardGood) return false;
  if (c.polyesterOrCoatedOnly && !productTraits.isPolyester) return false;
  if (c.cannotDoDarkGarments && productTraits.isDark) return false;
  return true;
}

export function isDecorationMethodKey(x: string): x is DecorationMethodKey {
  return x in DECORATION_METHODS;
}
