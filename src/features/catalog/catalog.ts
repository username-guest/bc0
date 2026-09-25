/**
 * Dynamic catalog (§5, Phase 5). Given the prospect's processed logo and a quantity, produce
 * priced, decorated catalog entries plus faceted-search counts.
 *
 * Per product:
 *   - colour: first colour in the selected families (else the product's first colour)
 *   - methods: the product's decoration options ∩ physical compatibility (§3.1) ∩ plan entitlement
 *              ∩ logo suitability (photographic art never gets spot-colour methods)
 *   - recommended method: LOWEST estimated total at the requested quantity; alternatives listed
 *   - price-break preview: the same configuration quoted at every quantity break
 *
 * Facets follow standard faceted-search semantics: each facet's counts are computed with every
 * OTHER active filter applied but not its own, so picking "Navy" doesn't zero out the other colours.
 * Everything is PLACEHOLDER-priced and marked estimated by the engine.
 */
import type { DecorationMethodKey, PriceQuote, TenantPricingConfig } from '@/pricing/types';
import { quote } from '@/pricing/engine';
import { DECORATION_METHODS, isMethodCompatible } from '@/core/domain/decoration-methods';
import { mapColorToFamily, type ColorFamilyKey } from '@/core/domain/color-families';
import { breaksFor, type DemoProduct } from '@/core/domain/demo-catalog';

/** A demo product, optionally carrying its stored break table (DB-backed products always do). */
export type CatalogProduct = DemoProduct & { breaks?: import('@/pricing/types').QuantityBreak[] };

export interface LogoSummary {
  colorCount: number;
  isPhotographic: boolean;
}

export interface CatalogQuery {
  quantity: number;
  logo: LogoSummary;
  colorFamilies?: ColorFamilyKey[];
  categories?: string[];
  methods?: DecorationMethodKey[];
  ecoOnly?: boolean;
  maxUnitPrice?: number; // cents
  sort?: 'recommended' | 'price_asc' | 'price_desc';
  /** Server-resolved from flags (all_decoration_methods etc.). Omitted = all methods allowed. */
  entitledMethods?: DecorationMethodKey[];
}

export interface MethodOption {
  method: DecorationMethodKey;
  location: string;
  imprint: { widthIn: number; heightIn: number };
  total: number;
  unit: number;
}

export interface CatalogItem {
  slug: string;
  name: string;
  category: string;
  brand: string;
  template: CatalogProduct['template'];
  color: { name: string; hex: string; family: ColorFamilyKey; isDark: boolean };
  recommended: MethodOption & { quote: PriceQuote };
  alternatives: MethodOption[];
  priceBreaks: Array<{ minQty: number; unit: number; total: number }>;
  isEco: boolean;
}

export interface FacetCount<K extends string = string> {
  key: K;
  count: number;
}

export interface CatalogResult {
  items: CatalogItem[];
  facets: {
    colorFamilies: FacetCount<ColorFamilyKey>[];
    categories: FacetCount[];
    methods: FacetCount<DecorationMethodKey>[];
    eco: number;
    priceRange: { min: number; max: number } | null;
  };
  quantity: number;
}

const SPOT_ONLY: DecorationMethodKey[] = ['screen_print', 'pad_printing', 'heat_transfer_htv', 'embroidery'];
const SINGLE_TONE: DecorationMethodKey[] = ['laser_engraving', 'deboss_emboss'];

type FilterKey = 'family' | 'category' | 'method' | 'eco' | 'price';

function colorCountFor(method: DecorationMethodKey, logo: LogoSummary): number {
  if (SINGLE_TONE.includes(method)) return 1;
  return Math.max(1, logo.colorCount);
}

export function priceOption(
  p: CatalogProduct,
  opt: CatalogProduct['methods'][number],
  qty: number,
  isDark: boolean,
  logo: LogoSummary,
  cfg: TenantPricingConfig,
): { total: number; unit: number; quote: PriceQuote } {
  const q = quote(
    {
      category: p.category,
      quantity: qty,
      method: opt.method,
      colorCount: colorCountFor(opt.method, logo),
      isDarkGarment: isDark && Boolean(p.traits.isApparel),
      locations: 1,
      imprint: { widthIn: opt.w, heightIn: opt.h },
      methodMoq: Math.max(12, DECORATION_METHODS[opt.method].defaultMoq),
      breaks: breaksOf(p),
    },
    cfg,
  );
  return { total: q.total, unit: q.effectiveUnit, quote: q };
}

/** Stored breaks win (DB products); otherwise derive from the demo base cost. */
function breaksOf(p: CatalogProduct) {
  return p.breaks?.length ? p.breaks : breaksFor(p.blankBase);
}

function pickColor(p: CatalogProduct, families?: ColorFamilyKey[]) {
  const withFam = p.colors.map((c) => ({ ...c, family: mapColorToFamily(c.hex), isDark: Boolean(c.isDark) }));
  if (families?.length) return withFam.find((c) => families.includes(c.family)) ?? null;
  return withFam[0] ?? null;
}

