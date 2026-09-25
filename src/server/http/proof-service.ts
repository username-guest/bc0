/**
 * Proof configuration + render/cache, shared by the proof endpoint and the PDF leave-behind so
 * both apply identical validation and hit the same content-addressed cache.
 */
import type { DecorationMethodKey } from '@/pricing/types';
import type { StorageProvider } from '@/shared/providers';
import type { TenantContext } from '@/server/tenancy/context';
import type { LogoRecord, ProductRepo } from '@/server/repos/types';
import type { CatalogProduct } from '@/features/catalog/catalog';
import { proofCacheKey, renderProof } from '@/features/mockup/proof';
import { decodePng } from '@/imaging/png';
import { isDecorationMethodKey, isMethodCompatible } from '@/core/domain/decoration-methods';
import { HEX, LOCATION, SLUGISH, fail, logoCacheId } from './shared';

/** Added per response from the logo's CURRENT state — never baked into cached notes. */
export const REVIEW_NOTE = 'Logo cleanup needs confirmation — this preview may change.';

export interface ConfigSpec {
  product: string;
  color: string;
  method: string;
  location: string;
}

export interface ResolvedConfig {
  product: CatalogProduct;
  color: string; // upper-case hex
  variant: CatalogProduct['colors'][number];
  method: DecorationMethodKey;
  location: string;
}

export type ProofResult =
  | { status: 'ready'; png: Uint8Array; notes: string[]; cacheKey: string; cache: 'hit' | 'miss' }
  | { status: 'needs_placement'; reason: string }
  | { status: 'refused'; response: Response };

export function createProofService(deps: { products: ProductRepo; storage: StorageProvider }) {
  /**
   * Only REAL product configurations are valid: a colour the product comes in, a method +
   * location it's offered with, physically compatible, and within the plan's entitlement.
   */
  async function resolveConfiguration(
    ctx: TenantContext,
    spec: ConfigSpec,
  ): Promise<{ ok: true; config: ResolvedConfig } | { ok: false; response: Response }> {
    const color = spec.color.toUpperCase();
    const problems: string[] = [];
    if (!SLUGISH.test(spec.product)) problems.push('product');
    if (!HEX.test(color)) problems.push('color');
    if (!isDecorationMethodKey(spec.method)) problems.push('method');
    if (!LOCATION.test(spec.location)) problems.push('location');
    if (problems.length) return { ok: false, response: fail(400, 'invalid_query', 'Invalid product configuration.', { details: problems }) };
    const method = spec.method as DecorationMethodKey;
    if (!ctx.methods.includes(method)) {
      return { ok: false, response: fail(403, 'feature_locked', 'This decoration method is not included in the current plan.', { feature: 'all_decoration_methods', upgradeable: true }) };
    }
    const product = await deps.products.get(ctx.tenant.id, spec.product);
    if (!product) return { ok: false, response: fail(404, 'product_not_found', 'Product not found.') };
    const variant = product.colors.find((c) => c.hex.toUpperCase() === color);
    if (!variant) return { ok: false, response: fail(400, 'invalid_color', 'That colour is not offered for this product.') };
    if (!product.methods.some((x) => x.method === method && x.location === spec.location)) {
      return { ok: false, response: fail(400, 'unsupported_decoration', 'This product is not offered with that method/location.') };
    }
    const traits = {
      isApparel: Boolean(product.traits.isApparel),
      isHardGood: Boolean(product.traits.isHardGood),
      isPolyester: Boolean(product.traits.isPolyester),
      isDark: Boolean(variant.isDark),
    };
    if (!isMethodCompatible(method, traits)) {
      return { ok: false, response: fail(422, 'incompatible_decoration', 'That method cannot be used on this product colour/material.') };
    }
    return { ok: true, config: { product, color, variant, method, location: spec.location } };
  }

  function cacheKeyFor(rec: LogoRecord, c: ResolvedConfig): string {
    return proofCacheKey({ logoHash: logoCacheId(rec), productRef: c.product.slug, colorHex: c.color, method: c.method, location: c.location });
  }

  /**
   * Cached proof, or render + cache it. `beforeRender` runs only on a cache MISS (rate limiting:
   * only real renders cost anything); returning a Response aborts with it.
   */
  async function getProof(ctx: TenantContext, rec: LogoRecord, c: ResolvedConfig, beforeRender?: () => Promise<Response | null> | Response | null): Promise<ProofResult> {
    const cacheKey = cacheKeyFor(rec, c);
    const pngKey = `proofs/${cacheKey}.png`;
    const hit = await deps.storage.get(pngKey, ctx.tenant.id);
    if (hit) {
      const meta = await deps.storage.get(`proofs/${cacheKey}.json`, ctx.tenant.id);
      const notes = meta ? (JSON.parse(new TextDecoder().decode(meta.data)) as { notes: string[] }).notes : [];
      return { status: 'ready', png: hit.data, notes, cacheKey, cache: 'hit' };
    }
    const refused = await beforeRender?.();
    if (refused) return { status: 'refused', response: refused };

    const clean = await deps.storage.get(rec.cleanKey, ctx.tenant.id);
    if (!clean) return { status: 'refused', response: fail(404, 'logo_not_found', 'Logo image missing.') };
    const outcome = renderProof({
      // needsReview: false — the review note is request-time state, not part of the cached image.
      logo: { hash: logoCacheId(rec), raster: decodePng(clean.data), needsReview: false, palette: { colors: rec.palette.colors } },
      productRef: c.product.slug,
      template: c.product.template,
      colorHex: c.color,
      method: c.method,
      location: c.location,
    });
    if (outcome.status === 'needs_placement') return { status: 'needs_placement', reason: outcome.reason };
    await deps.storage.put(pngKey, outcome.png, 'image/png', ctx.tenant.id);
    await deps.storage.put(`proofs/${cacheKey}.json`, new TextEncoder().encode(JSON.stringify({ notes: outcome.notes })), 'application/json', ctx.tenant.id);
    return { status: 'ready', png: outcome.png, notes: outcome.notes, cacheKey, cache: 'miss' };
  }

  return { resolveConfiguration, getProof, cacheKeyFor };
}

export type ProofService = ReturnType<typeof createProofService>;
