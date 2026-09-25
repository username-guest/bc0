/**
 * Pricing types. MONEY IS INTEGER CENTS everywhere in this module to avoid float drift.
 * Format to currency only at the UI edge.
 */
export type Cents = number;

export type DecorationMethodKey =
  | 'screen_print'
  | 'embroidery'
  | 'dtg'
  | 'dtf'
  | 'sublimation'
  | 'laser_engraving'
  | 'pad_printing'
  | 'deboss_emboss'
  | 'heat_transfer_htv';

export type SizeTier = 'small' | 'medium' | 'large';

export interface QuantityBreak {
  minQty: number;
  blankUnitCost: Cents; // per-unit blank cost at this break
}

export interface Imprint {
  widthIn: number;
  heightIn: number;
}

export type RoundingMode = 'none' | 'nearest_cent' | 'nearest_5c' | 'charm_95';

export interface TenantPricingConfig {
  currency: string; // e.g. 'USD'
  marginMarkup: number; // 1.4 == 40% markup on blanks
  categoryMarkupOverrides?: Record<string, number>;
  decorationMarkup: number; // default 1.0 — many distributors also mark up decoration
  rounding: RoundingMode;
  fees: {
    ltmFee: Cents; // less-than-minimum (applied when qty < methodMoq)
    pmsMatchFee: Cents; // per matched color, one-time
    personalizationPerUnit: Cents;
    rush: { mode: 'none' | 'percent' | 'flat'; percent?: number; flat?: Cents };
  };
  showItemizedToProspect: boolean;
  /**
   * The distributor's own decoration rate tables. Absent → the PLACEHOLDER tables (and the
   * placeholder disclaimer). Stored whole; see `resolveRates` for tolerance of older data.
   */
  rates?: DecorationRates;
}

/** Per-size run charge (DTG / DTF / sublimation): cents per unit per location. */
export interface SizeRates {
  small: Cents;
  medium: Cents;
  large: Cents;
}

/** Every rate the decoration modules use, in integer cents. Admin-editable per tenant. */
export interface DecorationRates {
  screen_print: {
    screenChargePerColor: Cents; // per colour, per location, one-time
    /** Run charge per unit: base + perColor × effective colours, by quantity tier. */
    runByBreak: { minQty: number; base: Cents; perColor: Cents }[];
  };
  embroidery: {
    digitizingFee: Cents;
    ratePer1kStitches: Cents; // per 1,000 stitches, per location
    includedThreadColors: number;
    extraThreadColorFee: Cents; // one-time, per colour beyond included
  };
  dtg: { perUnitBySize: SizeRates; darkSurchargePerUnit: Cents };
  dtf: { perUnitBySize: SizeRates };
  sublimation: { perUnitBySize: SizeRates };
  laser_engraving: { setup: Cents; perUnit: Cents };
  pad_printing: { setupPerColor: Cents; perUnit: Cents };
  deboss_emboss: { dieSetup: Cents; perUnit: Cents };
  heat_transfer_htv: { setup: Cents; perUnit: Cents };
}

export interface PriceRequest {
  category: string;
  quantity: number;
  method: DecorationMethodKey;
  colorCount: number; // logo colors (screen/pad); thread colors (embroidery)
  isDarkGarment?: boolean; // screen underbase / DTG pretreat
  locations: number;
  imprint: Imprint;
  stitchCount?: number; // embroidery; estimated from imprint if absent
  methodMoq: number;
  breaks: QuantityBreak[];
  addPmsMatch?: boolean;
  personalization?: boolean;
  rush?: boolean;
}

export type LineKind =
  | 'blank'
  | 'margin'
  | 'decoration_setup'
  | 'decoration_run'
  | 'fee';

export interface PriceLine {
  label: string;
  kind: LineKind;
  amount: Cents;
  perUnit?: Cents;
  note?: string;
}

export interface PriceQuote {
  currency: string;
  quantity: number;
  appliedBreakMinQty: number;
  lines: PriceLine[];
  subtotals: {
    blanksAtCost: Cents;
    margin: Cents;
    decorationSetup: Cents;
    decorationRun: Cents;
    fees: Cents;
  };
  total: Cents;
  effectiveUnit: Cents; // total / quantity, rounded for display
  estimated: true;
  disclaimer: string;
  itemizedVisibleToProspect: boolean;
}

/** Per-method decoration module contract — each method is a pluggable module (§3.1). */
export interface DecorationCost {
  setup: Cents; // one-time
  runPerUnit: Cents;
  notes: string[];
}
