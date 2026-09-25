import type {
  Cents,
  DecorationCost,
  DecorationMethodKey,
  PriceLine,
  PriceQuote,
  PriceRequest,
  QuantityBreak,
  RoundingMode,
  TenantPricingConfig,
  DecorationRates,
} from './types';
import { PLACEHOLDER_RATES, resolveRates } from './placeholder-rates';
import { estimateStitchCount, sizeTier } from './stitch';

export const ESTIMATE_DISCLAIMER =
  'Estimated pricing based on placeholder rate tables. Not a quote. Final pricing is subject ' +
  'to supplier costs, artwork review, and distributor confirmation.';

/** Used once a distributor has entered its own rates: still an estimate, but not "placeholder". */
export const OWN_RATES_DISCLAIMER =
  "Estimated pricing from this distributor's rate tables. Not a quote. Final pricing is subject " +
  'to supplier costs, artwork review, and distributor confirmation.';

export function disclaimerFor(cfg: TenantPricingConfig): string {
  return cfg.rates ? OWN_RATES_DISCLAIMER : ESTIMATE_DISCLAIMER;
}

/** Pick the applicable quantity break (highest minQty ≤ quantity; else the lowest break). */
export function pickBreak(breaks: QuantityBreak[], quantity: number): QuantityBreak {
  const sorted = [...breaks].sort((a, b) => a.minQty - b.minQty);
  const first = sorted[0];
  if (!first) throw new Error('pricing: product has no quantity breaks');
  let chosen = first;
  for (const b of sorted) if (quantity >= b.minQty) chosen = b;
  return chosen;
}

/* ------------------------------------------------------------------ *
 * Per-method decoration modules (§3.1). Each is a pluggable function. *
 * ------------------------------------------------------------------ */
type MethodModule = (req: PriceRequest, R: DecorationRates) => DecorationCost;

const screenPrint: MethodModule = (req, R) => {
  const effColors = req.colorCount + (req.isDarkGarment ? 1 : 0); // dark = +1 white underbase
  const tiers = [...R.screen_print.runByBreak].sort((a, b) => a.minQty - b.minQty);
  let tier = tiers[0]!;
  for (const t of tiers) if (req.quantity >= t.minQty) tier = t;
  return {
    setup: R.screen_print.screenChargePerColor * effColors * req.locations,
    runPerUnit: tier.base + tier.perColor * effColors,
    notes: [
      `${effColors} effective color(s)${req.isDarkGarment ? ' (incl. white underbase)' : ''}`,
      `screen setup: ${effColors} color(s) × ${req.locations} location(s)`,
    ],
  };
};

const embroidery: MethodModule = (req, R) => {
  const stitches =
    req.stitchCount ?? estimateStitchCount(req.imprint.widthIn, req.imprint.heightIn);
  const per1k = Math.ceil(stitches / 1000);
  const extraColors = Math.max(0, req.colorCount - R.embroidery.includedThreadColors);
  return {
    setup: R.embroidery.digitizingFee + extraColors * R.embroidery.extraThreadColorFee,
    runPerUnit: per1k * R.embroidery.ratePer1kStitches * req.locations,
    notes: [
      `${stitches.toLocaleString()} stitches (${per1k}k billed) × ${req.locations} location(s)`,
      extraColors > 0 ? `${extraColors} thread color(s) beyond included` : 'thread colors included',
    ],
  };
};

const perSizeRun = (req: PriceRequest, table: Record<'small' | 'medium' | 'large', Cents>, darkSurcharge: Cents = 0): DecorationCost => {
  const tier = sizeTier(req.imprint.widthIn, req.imprint.heightIn);
  const base = table[tier] * req.locations;
  return {
    setup: 0,
    runPerUnit: base + (req.isDarkGarment ? darkSurcharge : 0),
    notes: [`${tier} imprint × ${req.locations} location(s)`],
  };
};

