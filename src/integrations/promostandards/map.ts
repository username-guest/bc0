/**
 * PromoStandards → BrandCanvas catalog products (ADR 0017).
 *
 * The storefront can only show what it can render and price honestly, so mapping is strict:
 * a product needs a render template, at least one colour with a hex, at least one decoration
 * method on a zone that template has, and a readable blank price. Anything missing is reported
 * back to the distributor (never guessed), and the product is skipped.
 */
import type { TemplateKind } from '@/imaging/templates';
import type { DecorationMethodKey, QuantityBreak } from '@/pricing/types';
import type { CatalogProduct } from '@/features/catalog/catalog';
import type { PsConfiguration, PsProduct } from './services';

export interface MapResult {
  product?: CatalogProduct;
  /** Why the product (or part of it) was left out, in words a distributor can act on. */
  notes: string[];
}

/* ---- Template: from category, sub-category and name ---- */

const TEMPLATE_RULES: Array<[TemplateKind, RegExp]> = [
  ['polo', /\bpolos?\b|\bsport shirt/i],
  ['tee', /\bt-?shirts?\b|\btees?\b/i],
  ['cap', /\bcaps?\b|\bhats?\b|headwear|trucker|snapback/i],
  ['tumbler', /tumbler|drinkware|\bmugs?\b|bottle|\bcups?\b|travel mug/i],
  ['tote', /\btotes?\b|\bbags?\b/i],
  ['journal', /journal|notebook|notepad|padfolio/i],
];

export function templateFor(p: Pick<PsProduct, 'name' | 'categories'>, override?: TemplateKind): TemplateKind | null {
  if (override) return override;
  // Sub-categories are more specific than categories, and both than the product name.
  const hay = [...p.categories.map((c) => c.subCategory ?? ''), ...p.categories.map((c) => c.category), p.name];
  for (const h of hay) {
    if (!h) continue;
    for (const [kind, re] of TEMPLATE_RULES) if (re.test(h)) return kind;
  }
  return null;
}

/* ---- Decoration method ---- */

const METHOD_RULES: Array<[DecorationMethodKey, RegExp]> = [
  ['dtg', /\bdtg\b|direct[\s-]to[\s-]garment/i],
  ['dtf', /\bdtf\b|direct[\s-]to[\s-]film/i],
  ['screen_print', /screen\s*print|silk\s*screen|screened/i],
  ['embroidery', /embroider/i],
  ['sublimation', /sublimat/i],
  ['laser_engraving', /laser/i],
  ['pad_printing', /pad\s*print/i],
  ['deboss_emboss', /deboss|emboss|blind\s*stamp/i],
  ['heat_transfer_htv', /heat\s*(press|transfer)|\bhtv\b|vinyl/i],
];

export function methodFor(decorationName: string): DecorationMethodKey | null {
  for (const [key, re] of METHOD_RULES) if (re.test(decorationName)) return key;
  return null;
}

/* ---- Location: supplier names → the template's authored zones ---- */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ZONE_RULES: Record<TemplateKind, Array<[string, RegExp]>> = {
  tee: [
    ['left_chest', /^(left )?(chest|breast)( left)?$|^left (chest|breast)/],
    ['full_front', /^(full |center |centre )?front( center| centre| full)?$/],
  ],
  polo: [
    ['left_chest', /^(left )?(chest|breast)( left)?$|^left (chest|breast)/],
    ['full_front', /^(full |center |centre )?front( center| centre| full)?$/],
  ],
  cap: [['front_panel', /^(center |centre )?front( panel| center| centre)?$/]],
  tumbler: [
    ['wrap', /wrap|360/],
    ['one_side', /^(front|side|one side|side 1|side a|opposite handle|barrel)$/],
  ],
  tote: [['center_front', /^(center |centre )?front( center| centre| of bag| pocket)?$|^side (1|a)$/]],
  journal: [['front_cover', /^(front )?cover$|^front$/]],
};

export function zoneFor(template: TemplateKind, locationName: string): string | null {
  const n = norm(locationName);
  for (const [zone, re] of ZONE_RULES[template]) if (re.test(n)) return zone;
  return null;
}

/* ---- Colour ---- */

