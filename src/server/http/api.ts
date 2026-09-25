/**
 * Tenant API handlers — framework-agnostic, standard Web `Request → Response`.
 * Next.js route handlers call these directly (src/app/api/t/[tenant]/…); the offline dev server
 * adapts Node's http module to the same signature. One implementation, two hosts.
 *
 * Every gate is evaluated here from the server-built TenantContext. Nothing the client sends
 * (plan, flags, prices, colour counts) is trusted.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DecorationMethodKey } from '@/pricing/types';
import type { StorageProvider } from '@/shared/providers';
import type { TenantContext } from '@/server/tenancy/context';
import { leadSettings, publicTenantConfig } from '@/server/tenancy/context';
import type { RateLimiter } from '@/server/rate-limit';
import type { AnalyticsRepo, DeliveryRepo, LeadRepo, LogoRecord, LogoRepo, ProductRepo, ProofJobRepo } from '@/server/repos/types';
import { createProofQueue } from '@/server/jobs/proofs';
import { createTracker } from './tracking';
import type { CrmRouter } from '@/server/crm';
import { createDeliveryService } from '@/server/leads/delivery';
import { loadOrCreateSession, sessionCookieHeader, type ProspectSession, type SessionStore } from '@/server/session';
import { lockedProducts, proofAllowed, type GateState } from '@/features/leads/rules';
import { createProofService, REVIEW_NOTE } from './proof-service';
import { createLeadHandlers } from './leads-api';
import { intakeLogo, LogoIntakeError, sniffType, type ImageCodec } from '@/features/logo-intake/intake';
import { searchCatalog, type CatalogQuery } from '@/features/catalog/catalog';
import { encodePng } from '@/imaging/png';
import { disclaimerFor, prospectLines } from '@/pricing/engine';
import { DECORATION_METHOD_KEYS, isDecorationMethodKey } from '@/core/domain/decoration-methods';
import {
  EXT,
  INTAKE_STATUS,
  MIME,
  UUID,
  apiBase,
  body,
  clientIp,
  fail,
  jsonResponse,
  limited,
  locked,
  readJsonObject,
} from './shared';
import { isColorFamilyKey, type ColorFamilyKey } from '@/core/domain/color-families';

export interface ApiDeps {
  logos: LogoRepo;
  products: ProductRepo;
  storage: StorageProvider;
  limits: { upload: RateLimiter; proof: RateLimiter; lead: RateLimiter; visit: RateLimiter };
  sessions: SessionStore;
  /** Tracked links + funnel events (ADR 0014). */
  analytics: AnalyticsRepo;
  /** Proof pre-rendering queue (ADR 0015). */
  proofJobs: ProofJobRepo;
  /** Called when renders are queued, so an in-process worker can start at once. */
  onProofJobsQueued?: () => void;
  leads: LeadRepo;
  /** Outbox of CRM deliveries, one per capture (ADR 0008). */
  deliveries: DeliveryRepo;
  /** CRM routing for a tenant (inbox or webhook), from its settings and entitlements. */
  crmFor: CrmRouter;
  /** HMAC key for prospect-session cookies (from AUTH_SECRET/SESSION_SECRET in production). */
  sessionSecret: string;
  /** Mark cookies Secure (true everywhere except plain-http local dev). */
  secureCookies: boolean;
  maxUploadBytes: number;
  /** Only read X-Forwarded-For behind a trusted proxy; otherwise it's attacker-controlled. */
  trustProxy: boolean;
  /** Decoder for uploads; defaults to the local PNG-only codec. Production passes the sharp codec. */
  codec?: ImageCodec;
  newId?: () => string;
  now?: () => Date;
}

export function logoDto(rec: LogoRecord, ctx: TenantContext) {
  return {
    id: rec.id,
    colorCount: rec.palette.colorCount,
    colors: rec.palette.colors.map((c) => ({ hex: c.hex, coverage: Math.round(c.coverage * 1000) / 1000 })),
    isPhotographic: rec.palette.isPhotographic,
    isVector: rec.isVector,
    knockoutEnclosed: rec.knockoutEnclosed,
    background: rec.background,
    recommendedMethods: rec.recommendedMethods.filter((m) => ctx.methods.includes(m)),
    warnings: rec.warnings,
    needsReview: rec.needsReview,
    cleanUrl: `${apiBase(ctx)}/logos/${rec.id}/clean.png`,
  };
}