const dtg: MethodModule = (req, R) => perSizeRun(req, R.dtg.perUnitBySize, R.dtg.darkSurchargePerUnit);
const dtf: MethodModule = (req, R) => perSizeRun(req, R.dtf.perUnitBySize);
const sublimation: MethodModule = (req, R) => perSizeRun(req, R.sublimation.perUnitBySize);

const laser: MethodModule = (req, R) => ({
  setup: R.laser_engraving.setup * req.locations,
  runPerUnit: R.laser_engraving.perUnit * req.locations,
  notes: ['single etch color'],
});

const pad: MethodModule = (req, R) => ({
  setup: R.pad_printing.setupPerColor * req.colorCount * req.locations,
  runPerUnit: R.pad_printing.perUnit * req.locations,
  notes: [`${req.colorCount} color setup × ${req.locations} location(s)`],
});

const deboss: MethodModule = (req, R) => ({
  setup: R.deboss_emboss.dieSetup * req.locations,
  runPerUnit: R.deboss_emboss.perUnit * req.locations,
  notes: ['blind deboss/emboss (no ink)'],
});

const htv: MethodModule = (req, R) => ({
  setup: R.heat_transfer_htv.setup * req.locations,
  runPerUnit: R.heat_transfer_htv.perUnit * req.locations,
  notes: ['heat transfer / HTV'],
});

const MODULES: Record<DecorationMethodKey, MethodModule> = {
  screen_print: screenPrint,
  embroidery,
  dtg,
  dtf,
  sublimation,
  laser_engraving: laser,
  pad_printing: pad,
  deboss_emboss: deboss,
  heat_transfer_htv: htv,
};

/** Decoration cost with the given rate tables (default: the placeholder tables). */
export function decorationCost(req: PriceRequest, rates: DecorationRates = PLACEHOLDER_RATES): DecorationCost {
  const mod = MODULES[req.method];
  if (!mod) throw new Error(`pricing: unknown decoration method ${req.method}`);
  return mod(req, rates);
}

/**
 * Money is ALWAYS integer cents. `none` means "no commercial rounding" (no 5¢ steps, no charm
 * pricing) — it still rounds to the nearest whole cent. Returning fractional cents here was a bug
 * caught by executing the real TS suite (the arithmetic mirror had rounded implicitly).
 */
function applyRounding(unit: number, mode: RoundingMode): Cents {
  switch (mode) {
    case 'none':
    case 'nearest_cent':
      return Math.round(unit);
    case 'nearest_5c':
      return Math.round(unit / 5) * 5;
    case 'charm_95':
      return Math.floor(unit / 100) * 100 + 95;
  }
}

/**
 * Core quote (§8):
 *   Total = (blank base × qty × margin markup) + decoration + one-time charges + fees.
 * Returns an itemized, `estimated`-labelled breakdown in integer cents.
 */
