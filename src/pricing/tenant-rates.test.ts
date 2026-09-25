/** Per-tenant decoration rates + pricing config validation (ADR 0009). */
import { describe, expect, it } from 'vitest';
import { ESTIMATE_DISCLAIMER, OWN_RATES_DISCLAIMER, decorationCost, prospectLines, quote } from './engine';
import { PLACEHOLDER_RATES, PLACEHOLDER_TENANT_CONFIG, resolveRates } from './placeholder-rates';
import { validatePricingConfig } from './config-validation';
import type { DecorationRates, PriceRequest, TenantPricingConfig } from './types';

const req: PriceRequest = {
  category: 'Apparel',
  quantity: 144,
  method: 'screen_print',
  colorCount: 2,
  isDarkGarment: true,
  locations: 1,
  imprint: { widthIn: 10, heightIn: 10 },
  methodMoq: 24,
  breaks: [{ minQty: 12, blankUnitCost: 350 }],
};
const base = PLACEHOLDER_TENANT_CONFIG as TenantPricingConfig;
const withRates = (patch: (r: DecorationRates) => void): TenantPricingConfig => {
  const rates = structuredClone(PLACEHOLDER_RATES);
  patch(rates);
  return { ...base, rates };
};
const opts = { categories: ['Apparel', 'Drinkware'], currency: 'USD' };
const valid = () => structuredClone({ ...base, rates: PLACEHOLDER_RATES }) as unknown as Record<string, any>;

describe('per-tenant decoration rates', () => {
  it('a tenant with no rates prices exactly as before (placeholder tables)', () => {
    expect(quote(req, base).total).toBe(quote(req, { ...base, rates: PLACEHOLDER_RATES }).total);
    expect(quote(req, base).disclaimer).toBe(ESTIMATE_DISCLAIMER);
  });

  it("the tenant's own rates drive the decoration cost and the disclaimer", () => {
    const cfg = withRates((r) => (r.screen_print.screenChargePerColor = 3000));
    // 3 effective colours (2 + underbase) × 1 location
    expect(decorationCost(req, cfg.rates).setup).toBe(9000);
    expect(quote(req, cfg).subtotals.decorationSetup).toBe(9000);
    expect(quote(req, base).subtotals.decorationSetup).toBe(6000);
    expect(quote(req, cfg).disclaimer).toBe(OWN_RATES_DISCLAIMER);
  });

  it('every method reads its own table', () => {
    const cfg = withRates((r) => {
      r.embroidery.ratePer1kStitches = 200;
      r.laser_engraving.perUnit = 777;
      r.dtg.perUnitBySize.large = 2500;
    });
    const emb = decorationCost({ ...req, method: 'embroidery', imprint: { widthIn: 3, heightIn: 2 } }, cfg.rates);
    expect(emb.runPerUnit).toBe(Math.ceil((6 * 1800) / 1000) * 200);
    expect(decorationCost({ ...req, method: 'laser_engraving' }, cfg.rates).runPerUnit).toBe(777);
    expect(decorationCost({ ...req, method: 'dtg', isDarkGarment: false }, cfg.rates).runPerUnit).toBe(2500);
  });

  it('resolveRates fills methods missing from older configs', () => {
    const partial = { laser_engraving: { setup: 1, perUnit: 2 } } as Partial<DecorationRates>;
    const r = resolveRates(partial);
    expect(r.laser_engraving).toEqual({ setup: 1, perUnit: 2 });
    expect(r.screen_print).toEqual(PLACEHOLDER_RATES.screen_print);
  });
});

describe('prospect-facing breakdown', () => {
  it('never shows blank cost or margin, and still adds up to the total', () => {
    const cfg: TenantPricingConfig = { ...base, fees: { ...base.fees, rush: { mode: 'percent', percent: 10 } } };
    const cases: [PriceRequest, TenantPricingConfig][] = [
      [req, cfg],
      [{ ...req, quantity: 12, method: 'embroidery' as const, addPmsMatch: true, personalization: true, rush: true }, cfg],
      [req, { ...cfg, marginMarkup: 1.37 }], // $4.795 per item: the unit can't be shown exactly
    ];
    for (const [r, c] of cases) {
      const q = quote(r, c);
      const lines = prospectLines(q);
      expect(lines.map((l) => l.label).join(' | ')).not.toMatch(/Margin|Blanks|break/);
      expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(q.total);
      expect(lines[0]!.label).toMatch(/^Products \(/);
      // Any "qty × $unit" shown must multiply out to the line amount exactly.
      for (const l of lines) {
        const m = /\(([\d,]+) × \$([\d.]+)\)/.exec(l.label);
        if (m) expect(Math.round(Number(m[1]!.replace(/,/g, '')) * Number(m[2]) * 100)).toBe(l.amount);
      }
    }
  });
});

describe('pricing config validation', () => {
  it('accepts the defaults with no warnings', () => {
    const v = validatePricingConfig(valid(), opts);
    expect(v.ok && v.warnings).toEqual([]);
  });

  it('rebuilds the object: unknown keys never reach storage; currency is not editable', () => {
    const c = valid();
    c.evil = 'x';
    c.rates.screen_print.extra = 'y';
    c.currency = 'EUR';
    const v = validatePricingConfig(JSON.parse(JSON.stringify(c).replace('{', '{"__proto__":{"polluted":1},')), opts);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    expect(JSON.stringify(v.value)).not.toMatch(/"evil"|"extra"|polluted/);
    expect(v.value.currency).toBe('USD');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports each bad field by path', () => {
    const c = valid();
    c.marginMarkup = 0.9; // below cost
    c.fees.ltmFee = 49.99; // dollars typed into a cents field
    c.rates.embroidery.digitizingFee = -1;
    c.rates.dtf.perUnitBySize.large = 999_999;
    c.rates.screen_print.runByBreak[2].minQty = 24; // not above tier 1 (24)
    c.categoryMarkupOverrides = { Apparel: 1.6, Spaceships: 2 };
    c.rounding = 'banker';
    const v = validatePricingConfig(c, opts);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.errors).sort()).toEqual(
      [
        'marginMarkup',
        'fees.ltmFee',
        'rates.embroidery.digitizingFee',
        'rates.dtf.perUnitBySize.large',
        'rates.screen_print.runByBreak.2.minQty',
        'categoryMarkupOverrides.Spaceships',
        'rounding',
      ].sort(),
    );
  });

  it('rush needs the value that matches its mode', () => {
    const c = valid();
    c.fees.rush = { mode: 'percent', percent: 150 };
    const v = validatePricingConfig(c, opts);
    expect(!v.ok && v.errors['fees.rush.percent']).toBeTruthy();
    c.fees.rush = { mode: 'flat', flat: 2500, percent: 10 };
    const ok = validatePricingConfig(c, opts);
    expect(ok.ok && ok.value.fees.rush).toEqual({ mode: 'flat', flat: 2500 });
  });

  it('warns about likely typos without blocking', () => {
    const c = valid();
    c.marginMarkup = 1.05;
    c.rates.screen_print.runByBreak[3].base = 500; // 72+ tier dearer than 48+
    c.rates.dtg.perUnitBySize.small = 5000; // small dearer than medium
    const v = validatePricingConfig(c, opts);
    if (!v.ok) throw new Error('should be valid');
    expect(v.warnings.join(' | ')).toMatch(/under 15%/);
    expect(v.warnings.join(' | ')).toMatch(/72\+ tier costs more/);
    expect(v.warnings.join(' | ')).toMatch(/DTG/);
  });
});