/* ------------------------------ handlers ------------------------------ */

export function createTenantApi(deps: ApiDeps) {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const proofs = createProofService(deps);
  const tracker = createTracker(deps.analytics, now);
  const proofQueue = createProofQueue({
    jobs: deps.proofJobs,
    products: deps.products,
    logos: deps.logos,
    proofs,
    now,
    newId,
    onQueued: () => deps.onProofJobsQueued?.(),
  });

  type SessionHandle = { session: ProspectSession; isNew: boolean };
  const sessionFor = (req: Request, ctx: TenantContext): Promise<SessionHandle> =>
    loadOrCreateSession(req, ctx.tenant.id, deps.sessions, deps.sessionSecret);
  /** Persist new sessions and attach the cookie. */
  async function withSession(res: Response, h: SessionHandle): Promise<Response> {
    if (h.isNew) {
      await deps.sessions.save(h.session);
      res.headers.append('set-cookie', sessionCookieHeader(h.session.id, deps.sessionSecret, deps.secureCookies));
    }
    return res;
  }
  function gateState(ctx: TenantContext, s: ProspectSession): GateState {
    const g = leadSettings(ctx).gate;
    return { mode: g.mode, freeProducts: g.freeProducts, hasLead: !!s.leadId, seenProducts: s.proofProducts };
  }
  function gateSummary(ctx: TenantContext, s: ProspectSession) {
    const g = gateState(ctx, s);
    return {
      mode: g.mode,
      freeProducts: g.freeProducts,
      hasLead: g.hasLead,
      remaining: g.mode === 'hard' && !g.hasLead ? Math.max(0, g.freeProducts - g.seenProducts.length) : null,
    };
  }

  /** POST multipart/form-data { file, knockout? } */
  async function uploadLogo(req: Request, ctx: TenantContext): Promise<Response> {
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');
    const gate = locked(ctx, 'logo_upload_cleanup');
    if (gate) return gate;
    const rl = await limited(deps.limits.upload, `upload:${ctx.tenant.id}:${clientIp(req, deps.trustProxy)}`);
    if (rl) return rl;

    // Refuse obviously oversize bodies before buffering them (multipart overhead allowance).
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > deps.maxUploadBytes + 64 * 1024) {
      return fail(413, 'too_large', `File exceeds ${Math.round(deps.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
      return fail(415, 'invalid_request', 'Send the logo as multipart/form-data with a "file" field.');
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, 'invalid_request', 'Could not read the upload.');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') return fail(400, 'invalid_request', 'Missing "file" field.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > deps.maxUploadBytes) {
      return fail(413, 'too_large', `File exceeds ${Math.round(deps.maxUploadBytes / 1024 / 1024)} MB.`);
    }
    const knockout = form.get('knockout') === 'true';

    // Idempotent re-upload: same bytes + same knockout choice → the existing asset.
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = await deps.logos.findByHash(ctx.tenant.id, hash, knockout);
    if (existing) {
      await proofQueue.enqueueFor(ctx, existing); // already-queued proofs are skipped
      return jsonResponse(200, { logo: logoDto(existing, ctx), deduplicated: true });
    }

    let processed;
    try {
      processed = await intakeLogo(bytes, {
        maxBytes: deps.maxUploadBytes,
        knockoutEnclosed: knockout,
        skipBackgroundRemoval: !ctx.can('auto_bg_removal'),
        ...(deps.codec ? { codec: deps.codec } : {}),
      });
    } catch (e) {
      if (e instanceof LogoIntakeError) return fail(INTAKE_STATUS[e.code], e.code, e.message);
      throw e;
    }

    const id = newId();
    const type = sniffType(bytes);
    const originalKey = `logos/${id}/original.${EXT[type]}`;
    const cleanKey = `logos/${id}/clean.png`;
    await deps.storage.put(originalKey, bytes, MIME[type]!, ctx.tenant.id);
    await deps.storage.put(cleanKey, encodePng(processed.raster), 'image/png', ctx.tenant.id);

    const rec: LogoRecord = {
      id,
      tenantId: ctx.tenant.id,
      hash: processed.hash,
      knockoutEnclosed: knockout,
      sourceType: processed.sourceType,
      isVector: processed.isVector,
      sourceSize: processed.sourceSize,
      originalKey,
      cleanKey,
      palette: {
        colors: processed.palette.colors,
        colorCount: processed.palette.colorCount,
        isPhotographic: processed.palette.isPhotographic,
      },
      background: {
        removed: processed.background.removed,
        confidence: processed.background.confidence,
        reason: processed.background.reason,
        enclosedRegions: processed.background.enclosedRegions,
      },
      recommendedMethods: processed.recommendedMethods,
      warnings: processed.warnings,
      needsReview: processed.needsReview,
      createdAt: now().toISOString(),
    };
    await deps.logos.create(rec);
    // Pre-render the first page of the catalog in the background (ADR 0015).
    await proofQueue.enqueueFor(ctx, rec);
    return jsonResponse(201, { logo: logoDto(rec, ctx) });
  }

  /** GET the cleaned logo PNG (tenant-scoped). */
  async function logoImage(_req: Request, ctx: TenantContext, logoId: string): Promise<Response> {
    if (!UUID.test(logoId)) return fail(404, 'logo_not_found', 'Logo not found.');
    const rec = await deps.logos.get(ctx.tenant.id, logoId);
    if (!rec) return fail(404, 'logo_not_found', 'Logo not found.');
    const obj = await deps.storage.get(rec.cleanKey, ctx.tenant.id);
    if (!obj) return fail(404, 'logo_not_found', 'Logo image missing.');
    return new Response(body(obj.data), {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
    });
  }

  /** GET ?qty&logo&family*&category*&method*&eco&max&sort */
  async function catalog(req: Request, ctx: TenantContext): Promise<Response> {
    const gate = locked(ctx, 'core_catalog');
    if (gate) return gate;
    const url = new URL(req.url);
    const p = url.searchParams;
    const problems: string[] = [];

    const qtyRaw = p.get('qty') ?? '144';
    const quantity = /^\d{1,6}$/.test(qtyRaw) ? Number(qtyRaw) : NaN;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) problems.push('qty must be an integer from 1 to 100000');

    const families = p.getAll('family');
    const badFam = families.filter((f) => !isColorFamilyKey(f));
    if (badFam.length) problems.push(`unknown family: ${badFam.join(', ')}`);

    const methods = p.getAll('method');
    const badMethods = methods.filter((m) => !isDecorationMethodKey(m));
    if (badMethods.length) problems.push(`unknown method: ${badMethods.join(', ')}`);

    const categories = p.getAll('category').map((c) => c.trim()).filter(Boolean);
    if (categories.some((c) => c.length > 60)) problems.push('category too long');

    const maxRaw = p.get('max');
    const maxUnitPrice = maxRaw === null ? undefined : /^\d{1,7}$/.test(maxRaw) ? Number(maxRaw) : NaN;
    if (Number.isNaN(maxUnitPrice)) problems.push('max must be whole cents');

    const sort = p.get('sort') ?? 'recommended';
    if (!['recommended', 'price_asc', 'price_desc'].includes(sort)) problems.push('sort must be recommended | price_asc | price_desc');

    const logoId = p.get('logo');
    if (logoId !== null && !UUID.test(logoId)) problems.push('logo must be a logo id');

    const eco = p.get('eco') === '1';
    if (problems.length) return fail(400, 'invalid_query', 'Invalid catalog query.', { details: problems });

    if (eco) {
      const g = locked(ctx, 'sustainable_filter');
      if (g) return g;
    }
    const lockedMethods = (methods as DecorationMethodKey[]).filter((m) => !ctx.methods.includes(m));
    if (lockedMethods.length) {
      return fail(403, 'feature_locked', 'Some decoration methods are not included in the current plan.', { feature: 'all_decoration_methods', methods: lockedMethods, upgradeable: true });
    }

    const logo = logoId ? await deps.logos.get(ctx.tenant.id, logoId) : null;
    if (logoId && !logo) return fail(404, 'logo_not_found', 'Logo not found.');

    const query: CatalogQuery = {
      quantity,
      logo: logo ? { colorCount: logo.palette.colorCount, isPhotographic: logo.palette.isPhotographic } : { colorCount: 1, isPhotographic: false },
      entitledMethods: ctx.methods,
      sort: sort as NonNullable<CatalogQuery['sort']>,
      ...(families.length ? { colorFamilies: families as ColorFamilyKey[] } : {}),
      ...(categories.length ? { categories } : {}),
      ...(methods.length ? { methods: methods as DecorationMethodKey[] } : {}),
      ...(eco ? { ecoOnly: true } : {}),
      ...(maxUnitPrice !== undefined ? { maxUnitPrice } : {}),
    };
    const products = await deps.products.list(ctx.tenant.id);
    const res = searchCatalog(products, query, ctx.tenant.pricingConfig);
    const withProofs = !!logo && ctx.can('brand_exact_proof');
    const withBreaks = ctx.can('qty_price_break_preview');
    const sh = await sessionFor(req, ctx);
    // Same rule the proof endpoint enforces — the UI can't show as open what the server refuses.
    const lockedSet = withProofs ? lockedProducts(gateState(ctx, sh.session), res.items.map((i) => i.slug)) : new Set<string>();

    return withSession(jsonResponse(200, {
      gate: gateSummary(ctx, sh.session),
      quantity: res.quantity,
      estimated: true,
      disclaimer: disclaimerFor(ctx.tenant.pricingConfig),
      facets: ctx.can('basic_facets') ? res.facets : null,
      items: res.items.map((i) => ({
        slug: i.slug,
        name: i.name,
        brand: i.brand,
        category: i.category,
        isEco: i.isEco,
        color: i.color,
        method: i.recommended.method,
        location: i.recommended.location,
        imprint: i.recommended.imprint,
        unit: i.recommended.unit,
        total: i.recommended.total,
        // Selling prices only (never blank cost or margin), and only if the distributor shows them.
        lines: ctx.tenant.pricingConfig.showItemizedToProspect ? prospectLines(i.recommended.quote) : null,
        alternatives: i.alternatives,
        priceBreaks: withBreaks ? i.priceBreaks : [],
        locked: lockedSet.has(i.slug),
        proofUrl:
          withProofs && !lockedSet.has(i.slug)
            ? `${apiBase(ctx)}/proofs?${new URLSearchParams({ logo: logo!.id, product: i.slug, color: i.color.hex, method: i.recommended.method, location: i.recommended.location })}`
            : null,
      })),
    }), sh);
  }

  /** GET ?logo&product&color&method&location → image/png (content-addressed, cached, gated). */
  async function proof(req: Request, ctx: TenantContext): Promise<Response> {
    const gate = locked(ctx, 'brand_exact_proof');
    if (gate) return gate;
    const p = new URL(req.url).searchParams;
    const logoId = p.get('logo') ?? '';
    if (!UUID.test(logoId)) return fail(400, 'invalid_query', 'Invalid proof request.', { details: ['logo'] });
    const resolved = await proofs.resolveConfiguration(ctx, {
      product: p.get('product') ?? '',
      color: p.get('color') ?? '',
      method: p.get('method') ?? '',
      location: p.get('location') ?? '',
    });
    if (!resolved.ok) return resolved.response;
    const c = resolved.config;
    const rec = await deps.logos.get(ctx.tenant.id, logoId);
    if (!rec) return fail(404, 'logo_not_found', 'Logo not found.');

    // Lead gate — enforced here, not just hidden in the UI (§17).
    const sh = await sessionFor(req, ctx);
    if (!proofAllowed(gateState(ctx, sh.session), c.product.slug)) {
      return withSession(fail(403, 'lead_required', 'Enter your email to see your logo on more products.', { gate: gateSummary(ctx, sh.session) }), sh);
    }
    if (!sh.session.proofProducts.includes(c.product.slug)) {
      sh.session.proofProducts.push(c.product.slug);
      await deps.sessions.save(sh.session);
    }

    const etag = `"${proofs.cacheKeyFor(rec, c)}"`;
    if (req.headers.get('if-none-match') === etag) {
      await tracker.track(ctx, sh.session, 'proof');
      return withSession(new Response(null, { status: 304, headers: { etag } }), sh);
    }

    const r = await proofs.getProof(ctx, rec, c, () => limited(deps.limits.proof, `proof:${ctx.tenant.id}:${clientIp(req, deps.trustProxy)}`));
    if (r.status === 'refused') return r.response;
    if (r.status === 'needs_placement') return fail(409, 'needs_placement', r.reason);
    const notes = rec.needsReview ? [REVIEW_NOTE, ...r.notes] : r.notes;
    await tracker.track(ctx, sh.session, 'proof');
    return withSession(
      new Response(body(r.png), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=31536000, immutable',
          etag,
          'x-proof-cache': r.cache,
          'x-proof-notes': encodeURIComponent(JSON.stringify(notes)),
          'x-content-type-options': 'nosniff',
        },
      }),
      sh,
    );
  }

  /** POST /logos/:id/confirm { keepEnclosed: true } — the prospect confirmed the cleanup. */
  async function confirmLogo(req: Request, ctx: TenantContext, logoId: string): Promise<Response> {
    if (!UUID.test(logoId)) return fail(404, 'logo_not_found', 'Logo not found.');
    const b = await readJsonObject(req);
    if (!b || b.keepEnclosed !== true) return fail(400, 'invalid_body', 'Send {"keepEnclosed": true}.');
    const rec = await deps.logos.get(ctx.tenant.id, logoId);
    if (!rec) return fail(404, 'logo_not_found', 'Logo not found.');
    const updated = await deps.logos.update(ctx.tenant.id, logoId, {
      needsReview: false,
      warnings: rec.warnings.filter((w) => !/enclosed/i.test(w)),
    });
    return jsonResponse(200, { logo: logoDto(updated!, ctx) });
  }

  /** GET session status: gate progress + whether we already have this prospect's email. */
  async function session(req: Request, ctx: TenantContext): Promise<Response> {
    const sh = await sessionFor(req, ctx);
    return withSession(jsonResponse(200, { gate: gateSummary(ctx, sh.session), email: sh.session.email ?? null }), sh);
  }

  /**
   * POST { src? } — the storefront's page-load beacon (ADR 0014). Attributes the session to a
   * tracked link (first touch) and records one visit per session per day. Answers like GET
   * /session so the page needs only this one call.
   */
  async function visit(req: Request, ctx: TenantContext): Promise<Response> {
    const rl = await limited(deps.limits.visit, `visit:${ctx.tenant.id}:${clientIp(req, deps.trustProxy)}`);
    if (rl) return rl;
    const b = (await readJsonObject(req)) ?? {};
    const sh = await sessionFor(req, ctx);
    if ((await tracker.attribute(ctx, sh.session, b.src)) && !sh.isNew) await deps.sessions.save(sh.session);
    if (tracker.isVisitor(req)) await tracker.track(ctx, sh.session, 'visit');
    return withSession(jsonResponse(200, { gate: gateSummary(ctx, sh.session), email: sh.session.email ?? null }), sh);
  }

  /** GET public tenant config (branding + presentation flag snapshot). */
  async function config(_req: Request, ctx: TenantContext): Promise<Response> {
    return jsonResponse(200, publicTenantConfig(ctx), { 'cache-control': 'private, max-age=60' });
  }

  const delivery = createDeliveryService({ deliveries: deps.deliveries, leads: deps.leads, crmFor: deps.crmFor, now, newId });
  const leadHandlers = createLeadHandlers({ deps, proofs, sessionFor, withSession, gateSummary, delivery, tracker, now, newId });
  return {
    uploadLogo,
    logoImage,
    confirmLogo,
    catalog,
    proof,
    session,
    visit,
    config,
    ...leadHandlers,
    delivery,
    /** Proof pre-rendering queue: the worker and `npm run jobs:proofs` drive it (ADR 0015). */
    proofQueue,
    /** The repos behind delivery, so the admin API shares the exact same instances. */
    deliveryDeps: { leads: deps.leads, deliveries: deps.deliveries },
  };
}

export type TenantApi = ReturnType<typeof createTenantApi>;

/** All method keys, exported for clients that render method pickers from the snapshot. */
export const ALL_METHODS = DECORATION_METHOD_KEYS;
export { jsonResponse } from './shared';
