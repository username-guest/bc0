/**
 * PromoStandards service clients (ADR 0017): Product Data 2.0.0 and Pricing & Configuration
 * (PPC) 1.0.0. Each function builds the request, calls the supplier, and returns plain data.
 * Field names follow the published schemas; elements are matched by local name, so suppliers'
 * differing namespace prefixes don't matter.
 */
import type { Cents } from '@/pricing/types';
import { call, SoapError, type SoapPost } from './soap';
import { child, childrenNamed, esc, findAll, text, type XmlNode } from './xml';

export interface Credentials {
  id: string;
  password: string;
}

export interface Localization {
  country: string; // 'US'
  language: string; // 'en'
}

const PD = {
  ns: 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/',
  shar: 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/',
};
const PPC = {
  ns: 'http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/',
  shar: 'http://www.promostandards.org/WSDL/PricingAndConfiguration/1.0.0/SharedObjects/',
};

const el = (tag: string, v: string | number | undefined) => (v === undefined || v === '' ? '' : `<shar:${tag}>${esc(v)}</shar:${tag}>`);
const auth = (wsVersion: string, c: Credentials) => el('wsVersion', wsVersion) + el('id', c.id) + el('password', c.password);

/* ---------------- Product Data 2.0.0 ---------------- */

/** getProductSellable: every sellable product id (parts collapsed). */
export async function getSellableProductIds(post: SoapPost, url: string, c: Credentials): Promise<string[]> {
  const { body } = await call(post, {
    url,
    action: 'getProductSellable',
    namespaces: PD,
    body: `<ns:GetProductSellableRequest>${auth('2.0.0', c)}${el('isSellable', 'true')}</ns:GetProductSellableRequest>`,
  });
  const ids = new Set<string>();
  for (const s of findAll(body, 'ProductSellable')) {
    const id = text(s, 'productId');
    if (id) ids.add(id);
  }
  return [...ids];
}

export interface PsColor {
  name: string;
  /** Normalised '#RRGGBB' when the supplier sent one. */
  hex?: string;
  pms?: string;
}

export interface PsProduct {
  productId: string;
  name: string;
  brand?: string;
  description?: string;
  categories: Array<{ category: string; subCategory?: string }>;
  /** Distinct colours across parts, first-seen order. */
  colors: PsColor[];
  primaryMaterial?: string;
  isCloseout: boolean;
}

export function normaliseHex(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const h = raw.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(h)) return `#${h.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${[...h].map((c) => c + c).join('').toUpperCase()}`;
  return undefined;
}

export function parseProduct(body: XmlNode): PsProduct {
  const p = child(body, 'Product');
  const productId = text(p, 'productId');
  if (!p || !productId) throw new SoapError('Product Data response has no Product', 'parse');
  const categories = findAll(child(p, 'ProductCategoryArray'), 'ProductCategory')
    .map((c) => ({ category: text(c, 'category') ?? '', subCategory: text(c, 'subCategory') }))
    .filter((c) => c.category)
    .map((c) => (c.subCategory ? { category: c.category, subCategory: c.subCategory } : { category: c.category }));
  const colors: PsColor[] = [];
  const seen = new Set<string>();
  for (const part of findAll(child(p, 'ProductPartArray'), 'ProductPart')) {
    for (const c of findAll(part, 'Color')) {
      const name = text(c, 'colorName') ?? text(c, 'standardColorName');
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const hex = normaliseHex(text(c, 'hex'));
      const pms = text(c, 'approximatePms');
      colors.push({ name, ...(hex ? { hex } : {}), ...(pms ? { pms } : {}) });
    }
  }
  const description = childrenNamed(p, 'description').map((d) => d.text).filter(Boolean).join(' ');
  const out: PsProduct = {
    productId,
    name: text(p, 'productName') ?? productId,
    categories,
    colors,
    isCloseout: (text(p, 'isCloseout') ?? 'false').toLowerCase() === 'true',
  };
  const brand = text(p, 'productBrand');
  if (brand) out.brand = brand;
  if (description) out.description = description;
  const mat = text(p, 'primaryMaterial');
  if (mat) out.primaryMaterial = mat;
  return out;
}

export async function getProduct(post: SoapPost, url: string, c: Credentials, productId: string, loc: Localization): Promise<PsProduct> {
  const { body } = await call(post, {
    url,
    action: 'getProduct',
    namespaces: PD,
    body: `<ns:GetProductRequest>${auth('2.0.0', c)}${el('localizationCountry', loc.country)}${el('localizationLanguage', loc.language)}${el('productId', productId)}</ns:GetProductRequest>`,
  });
  return parseProduct(body);
}

/* ---------------- Pricing & Configuration 1.0.0 ---------------- */

export async function getFobPointIds(post: SoapPost, url: string, c: Credentials, productId: string, loc: Localization): Promise<string[]> {
  const { body } = await call(post, {
    url,
    action: 'getFobPoints',
    namespaces: PPC,
    body: `<ns:GetFobPointsRequest>${auth('1.0.0', c)}${el('productId', productId)}${el('localizationCountry', loc.country)}${el('localizationLanguage', loc.language)}</ns:GetFobPointsRequest>`,
  });
  return findAll(body, 'FobPoint')
    .map((f) => text(f, 'fobId'))
    .filter((x): x is string => !!x);
}

