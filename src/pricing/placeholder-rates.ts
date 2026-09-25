import type { Cents, DecorationMethodKey, DecorationRates, TenantPricingConfig } from './types';

/**
 * ⚠️ PLACEHOLDER RATE TABLES — illustrative only. NOT real supplier pricing (§8, §17).
 * Admins edit these per tenant; real data arrives later via PricingProvider.
 * Every quote built from these is flagged `estimated` with a disclaimer.
 */
export const PLACEHOLDER_RATES: DecorationRates = {
  screen_print: {
    screenChargePerColor: 2000 as Cents, // per color, per location, one-time
    // run charge per unit falls as qty rises, rises with color count
    runByBreak: [
      { minQty: 12, base: 120, perColor: 60 },
      { minQty: 24, base: 90, perColor: 45 },
      { minQty: 48, base: 70, perColor: 35 },
      { minQty: 72, base: 55, perColor: 28 },
      { minQty: 144, base: 40, perColor: 20 },
      { minQty: 288, base: 30, perColor: 15 },
      { minQty: 576, base: 22, perColor: 11 },
    ],
  },
  embroidery: {
    digitizingFee: 4500 as Cents, // one-time
    ratePer1kStitches: 90 as Cents, // per 1,000 stitches, per location
    includedThreadColors: 7,
    extraThreadColorFee: 1500 as Cents, // per color beyond included, one-time
  },
  dtg: {
    perUnitBySize: { small: 650, medium: 900, large: 1200 },
    darkSurchargePerUnit: 200 as Cents, // pretreat/underbase
  },
  dtf: {
    perUnitBySize: { small: 450, medium: 700, large: 1000 },
  },
  sublimation: {
    perUnitBySize: { small: 500, medium: 800, large: 1300 },
  },
  laser_engraving: { setup: 5000 as Cents, perUnit: 300 as Cents },
  pad_printing: { setupPerColor: 3500 as Cents, perUnit: 150 as Cents },
  deboss_emboss: { dieSetup: 8000 as Cents, perUnit: 250 as Cents },
  heat_transfer_htv: { setup: 1500 as Cents, perUnit: 400 as Cents },
};

export const IS_PLACEHOLDER = true;

/** Default tenant config — also PLACEHOLDER; admin-editable. */
export const PLACEHOLDER_TENANT_CONFIG = {
  currency: 'USD',
  marginMarkup: 1.4,
  decorationMarkup: 1.0,
  rounding: 'none' as const,
  fees: {
    ltmFee: 5000 as Cents,
    pmsMatchFee: 2500 as Cents,
    personalizationPerUnit: 100 as Cents,
    rush: { mode: 'none' as const },
  },
  showItemizedToProspect: true,
};

export type MethodRates = DecorationRates;

/**
 * A tenant's effective rates: its own table per method, the placeholder table for any method it
 * hasn't set (e.g. configs saved before per-tenant rates existed).
 */
export function resolveRates(r: Partial<DecorationRates> | undefined): DecorationRates {
  return { ...PLACEHOLDER_RATES, ...(r ?? {}) };
}

export function usesOwnRates(cfg: TenantPricingConfig): boolean {
  return !!cfg.rates;
}
export type KnownMethod = DecorationMethodKey;
