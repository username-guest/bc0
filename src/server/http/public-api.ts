/**
 * Public REST API, v1 (ADR 0016). Server-to-server, read-only, authenticated with an API key:
 *
 *   Authorization: Bearer bck_<keyId>_<secret>
 *
 * Served on the tenant's own host (`/api/v1/...`, rewritten to /api/t/<ref>/v1/...), so a key only
 * ever works for the tenant that issued it. No cookies are read and no CORS headers are sent:
 * browsers can't call it with a user's session, and keys must not live in browsers.
 */
import { randomBytes } from 'node:crypto';
import type { TenantContext } from '@/server/tenancy/context';
import type { RateLimiter } from '@/server/rate-limit';
import type { AnalyticsRepo, ApiKeyRecord, ApiKeyRepo, ApiScope, LeadRecord, LeadRepo, LeadSource, ProductRepo } from '@/server/repos/types';
import { hashSecret, safeEqual } from '@/server/admin/auth';
import { searchCatalog } from '@/features/catalog/catalog';
import { disclaimerFor } from '@/pricing/engine';
import { RANGE_DAYS, dayRange, summarize } from '@/features/analytics/funnel';
import { UUID, fail, jsonResponse, limited } from './shared';

const KEY_RE = /^bck_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Only write last_used_at when it's this stale, so busy keys don't turn every read into a write. */
const TOUCH_EVERY_MS = 60_000;
const SOURCES: readonly LeadSource[] = ['email_gate', 'quote_request', 'pdf_leavebehind'];

/** A fresh key: the full token (shown once) and what to store. */
export function mintApiKey(): { token: string; keyId: string; secretHash: string } {
  const bytes = randomBytes(12);
  let keyId = '';
  for (const b of bytes) keyId += KEY_ID_ALPHABET[b % KEY_ID_ALPHABET.length];
  const secret = randomBytes(32).toString('base64url');
  return { token: `bck_${keyId}_${secret}`, keyId, secretHash: hashSecret(secret) };
}

export interface PublicApiDeps {
  keys: ApiKeyRepo;
  leads: LeadRepo;
  products: ProductRepo;
  analytics: AnalyticsRepo;
  /** Per key. */
  limit: RateLimiter;
  now: () => Date;
}

const denied = (status: 401 | 403, code: 'unauthorized' | 'insufficient_scope', message: string, extra: Record<string, unknown> = {}) =>
  fail(status, code, message, extra, {
    'www-authenticate': status === 401 ? 'Bearer realm="api", error="invalid_token"' : `Bearer realm="api", error="insufficient_scope"`,
    'cache-control': 'no-store',
  });

const ok = (body: unknown) => jsonResponse(200, body, { 'cache-control': 'no-store' });