export function quote(req: PriceRequest, cfg: TenantPricingConfig): PriceQuote {
  if (req.quantity <= 0) throw new Error('pricing: quantity must be > 0');
  if (req.locations <= 0) throw new Error('pricing: locations must be > 0');

  const brk = pickBreak(req.breaks, req.quantity);
  const markup = cfg.categoryMarkupOverrides?.[req.category] ?? cfg.marginMarkup;

  const blanksAtCost = brk.blankUnitCost * req.quantity;
  const blanksWithMargin = Math.round(blanksAtCost * markup);
  const margin = blanksWithMargin - blanksAtCost;

  const dec = decorationCost(req, resolveRates(cfg.rates));
  const decorationSetup = Math.round(dec.setup * cfg.decorationMarkup);
  const decorationRunPerUnit = Math.round(dec.runPerUnit * cfg.decorationMarkup);
  const decorationRun = decorationRunPerUnit * req.quantity;

  const lines: PriceLine[] = [
    { label: `Blanks @ break ${brk.minQty}`, kind: 'blank', amount: blanksAtCost, perUnit: brk.blankUnitCost },
    { label: 'Margin', kind: 'margin', amount: margin, note: `markup ×${markup}` },
    ...(decorationSetup > 0
      ? [{ label: 'Decoration setup (one-time)', kind: 'decoration_setup' as const, amount: decorationSetup, note: dec.notes.join('; ') }]
      : []),
    { label: 'Decoration run', kind: 'decoration_run', amount: decorationRun, perUnit: decorationRunPerUnit, note: dec.notes.join('; ') },
  ];

  // Fees
  let fees = 0;
  if (req.quantity < req.methodMoq && cfg.fees.ltmFee > 0) {
    fees += cfg.fees.ltmFee;
    lines.push({ label: 'Less-than-minimum fee', kind: 'fee', amount: cfg.fees.ltmFee });
  }
  if (req.addPmsMatch && cfg.fees.pmsMatchFee > 0) {
    const pms = cfg.fees.pmsMatchFee * req.colorCount;
    fees += pms;
    lines.push({ label: 'PMS match', kind: 'fee', amount: pms, note: `${req.colorCount} color(s)` });
  }
  if (req.personalization && cfg.fees.personalizationPerUnit > 0) {
    const p = cfg.fees.personalizationPerUnit * req.quantity;
    fees += p;
    lines.push({ label: 'Personalization', kind: 'fee', amount: p, perUnit: cfg.fees.personalizationPerUnit });
  }

  let subtotal = blanksWithMargin + decorationSetup + decorationRun + fees;

  if (req.rush && cfg.fees.rush.mode !== 'none') {
    const rush =
      cfg.fees.rush.mode === 'percent'
        ? Math.round(subtotal * ((cfg.fees.rush.percent ?? 0) / 100))
        : (cfg.fees.rush.flat ?? 0);
    fees += rush;
    subtotal += rush;
    lines.push({ label: 'Rush', kind: 'fee', amount: rush });
  }

  const total = subtotal;
  const effectiveUnit = applyRounding(total / req.quantity, cfg.rounding);

  return {
    currency: cfg.currency,
    quantity: req.quantity,
    appliedBreakMinQty: brk.minQty,
    lines,
    subtotals: { blanksAtCost, margin, decorationSetup, decorationRun, fees },
    total,
    effectiveUnit,
    estimated: true,
    disclaimer: disclaimerFor(cfg),
    itemizedVisibleToProspect: cfg.showItemizedToProspect,
  };
}

/** A line a prospect may see: selling prices only. */
export interface ProspectLine {
  label: string;
  amount: Cents;
}

/**
 * The breakdown for PROSPECTS. The internal lines expose the distributor's blank cost and margin,
 * so blanks and margin fold into one "Products" line at the selling price. Amounts still sum to
 * the quote total. Internal lines stay with the lead/CRM record for the distributor.
 */
export function prospectLines(q: PriceQuote): ProspectLine[] {
  const out: ProspectLine[] = [];
  const products = q.subtotals.blanksAtCost + q.subtotals.margin;
  const n = q.quantity.toLocaleString('en-US');
  // Show "qty × unit" only when it multiplies out exactly; a rounded unit would not add up.
  out.push({ label: products % q.quantity === 0 ? `Products (${n} × ${fmt(products / q.quantity)})` : `Products (${n} items)`, amount: products });
  for (const l of q.lines) {
    if (l.kind === 'decoration_setup') out.push({ label: 'Decoration setup (one-time)', amount: l.amount });
    else if (l.kind === 'decoration_run')
      out.push({ label: l.perUnit !== undefined && l.perUnit * q.quantity === l.amount ? `Decoration (${n} × ${fmt(l.perUnit)})` : `Decoration (${n} items)`, amount: l.amount });
    else if (l.kind === 'fee') out.push({ label: l.label, amount: l.amount });
  }
  return out;
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
