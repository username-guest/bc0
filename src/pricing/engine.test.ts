import { describe, expect, it } from 'vitest';
import { decorationCost, pickBreak, quote } from './engine';
import { estimateStitchCount, sizeTier } from './stitch';
import type { PriceRequest, QuantityBreak, TenantPricingConfig } from './types';

const BREAKS: QuantityBreak[] = [
  { minQty: 12, blankUnitCost: 450 },
  { minQty: 24, blankUnitCost: 430 },
  { minQty: 48, blankUnitCost: 400 },
  { minQty: 72, blankUnitCost: 380 },
  { minQty: 144, blankUnitCost: 350 },
  { minQty: 288, blankUnitCost: 320 },
  { minQty: 576, blankUnitCost: 295 },
];

const CFG: TenantPricingConfig = {
  currency: 'USD',
  marginMarkup: 1.4,
  decorationMarkup: 1.0,
  rounding: 'none',
  fees: {
    ltmFee: 5000,
    pmsMatchFee: 2500,
    personalizationPerUnit: 100,
    rush: { mode: 'none' },
  },
  showItemizedToProspect: true,
};

const screenReq: PriceRequest = {
  category: 'apparel',
  quantity: 144,
  method: 'screen_print',
  colorCount: 2,
  isDarkGarment: true,
  locations: 1,
  imprint: { widthIn: 10, heightIn: 12 },
  methodMoq: 24,
  breaks: BREAKS,
};

describe('pickBreak', () => {
  it('selects highest break at or below quantity', () => {
    expect(pickBreak(BREAKS, 144).minQty).toBe(144);
    expect(pickBreak(BREAKS, 143).minQty).toBe(72);
    expect(pickBreak(BREAKS, 5).minQty).toBe(12); // below all → lowest
    expect(pickBreak(BREAKS, 100000).minQty).toBe(576);
  });
});

describe('screen print — worked example (dark tee, 2-color, 144, 1 location)', () => {
  const q = quote(screenReq, CFG);
  it('adds a white underbase → 3 effective colors', () => {
    const dec = decorationCost(screenReq);
    expect(dec.setup).toBe(6000); // $20 × 3 × 1
    expect(dec.runPerUnit).toBe(100); // base 40 + perColor 20 × 3
  });
  it('computes margin, run and total exactly', () => {
    expect(q.subtotals.blanksAtCost).toBe(50400); // 350 × 144
    expect(q.subtotals.margin).toBe(20160); // 705.60 − 504.00
    expect(q.subtotals.decorationSetup).toBe(6000);
    expect(q.subtotals.decorationRun).toBe(14400); // 100 × 144
    expect(q.total).toBe(90960);
    expect(q.effectiveUnit).toBe(632); // round(90960/144)
  });
  it('is always flagged estimated with a disclaimer', () => {
    expect(q.estimated).toBe(true);
    expect(q.disclaimer).toMatch(/Estimated pricing/);
  });
});

describe('embroidery — worked example (left chest 3×2, 48, 1 location)', () => {
  const req: PriceRequest = {
    category: 'apparel',
    quantity: 48,
    method: 'embroidery',
    colorCount: 4,
    locations: 1,
    imprint: { widthIn: 3, heightIn: 2 },
    methodMoq: 24,
    breaks: [{ minQty: 12, blankUnitCost: 650 }],
  };
  it('estimates stitches and bills per 1k', () => {
    expect(estimateStitchCount(3, 2)).toBe(10800); // 6 sq in × 1800
    expect(decorationCost(req).runPerUnit).toBe(990); // ceil(10800/1000)=11 × 90
  });
  it('computes total exactly', () => {
    const q = quote(req, CFG);
    expect(q.subtotals.decorationSetup).toBe(4500); // 4 ≤ 7 included → no extra
    expect(q.subtotals.decorationRun).toBe(47520); // 990 × 48
    expect(q.total).toBe(95700); // 43680 + 4500 + 47520
  });
});

describe('fees & config', () => {
  it('applies LTM fee below method MOQ', () => {
    const q = quote({ ...screenReq, quantity: 12, methodMoq: 24 }, CFG);
    expect(q.lines.some((l) => l.label === 'Less-than-minimum fee' && l.amount === 5000)).toBe(true);
  });
  it('honors per-category markup override', () => {
    const q = quote(screenReq, { ...CFG, categoryMarkupOverrides: { apparel: 1.6 } });
    expect(q.subtotals.margin).toBe(Math.round(50400 * 1.6) - 50400);
  });
  it('decorationMarkup scales decoration only', () => {
    const q = quote(screenReq, { ...CFG, decorationMarkup: 2 });
    expect(q.subtotals.decorationRun).toBe(28800); // 14400 × 2
    expect(q.subtotals.margin).toBe(20160); // blanks margin unaffected
  });
});

describe('sizeTier', () => {
  it('buckets by area', () => {
    expect(sizeTier(3, 3)).toBe('small');
    expect(sizeTier(6, 6)).toBe('medium');
    expect(sizeTier(10, 8)).toBe('large');
  });
});