export function createPublicApi(d: PublicApiDeps) {
  /** Key → tenant check → plan → scope → rate limit. Every failure before the plan check is the same 401. */
  async function authenticate(req: Request, ctx: TenantContext, scope: ApiScope): Promise<ApiKeyRecord | Response> {
    const m = KEY_RE.exec((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim());
    if (!m) return denied(401, 'unauthorized', 'Send an API key: Authorization: Bearer bck_…');
    const key = await d.keys.findActive(ctx.tenant.id, m[1]!);
    if (!key || !safeEqual(hashSecret(m[2]!), key.secretHash)) return denied(401, 'unauthorized', 'This API key is not valid for this site.');
    if (!ctx.can('api_access')) {
      const r = ctx.flags.api_access;
      return fail(403, 'feature_locked', r.locked ? 'API access is not included in the current plan.' : 'API access is turned off for this site.', { feature: 'api_access', upgradeable: r.locked }, { 'cache-control': 'no-store' });
    }
    if (!key.scopes.includes(scope)) return denied(403, 'insufficient_scope', `This key can't read that. It needs the "${scope}" scope.`, { scope });
    const rl = await limited(d.limit, `api:${ctx.tenant.id}:${key.keyId}`);
    if (rl) return rl;
    const now = d.now();
    if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) > TOUCH_EVERY_MS) await d.keys.touch(ctx.tenant.id, key.id, now);
    return key;
  }

  const leadDto = (l: LeadRecord) => ({
    id: l.id,
    email: l.email,
    name: l.name ?? null,
    company: l.company ?? null,
    phone: l.phone ?? null,
    marketingOptIn: l.marketingOptIn,
    consent: l.consent ?? null,
    sources: l.sources,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  });

  /** GET v1/leads?limit=1..100&cursor=&source= — newest first, keyset-paginated. */
  async function listLeads(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await authenticate(req, ctx, 'leads:read');
    if (a instanceof Response) return a;
    const p = new URL(req.url).searchParams;
    const limit = Number(p.get('limit') ?? '50');
    const cursor = p.get('cursor') ?? '';
    const source = p.get('source') ?? '';
    const problems: string[] = [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) problems.push('limit must be 1 to 100');
    if (cursor && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) problems.push('cursor is not one this API returned');
    if (source && !SOURCES.includes(source as LeadSource)) problems.push(`source must be one of ${SOURCES.join(', ')}`);
    if (problems.length) return fail(400, 'invalid_query', 'Invalid query.', { details: problems });
    const page = await d.leads.list(ctx.tenant.id, { limit, ...(cursor ? { cursor } : {}), ...(source ? { source: source as LeadSource } : {}) });
    return ok({ data: page.items.map(leadDto), nextCursor: page.nextCursor });
  }

  /** GET v1/leads/:id — the lead and its history (captures, quotes, CRM routing). */
  async function getLead(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await authenticate(req, ctx, 'leads:read');
    if (a instanceof Response) return a;
    const lead = UUID.test(id) ? await d.leads.get(ctx.tenant.id, id) : null;
    if (!lead) return fail(404, 'not_found', 'Lead not found.');
    const events = await d.leads.events(ctx.tenant.id, id);
    return ok({
      data: {
        ...leadDto(lead),
        events: events.sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((e) => ({ kind: e.kind, at: e.createdAt, details: e.payload })),
      },
    });
  }

  /**
   * GET v1/products?qty=144 — the catalog with estimated SELLING prices at a quantity, exactly as
   * the storefront shows them. Costs and margins are never exposed.
   */
  async function listProducts(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await authenticate(req, ctx, 'catalog:read');
    if (a instanceof Response) return a;
    const raw = new URL(req.url).searchParams.get('qty') ?? '144';
    const quantity = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!(quantity >= 1)) return fail(400, 'invalid_query', 'Invalid query.', { details: ['qty must be a whole number from 1 to 999999'] });
    const products = await d.products.list(ctx.tenant.id);
    const bySlug = new Map(products.map((p) => [p.slug, p]));
    const res = searchCatalog(products, { quantity, logo: { colorCount: 1, isPhotographic: false }, entitledMethods: ctx.methods, sort: 'recommended' }, ctx.tenant.pricingConfig);
    return ok({
      data: res.items.map((i) => {
        const p = bySlug.get(i.slug)!;
        return {
          slug: i.slug,
          name: i.name,
          brand: i.brand,
          category: i.category,
          isEco: i.isEco,
          colors: p.colors.map((c) => ({ name: c.name, hex: c.hex })),
          decorations: p.methods.filter((m) => ctx.methods.includes(m.method)).map((m) => ({ method: m.method, location: m.location, imprint: { widthIn: m.w, heightIn: m.h } })),
          estimate: { quantity: res.quantity, method: i.recommended.method, location: i.recommended.location, unitCents: i.recommended.unit, totalCents: i.recommended.total, oneColorLogo: true },
        };
      }),
      estimated: true,
      disclaimer: disclaimerFor(ctx.tenant.pricingConfig),
    });
  }

  /** GET v1/analytics?days=7|30|90|365 — the dashboard's numbers (ADR 0014). */
  async function analytics(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await authenticate(req, ctx, 'analytics:read');
    if (a instanceof Response) return a;
    if (!ctx.can('analytics_dashboard')) return fail(403, 'feature_locked', 'Analytics is not included in the current plan.', { feature: 'analytics_dashboard', upgradeable: ctx.flags.analytics_dashboard.locked });
    const asked = Number(new URL(req.url).searchParams.get('days') ?? '30');
    if (!(RANGE_DAYS as readonly number[]).includes(asked)) return fail(400, 'invalid_query', 'Invalid query.', { details: [`days must be one of ${RANGE_DAYS.join(', ')}`] });
    const range = dayRange(d.now(), asked);
    const [counts, links] = await Promise.all([d.analytics.counts(ctx.tenant.id, range.from, range.to), d.analytics.listLinks(ctx.tenant.id)]);
    return ok({ data: summarize(counts, links, range), timezone: 'UTC' });
  }

  return { listLeads, getLead, listProducts, analytics };
}

export type PublicApi = ReturnType<typeof createPublicApi>;
