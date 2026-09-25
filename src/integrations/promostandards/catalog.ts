/**
 * Pull a supplier's catalog through PromoStandards and map it to BrandCanvas products
 * (ADR 0017). Pure: no database. The caller persists the result.
 *
 * Per product: Product Data getProduct → PPC getFobPoints (unless a FOB is configured) →
 * PPC getConfigurationAndPricing (Blank, and Decorated only if Blank carries no locations).
 * One product failing never fails the run; it's reported. The whole run fails only when the
 * supplier can't be reached at all or rejects the credentials.
 */
import type { TemplateKind } from '@/imaging/templates';
import type { CatalogProduct } from '@/features/catalog/catalog';
import { SoapError, type SoapPost } from './soap';
import { getConfigurationAndPricing, getFobPointIds, getProduct, getSellableProductIds, type Credentials, type Localization } from './services';
import { mapProduct } from './map';

export interface SupplierEndpoints {
  productData: string;
  pricing: string;
}

export interface CatalogFetchOptions {
  endpoints: SupplierEndpoints;
  credentials: Credentials;
  currency: string;
  /** Net = the distributor's cost (default); List = MSRP. */
  priceType?: 'Net' | 'List';
  fobId?: string;
  localization?: Localization;
  /** Import only these products (the distributor's picks). Absent → every sellable product. */
  productIds?: string[];
  /** Hard cap per run, so a 10 000-product supplier can't monopolise a worker. */
  maxProducts?: number;
  concurrency?: number;
  templateOverrides?: Record<string, TemplateKind>;
}

export interface ImportedProduct {
  supplierProductId: string;
  product: CatalogProduct;
}

export interface CatalogFetchResult {
  imported: ImportedProduct[];
  /** Products looked at but not importable, with the reason. */
  skipped: Array<{ supplierProductId: string; reason: string }>;
  /** Partial omissions inside imported products (a colour without hex, an unknown method). */
  notes: string[];
  /** Products that errored (network, supplier fault). */
  failed: Array<{ supplierProductId: string; error: string }>;
  /** Sellable products left for a later run because of maxProducts. */
  remaining: number;
}

const DEFAULT_LOC: Localization = { country: 'US', language: 'en' };

export async function fetchSupplierCatalog(post: SoapPost, o: CatalogFetchOptions): Promise<CatalogFetchResult> {
  const loc = o.localization ?? DEFAULT_LOC;
  const all = o.productIds?.length ? [...new Set(o.productIds)] : await getSellableProductIds(post, o.endpoints.productData, o.credentials);
  const max = o.maxProducts ?? 500;
  const ids = all.slice(0, max);
  const res: CatalogFetchResult = { imported: [], skipped: [], notes: [], failed: [], remaining: Math.max(0, all.length - ids.length) };

  let next = 0;
  let authFailure: SoapError | null = null;
  const worker = async () => {
    while (next < ids.length && !authFailure) {
      const id = ids[next++]!;
      try {
        const ps = await getProduct(post, o.endpoints.productData, o.credentials, id, loc);
        const fobId = o.fobId ?? (await getFobPointIds(post, o.endpoints.pricing, o.credentials, id, loc))[0];
        if (!fobId) {
          res.skipped.push({ supplierProductId: id, reason: `${ps.name} (${id}): the supplier lists no FOB point to price from` });
          continue;
        }
        const problems: string[] = [];
        const q = { productId: id, currency: o.currency, fobId, priceType: o.priceType ?? 'Net' } as const;
        let cfg = await getConfigurationAndPricing(post, o.endpoints.pricing, o.credentials, { ...q, configurationType: 'Blank' }, loc, problems);
        if (!cfg.locations.length) {
          const dec = await getConfigurationAndPricing(post, o.endpoints.pricing, o.credentials, { ...q, configurationType: 'Decorated' }, loc, problems);
          cfg = { ...cfg, locations: dec.locations };
        }
        if (cfg.currency && cfg.currency.toUpperCase() !== o.currency.toUpperCase()) {
          res.skipped.push({ supplierProductId: id, reason: `${ps.name} (${id}): priced in ${cfg.currency}, not ${o.currency}` });
          continue;
        }
        res.notes.push(...problems.map((p) => `${ps.name} (${id}): ${p}`));
        const m = mapProduct(ps, cfg, o.templateOverrides?.[id] ? { templateOverride: o.templateOverrides[id] } : {});
        if (m.product) {
          res.imported.push({ supplierProductId: id, product: m.product });
          res.notes.push(...m.notes);
        } else res.skipped.push({ supplierProductId: id, reason: m.notes.join('; ') });
      } catch (e) {
        const err = e instanceof SoapError ? e : new SoapError((e as Error).message, 'network');
        // Bad credentials fail every call: stop instead of hammering the supplier.
        if (err.kind === 'service' && /^(100|104|105|110)$/.test(err.code ?? '')) authFailure = err;
        res.failed.push({ supplierProductId: id, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, ids.length || 1) }, worker));
  if (authFailure) throw authFailure;
  return res;
}