const NAMED_HEX: Record<string, string> = {
  black: '#0A0A0A', white: '#FFFFFF', navy: '#1B2A4A', 'navy blue': '#1B2A4A', red: '#C6242A',
  royal: '#1F4AA8', 'royal blue': '#1F4AA8', grey: '#8A8D8F', gray: '#8A8D8F', 'heather grey': '#9EA2A2',
  'sport grey': '#9EA2A2', charcoal: '#3C3F42', green: '#2E7D32', 'forest green': '#1E4D2B', kelly: '#2E8B3E',
  orange: '#E8671C', yellow: '#F4C430', gold: '#D4A017', purple: '#5B2C83', maroon: '#6B1E2E', pink: '#E8A0B4',
  brown: '#5C4033', tan: '#C8A97E', natural: '#EDE3CF', silver: '#B8BCC0', stainless: '#B8BCC0', 'light blue': '#9CC3E6',
};

export function colorHex(name: string, hex?: string): string | null {
  return hex ?? NAMED_HEX[norm(name)] ?? null;
}

function isDarkHex(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L < 0.18;
}

/* ---- Slug ---- */

export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'product'
  );
}

/* ---- The whole product ---- */

export interface MapOptions {
  /** Distributor's per-product template override (for products the rules can't place). */
  templateOverride?: TemplateKind;
}

export function mapProduct(ps: PsProduct, cfg: PsConfiguration, opts: MapOptions = {}): MapResult {
  const notes: string[] = [];
  const label = `${ps.name} (${ps.productId})`;

  const template = templateFor(ps, opts.templateOverride);
  if (!template) return { notes: [`${label}: no product template fits "${ps.categories.map((c) => c.subCategory ?? c.category).join(', ') || ps.name}"; choose one to import it`] };

  const colors: CatalogProduct['colors'] = [];
  const noHex: string[] = [];
  for (const c of ps.colors) {
    const hex = colorHex(c.name, c.hex);
    if (!hex) noHex.push(c.name);
    else colors.push({ name: c.name, hex, isDark: isDarkHex(hex) });
  }
  if (noHex.length) notes.push(`${label}: colours without a hex value left out: ${noHex.join(', ')}`);
  if (!colors.length) return { notes: [...notes, `${label}: no colour has a hex value, so proofs can't be drawn`] };

  const methods: CatalogProduct['methods'] = [];
  const seen = new Set<string>();
  const skippedLoc = new Set<string>();
  const skippedMethod = new Set<string>();
  for (const loc of cfg.locations) {
    const zone = zoneFor(template, loc.name);
    if (!zone) {
      skippedLoc.add(loc.name);
      continue;
    }
    for (const d of loc.decorations) {
      const method = methodFor(d.name);
      if (!method) {
        skippedMethod.add(d.name);
        continue;
      }
      const w = d.widthIn ?? d.diameterIn;
      const h = d.heightIn ?? d.diameterIn;
      if (!w || !h) {
        notes.push(`${label}: ${d.name} on ${loc.name} has no imprint size; left out`);
        continue;
      }
      const key = `${method}|${zone}`;
      if (seen.has(key)) continue; // several supplier locations can map to one zone: keep the first
      seen.add(key);
      methods.push({ method, location: zone, w, h });
    }
  }
  if (skippedLoc.size) notes.push(`${label}: locations with no matching print area left out: ${[...skippedLoc].join(', ')}`);
  if (skippedMethod.size) notes.push(`${label}: decoration methods not supported left out: ${[...skippedMethod].join(', ')}`);
  if (!methods.length) return { notes: [...notes, `${label}: no supported decoration on a printable area`] };

  // Parts usually differ by colour and size, and larger sizes cost more. Price from the part
  // with the lowest first break (standard sizes); upsize surcharges aren't modelled yet.
  const priced = cfg.parts.filter((p) => p.breaks.length);
  if (!priced.length) return { notes: [...notes, `${label}: no readable blank price`] };
  const base = priced.reduce((a, b) => (b.breaks[0]!.unitCents < a.breaks[0]!.unitCents ? b : a));
  const breaks: QuantityBreak[] = base.breaks.map((b) => ({ minQty: b.minQuantity, blankUnitCost: b.unitCents }));

  const material = `${ps.primaryMaterial ?? ''} ${ps.description ?? ''}`;
  const apparel = template === 'tee' || template === 'polo' || template === 'cap' || template === 'tote';
  const traits: CatalogProduct['traits'] = apparel ? { isApparel: true } : { isHardGood: true };
  if (/polyester/i.test(material)) traits.isPolyester = true;
  if (/recycled|organic|\beco\b/i.test(material)) traits.isEco = true;

  const category = ps.categories[0]?.category ?? (apparel ? 'Apparel' : 'Promotional');
  return {
    product: {
      slug: slugify(ps.name),
      template,
      name: ps.name,
      category,
      brand: ps.brand ?? '',
      traits,
      blankBase: breaks[0]!.blankUnitCost,
      colors,
      methods,
      breaks,
    },
    notes,
  };
}
