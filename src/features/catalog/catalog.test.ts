import { describe, it, expect } from 'vitest';
import { searchCatalog, type CatalogQuery } from './catalog';
import { DEMO_CATALOG } from '@/core/domain/demo-catalog';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';

const threeColor = { colorCount: 3, isPhotographic: false };
const run = (q: Partial<CatalogQuery> = {}) =>
  searchCatalog(DEMO_CATALOG, { quantity: 144, logo: threeColor, ...q }, PLACEHOLDER_TENANT_CONFIG);

describe('catalog search', () => {
  it('prices every product and marks quotes estimated', () => {
    const r = run();
    expect(r.items).toHaveLength(DEMO_CATALOG.length);
    for (const i of r.items) {
      expect(i.recommended.quote.estimated).toBe(true);
      expect(Number.isInteger(i.recommended.unit)).toBe(true);
    }
  });

  it('recommends the lowest-total method, and alternatives are distinct methods', () => {
    for (const i of run().items) {
      for (const a of i.alternatives) {
        expect(a.total).toBeGreaterThanOrEqual(i.recommended.total);
        expect(a.method).not.toBe(i.recommended.method);
      }
      expect(new Set(i.alternatives.map((a) => a.method)).size).toBe(i.alternatives.length);
    }
  });

  it('unit price never rises with quantity across the break preview', () => {
    for (const i of run().items) {
      for (let k = 1; k < i.priceBreaks.length; k++) {
        expect(i.priceBreaks[k]!.unit).toBeLessThanOrEqual(i.priceBreaks[k - 1]!.unit);
      }
    }
  });

  it('never offers sublimation on a dark garment', () => {
    const polo = run({ colorFamilies: ['royal_blue'] }).items.find((i) => i.slug === 'performance-polo')!;
    const methods = [polo.recommended.method, ...polo.alternatives.map((a) => a.method)];
    expect(methods).not.toContain('sublimation');
  });

  it('offers sublimation on the light polyester colourway', () => {
    const polo = run({ colorFamilies: ['white_neutral'] }).items.find((i) => i.slug === 'performance-polo')!;
    expect([polo.recommended.method, ...polo.alternatives.map((a) => a.method)]).toContain('sublimation');
  });

  it('photographic art never gets spot-colour methods', () => {
    const r = run({ logo: { colorCount: 14, isPhotographic: true } });
    for (const i of r.items) {
      for (const m of [i.recommended.method, ...i.alternatives.map((a) => a.method)]) {
        expect(['screen_print', 'pad_printing', 'heat_transfer_htv', 'embroidery']).not.toContain(m);
      }
    }
  });

  it('respects server-resolved entitlements', () => {
    const r = run({ entitledMethods: ['screen_print'] });
    expect(r.items.every((i) => i.recommended.method === 'screen_print' && i.alternatives.length === 0)).toBe(true);
    expect(r.items.map((i) => i.slug).sort()).toEqual(['classic-cotton-tee', 'cotton-canvas-tote']);
  });

  it('facet counts ignore their own filter but honour the others', () => {
    const r = run({ categories: ['Apparel'] });
    expect(r.items.every((i) => i.category === 'Apparel')).toBe(true);
    // category facet still lists the other categories (own filter ignored)
    expect(r.facets.categories.length).toBeGreaterThan(1);
    // colour facet only counts Apparel products (other filter honoured)
    const black = r.facets.colorFamilies.find((f) => f.key === 'black');
    expect(black?.count).toBe(1); // only the tee comes in black among Apparel
  });

  it('price ceiling filters on estimated unit price', () => {
    const r = run({ maxUnitPrice: 1000 });
    expect(r.items.every((i) => i.recommended.unit <= 1000)).toBe(true);
    expect(r.items.length).toBeLessThan(DEMO_CATALOG.length);
  });

  it('rejects invalid quantities', () => {
    expect(() => run({ quantity: 0 })).toThrow();
    expect(() => run({ quantity: 2.5 })).toThrow();
  });
});