function eligibleMethods(
  p: CatalogProduct,
  isDark: boolean,
  q: CatalogQuery,
  applyMethodFilter: boolean,
): CatalogProduct['methods'] {
  const traits = {
    isApparel: Boolean(p.traits.isApparel),
    isHardGood: Boolean(p.traits.isHardGood),
    isPolyester: Boolean(p.traits.isPolyester),
    isDark,
  };
  return p.methods.filter(
    (m) =>
      isMethodCompatible(m.method, traits) &&
      (!q.entitledMethods || q.entitledMethods.includes(m.method)) &&
      !(q.logo.isPhotographic && SPOT_ONLY.includes(m.method)) &&
      (!applyMethodFilter || !q.methods?.length || q.methods.includes(m.method)),
  );
}

/** Evaluate one product under the query, optionally ignoring one filter (for facet counts). */
function evaluate(
  p: CatalogProduct,
  q: CatalogQuery,
  cfg: TenantPricingConfig,
  ignore: FilterKey | null,
): CatalogItem | null {
  if (ignore !== 'category' && q.categories?.length && !q.categories.includes(p.category)) return null;
  if (ignore !== 'eco' && q.ecoOnly && !p.traits.isEco) return null;
  const color = pickColor(p, ignore === 'family' ? undefined : q.colorFamilies);
  if (!color) return null;

  const methods = eligibleMethods(p, color.isDark, q, ignore !== 'method');
  if (!methods.length) return null;

  const priced = methods
    .map((m) => ({ m, ...priceOption(p, m, q.quantity, color.isDark, q.logo, cfg) }))
    .sort((a, b) => a.total - b.total);
  const best = priced[0]!;
  if (ignore !== 'price' && q.maxUnitPrice !== undefined && best.unit > q.maxUnitPrice) return null;

  const option = (x: (typeof priced)[number]): MethodOption => ({
    method: x.m.method,
    location: x.m.location,
    imprint: { widthIn: x.m.w, heightIn: x.m.h },
    total: x.total,
    unit: x.unit,
  });

  const priceBreaks = breaksOf(p).map((b) => {
    const r = priceOption(p, best.m, b.minQty, color.isDark, q.logo, cfg);
    return { minQty: b.minQty, unit: r.unit, total: r.total };
  });

  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    brand: p.brand,
    template: p.template,
    color: { name: color.name, hex: color.hex, family: color.family, isDark: color.isDark },
    recommended: { ...option(best), quote: best.quote },
    // Distinct methods only (a method offered at two locations shouldn't appear as its own alternative).
    alternatives: priced
      .filter((x, i, arr) => x.m.method !== best.m.method && arr.findIndex((y) => y.m.method === x.m.method) === i)
      .map(option),
    priceBreaks,
    isEco: Boolean(p.traits.isEco),
  };
}

function tally<K extends string>(keys: K[]): FacetCount<K>[] {
  const m = new Map<K, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function searchCatalog(products: CatalogProduct[], q: CatalogQuery, cfg: TenantPricingConfig): CatalogResult {
  if (!Number.isInteger(q.quantity) || q.quantity < 1) throw new Error('quantity must be a positive integer');

  const items = products.map((p) => evaluate(p, q, cfg, null)).filter((x): x is CatalogItem => !!x);
  if (q.sort === 'price_asc') items.sort((a, b) => a.recommended.unit - b.recommended.unit);
  else if (q.sort === 'price_desc') items.sort((a, b) => b.recommended.unit - a.recommended.unit);

  // Facets: re-evaluate ignoring the facet's own filter.
  const familyKeys: ColorFamilyKey[] = [];
  const categoryKeys: string[] = [];
  const methodKeys: DecorationMethodKey[] = [];
  for (const p of products) {
    if (evaluate(p, q, cfg, 'family')) {
      const fams = new Set(p.colors.map((c) => mapColorToFamily(c.hex)));
      for (const f of fams) {
        if (evaluate(p, { ...q, colorFamilies: [f] }, cfg, null)) familyKeys.push(f);
      }
    }
    const cat = evaluate(p, q, cfg, 'category');
    if (cat) categoryKeys.push(p.category);
    const m = evaluate(p, q, cfg, 'method');
    if (m) {
      // One count per product per method, even if offered at several locations.
      for (const k of new Set([m.recommended, ...m.alternatives].map((o) => o.method))) methodKeys.push(k);
    }
  }
  const units = items.map((i) => i.recommended.unit);

  return {
    items,
    quantity: q.quantity,
    facets: {
      colorFamilies: tally(familyKeys),
      categories: tally(categoryKeys),
      methods: tally(methodKeys),
      eco: products.filter((p) => evaluate(p, q, cfg, 'eco')?.isEco).length,
      priceRange: units.length ? { min: Math.min(...units), max: Math.max(...units) } : null,
    },
  };
}
