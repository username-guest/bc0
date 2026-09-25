/**
 * Server-side validation for tenant pricing config (admin pricing, ADR 0009).
 *
 * Returns a normalised config (rebuilt field by field: unknown keys are dropped, never stored) or
 * errors keyed by field path, e.g. `rates.screen_print.runByBreak.2.minQty`. Money is integer
 * cents; bounds catch the classic slip of typing dollars into a cents field ×100 or vice versa.
 * Warnings are advisory (likely typos) and never block a save.
 */
import type { Cents, DecorationRates, RoundingMode, SizeRates, TenantPricingConfig } from './types';

export const MARKUP_MIN = 1;
export const MARKUP_MAX = 5; // 400% markup
export const MAX_SETUP: Cents = 500_000; // $5,000 one-time
export const MAX_PER_UNIT: Cents = 50_000; // $500 per unit
export const MAX_FEE: Cents = 100_000; // $1,000
const ROUNDING: readonly RoundingMode[] = ['none', 'nearest_cent', 'nearest_5c', 'charm_95'];

export type PricingValidation =
  | { ok: true; value: TenantPricingConfig; warnings: string[] }
  | { ok: false; errors: Record<string, string> };

export function validatePricingConfig(
  input: unknown,
  opts: { categories: readonly string[]; currency: string },
): PricingValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const o = isObj(input) ? input : {};

  const markup = (path: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < MARKUP_MIN || v > MARKUP_MAX) {
      errors[path] = 'Enter a markup from 0% to 400%.';
      return 1;
    }
    return Math.round(v * 10_000) / 10_000; // 0.01% precision
  };
  const cents = (path: string, v: unknown, max: Cents): Cents => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
      errors[path] = `Enter an amount from $0 to $${(max / 100).toLocaleString('en-US')}.`;
      return 0;
    }
    return v;
  };
  const int = (path: string, v: unknown, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      errors[path] = `Enter a whole number from ${min} to ${max.toLocaleString('en-US')}.`;
      return min;
    }
    return v;
  };

  const marginMarkup = markup('marginMarkup', o.marginMarkup);
  const decorationMarkup = markup('decorationMarkup', o.decorationMarkup);

  const overrides: Record<string, number> = {};
  if (o.categoryMarkupOverrides !== undefined) {
    if (!isObj(o.categoryMarkupOverrides)) errors.categoryMarkupOverrides = 'Invalid category markups.';
    else
      for (const [k, v] of Object.entries(o.categoryMarkupOverrides)) {
        if (!opts.categories.includes(k)) errors[`categoryMarkupOverrides.${k}`] = 'Unknown category.';
        else overrides[k] = markup(`categoryMarkupOverrides.${k}`, v);
      }
  }

  const rounding = ROUNDING.includes(o.rounding as RoundingMode) ? (o.rounding as RoundingMode) : ((errors.rounding = 'Choose a rounding option.'), 'none');
  const f = isObj(o.fees) ? o.fees : {};
  const rushIn = isObj(f.rush) ? f.rush : {};
  const rushMode = ['none', 'percent', 'flat'].includes(rushIn.mode as string) ? (rushIn.mode as 'none' | 'percent' | 'flat') : ((errors['fees.rush.mode'] = 'Choose how rush orders are charged.'), 'none');
  const rush: TenantPricingConfig['fees']['rush'] =
    rushMode === 'percent'
      ? { mode: 'percent', percent: pct('fees.rush.percent', rushIn.percent) }
      : rushMode === 'flat'
        ? { mode: 'flat', flat: cents('fees.rush.flat', rushIn.flat, MAX_FEE) }
        : { mode: 'none' };
  function pct(path: string, v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      errors[path] = 'Enter a percentage from 0 to 100.';
      return 0;
    }
    return Math.round(v * 100) / 100;
  }
  const fees = {
    ltmFee: cents('fees.ltmFee', f.ltmFee, MAX_FEE),
    pmsMatchFee: cents('fees.pmsMatchFee', f.pmsMatchFee, MAX_FEE),
    personalizationPerUnit: cents('fees.personalizationPerUnit', f.personalizationPerUnit, MAX_PER_UNIT),
    rush,
  };
  if (typeof o.showItemizedToProspect !== 'boolean') errors.showItemizedToProspect = 'Choose whether prospects see the breakdown.';

  // ---- decoration rates (all methods; the UI always sends the full table) ----
  const r = isObj(o.rates) ? o.rates : ((errors.rates = 'Rate tables are missing.'), {});
  const m = (k: string) => (isObj(r[k]) ? (r[k] as Record<string, unknown>) : ((errors[`rates.${k}`] ??= 'Missing.'), {}));
  const sizes = (path: string, v: unknown): SizeRates => {
    const s = isObj(v) ? v : {};
    return {
      small: cents(`${path}.small`, s.small, MAX_PER_UNIT),
      medium: cents(`${path}.medium`, s.medium, MAX_PER_UNIT),
      large: cents(`${path}.large`, s.large, MAX_PER_UNIT),
    };
  };

  const sp = m('screen_print');
  const tiersIn = Array.isArray(sp.runByBreak) ? sp.runByBreak : [];
  if (tiersIn.length < 1 || tiersIn.length > 12) errors['rates.screen_print.runByBreak'] = 'Add from 1 to 12 quantity tiers.';
  const tiers = tiersIn.slice(0, 12).map((t, i) => {
    const x = isObj(t) ? t : {};
    const p = `rates.screen_print.runByBreak.${i}`;
    return { minQty: int(`${p}.minQty`, x.minQty, 1, 100_000), base: cents(`${p}.base`, x.base, MAX_PER_UNIT), perColor: cents(`${p}.perColor`, x.perColor, MAX_PER_UNIT) };
  });
  tiers.forEach((t, i) => {
    const prev = tiers[i - 1];
    if (prev && t.minQty <= prev.minQty) errors[`rates.screen_print.runByBreak.${i}.minQty`] ??= 'Each tier must start at a higher quantity than the one before.';
    if (prev && t.base + t.perColor > prev.base + prev.perColor) warnings.push(`Screen print: the ${t.minQty}+ tier costs more per unit than the tier before it.`);
  });

  const em = m('embroidery');
  const dtgIn = m('dtg');
  const rates: DecorationRates = {
    screen_print: { screenChargePerColor: cents('rates.screen_print.screenChargePerColor', sp.screenChargePerColor, MAX_SETUP), runByBreak: tiers },
    embroidery: {
      digitizingFee: cents('rates.embroidery.digitizingFee', em.digitizingFee, MAX_SETUP),
      ratePer1kStitches: cents('rates.embroidery.ratePer1kStitches', em.ratePer1kStitches, MAX_PER_UNIT),
      includedThreadColors: int('rates.embroidery.includedThreadColors', em.includedThreadColors, 0, 15),
      extraThreadColorFee: cents('rates.embroidery.extraThreadColorFee', em.extraThreadColorFee, MAX_SETUP),
    },
    dtg: { perUnitBySize: sizes('rates.dtg.perUnitBySize', dtgIn.perUnitBySize), darkSurchargePerUnit: cents('rates.dtg.darkSurchargePerUnit', dtgIn.darkSurchargePerUnit, MAX_PER_UNIT) },
    dtf: { perUnitBySize: sizes('rates.dtf.perUnitBySize', m('dtf').perUnitBySize) },
    sublimation: { perUnitBySize: sizes('rates.sublimation.perUnitBySize', m('sublimation').perUnitBySize) },
    laser_engraving: { setup: cents('rates.laser_engraving.setup', m('laser_engraving').setup, MAX_SETUP), perUnit: cents('rates.laser_engraving.perUnit', m('laser_engraving').perUnit, MAX_PER_UNIT) },
    pad_printing: { setupPerColor: cents('rates.pad_printing.setupPerColor', m('pad_printing').setupPerColor, MAX_SETUP), perUnit: cents('rates.pad_printing.perUnit', m('pad_printing').perUnit, MAX_PER_UNIT) },
    deboss_emboss: { dieSetup: cents('rates.deboss_emboss.dieSetup', m('deboss_emboss').dieSetup, MAX_SETUP), perUnit: cents('rates.deboss_emboss.perUnit', m('deboss_emboss').perUnit, MAX_PER_UNIT) },
    heat_transfer_htv: { setup: cents('rates.heat_transfer_htv.setup', m('heat_transfer_htv').setup, MAX_SETUP), perUnit: cents('rates.heat_transfer_htv.perUnit', m('heat_transfer_htv').perUnit, MAX_PER_UNIT) },
  };
  for (const [k, s] of [['DTG', rates.dtg.perUnitBySize], ['DTF', rates.dtf.perUnitBySize], ['Sublimation', rates.sublimation.perUnitBySize]] as const) {
    if (s.small > s.medium || s.medium > s.large) warnings.push(`${k}: a larger print costs less than a smaller one.`);
  }
  if (marginMarkup < 1.15) warnings.push('Blank markup is under 15%: check this covers your costs.');

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    value: {
      currency: opts.currency, // not editable here: changing it would need price conversion
      marginMarkup,
      ...(Object.keys(overrides).length ? { categoryMarkupOverrides: overrides } : {}),
      decorationMarkup,
      rounding,
      fees,
      showItemizedToProspect: o.showItemizedToProspect as boolean,
      rates,
    },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