export interface PsPriceBreak {
  minQuantity: number;
  /** Per single unit, integer cents. */
  unitCents: Cents;
}

export interface PsDecoration {
  name: string;
  widthIn?: number;
  heightIn?: number;
  diameterIn?: number;
  isDefault: boolean;
}

export interface PsLocation {
  name: string;
  isDefault: boolean;
  decorations: PsDecoration[];
}

export interface PsConfiguration {
  productId: string;
  currency: string;
  /** Per part id. Parts often differ only by colour/size; callers pick. */
  parts: Array<{ partId: string; breaks: PsPriceBreak[] }>;
  locations: PsLocation[];
}

/** Units per price UOM. Anything else can't be turned into a per-unit cost safely. */
const UOM_UNITS: Record<string, number> = { EA: 1, PR: 1, ST: 1, DZ: 12, HU: 100, TH: 1000 };

/**
 * A decimal price string to integer cents, exactly (no float): "3.456" → 346, "12" → 1200.
 * Rounds half up at the third decimal. Negative, empty or malformed → null.
 */
export function priceToCents(raw: string | undefined, units = 1): Cents | null {
  if (!raw) return null;
  const m = /^\s*(\d{1,9})(?:\.(\d{1,6}))?\s*$/.exec(raw);
  if (!m) return null;
  // Work in millionths of a dollar as a bigint-safe integer (max 1e9 * 1e6 = 1e15 < 2^53).
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
  const perUnitMicros = micros / units; // may be fractional for DZ etc.
  return Math.round(perUnitMicros / 10_000); // micros → cents, half up for positives
}

const toInches = (v: string | undefined, uom: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = (uom ?? 'IN').toUpperCase();
  if (u === 'IN' || u === 'INCH' || u === 'INCHES') return n;
  if (u === 'CM') return Math.round((n / 2.54) * 100) / 100;
  if (u === 'MM') return Math.round((n / 25.4) * 100) / 100;
  return undefined;
};

export function parseConfiguration(body: XmlNode, problems: string[] = []): PsConfiguration {
  const cfg = child(body, 'Configuration');
  if (!cfg) throw new SoapError('Pricing response has no Configuration', 'parse');
  const productId = text(cfg, 'productId') ?? '';
  const parts: PsConfiguration['parts'] = [];
  for (const part of findAll(child(cfg, 'PartArray'), 'Part')) {
    const partId = text(part, 'partId') ?? '';
    const breaks: PsPriceBreak[] = [];
    for (const pp of findAll(part, 'PartPrice')) {
      const minQuantity = Number(text(pp, 'minQuantity'));
      const uom = (text(pp, 'priceUom') ?? 'EA').toUpperCase();
      const units = UOM_UNITS[uom];
      if (!units) {
        problems.push(`part ${partId}: price unit "${uom}" not understood`);
        continue;
      }
      const unitCents = priceToCents(text(pp, 'price'), units);
      if (!Number.isInteger(minQuantity) || minQuantity < 1 || unitCents === null) {
        problems.push(`part ${partId}: unreadable price break`);
        continue;
      }
      breaks.push({ minQuantity, unitCents });
    }
    breaks.sort((a, b) => a.minQuantity - b.minQuantity);
    if (breaks.length) parts.push({ partId, breaks });
  }
  const locations: PsLocation[] = [];
  for (const loc of findAll(child(cfg, 'LocationArray'), 'Location')) {
    const name = text(loc, 'locationName');
    if (!name) continue;
    const decorations: PsDecoration[] = [];
    for (const d of findAll(loc, 'Decoration')) {
      const dname = text(d, 'decorationName');
      if (!dname) continue;
      const uom = text(d, 'decorationUom');
      const w = toInches(text(d, 'decorationWidth'), uom);
      const h = toInches(text(d, 'decorationHeight'), uom);
      const dia = toInches(text(d, 'decorationDiameter'), uom);
      decorations.push({
        name: dname,
        ...(w ? { widthIn: w } : {}),
        ...(h ? { heightIn: h } : {}),
        ...(dia ? { diameterIn: dia } : {}),
        isDefault: (text(d, 'defaultDecoration') ?? '').toLowerCase() === 'true',
      });
    }
    locations.push({ name, isDefault: (text(loc, 'defaultLocation') ?? '').toLowerCase() === 'true', decorations });
  }
  return { productId, currency: text(cfg, 'currency') ?? '', parts, locations };
}

export async function getConfigurationAndPricing(
  post: SoapPost,
  url: string,
  c: Credentials,
  q: { productId: string; currency: string; fobId: string; priceType: 'Net' | 'List' | 'Customer'; configurationType: 'Blank' | 'Decorated' },
  loc: Localization,
  problems: string[] = [],
): Promise<PsConfiguration> {
  const { body } = await call(post, {
    url,
    action: 'getConfigurationAndPricing',
    namespaces: PPC,
    body:
      `<ns:GetConfigurationAndPricingRequest>${auth('1.0.0', c)}${el('productId', q.productId)}${el('currency', q.currency)}` +
      `${el('fobId', q.fobId)}${el('priceType', q.priceType)}${el('localizationCountry', loc.country)}${el('localizationLanguage', loc.language)}` +
      `${el('configurationType', q.configurationType)}</ns:GetConfigurationAndPricingRequest>`,
  });
  return parseConfiguration(body, problems);
}
