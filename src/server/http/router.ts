/**
 * Tenant API routing: /api/t/:ref/<path>. Shared by the Next.js catch-all route and the offline
 * dev server so both hosts expose exactly the same surface.
 */
import type { TenantDirectory } from '@/server/tenancy/context';
import { loadTenantContext } from '@/server/tenancy/context';
import { jsonResponse, type TenantApi } from './api';
import type { AdminApi } from './admin-api';
import type { PublicApi } from './public-api';
import type { TenantContext } from '@/server/tenancy/context';

const notFound = () => jsonResponse(404, { error: { code: 'not_found', message: 'Not found.' } });
const methodNotAllowed = (allow: string) =>
  jsonResponse(405, { error: { code: 'method_not_allowed', message: `Use ${allow}.` } }, { allow });

export async function handleTenantApi(
  req: Request,
  ref: string,
  path: readonly string[],
  deps: { api: TenantApi; directory: TenantDirectory; admin?: AdminApi; publicApi?: PublicApi },
): Promise<Response> {
  const ctx = await loadTenantContext(ref, deps.directory);
  // Same 404 for unknown tenants and unknown routes: don't reveal which tenant slugs exist.
  if (!ctx) return notFound();
  if (path[0] === 'admin') return deps.admin ? routeAdmin(req, ctx, path.slice(1), deps.admin) : notFound();
  if (path[0] === 'v1') return deps.publicApi ? routePublic(req, ctx, path.slice(1), deps.publicApi) : notFound();
  const [a, b, c, ...extra] = path;
  if (extra.length) return notFound();

  if (a === 'logos' && b === undefined) return req.method === 'POST' ? deps.api.uploadLogo(req, ctx) : methodNotAllowed('POST');
  if (a === 'logos' && b && c === 'clean.png') return req.method === 'GET' ? deps.api.logoImage(req, ctx, b) : methodNotAllowed('GET');
  if (a === 'logos' && b && c === 'confirm') return req.method === 'POST' ? deps.api.confirmLogo(req, ctx, b) : methodNotAllowed('POST');
  if (a === 'leads' && c === undefined) {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    if (b === 'email') return deps.api.captureEmail(req, ctx);
    if (b === 'quote') return deps.api.requestQuote(req, ctx);
    if (b === 'leave-behind') return deps.api.leaveBehind(req, ctx);
    return notFound();
  }
  if (b !== undefined) return notFound();
  if (a === 'session') return req.method === 'GET' ? deps.api.session(req, ctx) : methodNotAllowed('GET');
  if (a === 'visit') return req.method === 'POST' ? deps.api.visit(req, ctx) : methodNotAllowed('POST');
  if (a === 'catalog') return req.method === 'GET' ? deps.api.catalog(req, ctx) : methodNotAllowed('GET');
  if (a === 'proofs') return req.method === 'GET' ? deps.api.proof(req, ctx) : methodNotAllowed('GET');
  if (a === 'config') return req.method === 'GET' ? deps.api.config(req, ctx) : methodNotAllowed('GET');
  return notFound();
}

function routeAdmin(req: Request, ctx: TenantContext, p: readonly string[], admin: AdminApi): Promise<Response> | Response {
  const m = req.method;
  const is = (...segs: string[]) => p.length === segs.length && segs.every((s, i) => s === '*' || s === p[i]);
  const only = (method: string, fn: () => Promise<Response>) => (m === method ? fn() : methodNotAllowed(method));
  if (is('sign-in')) return only('POST', () => admin.signIn(req, ctx));
  if (is('verify')) return only('POST', () => admin.verify(req, ctx));
  if (is('sign-out')) return only('POST', () => admin.signOut(req, ctx));
  if (is('me')) return only('GET', () => admin.me(req, ctx));
  if (is('leads.csv')) return only('GET', () => admin.exportCsv(req, ctx));
  if (is('leads')) return only('GET', () => admin.listLeads(req, ctx));
  if (is('leads', '*')) return only('GET', () => admin.leadDetail(req, ctx, p[1]!));
  if (is('deliveries', '*', 'retry')) return only('POST', () => admin.retryDelivery(req, ctx, p[1]!));
  if (is('settings')) return only('GET', () => admin.getSettings(req, ctx));
  if (is('settings', 'branding')) return only('PUT', () => admin.putBranding(req, ctx));
  if (is('settings', 'gate')) return only('PUT', () => admin.putGate(req, ctx));
  if (is('settings', 'routing')) return only('PUT', () => admin.putRouting(req, ctx));
  if (is('settings', 'routing', 'test')) return only('POST', () => admin.testRouting(req, ctx));
  if (is('settings', 'pricing')) return m === 'PUT' ? admin.putPricing(req, ctx) : only('GET', () => admin.getPricing(req, ctx));
  if (is('settings', 'pricing', 'preview')) return only('POST', () => admin.previewPricing(req, ctx));
  if (is('features')) {
    if (m === 'GET') return admin.getFeatures(req, ctx);
    if (m === 'PUT') return admin.putFeatures(req, ctx);
    return methodNotAllowed('GET, PUT');
  }
  if (is('links')) {
    if (m === 'GET') return admin.listLinks(req, ctx);
    if (m === 'POST') return admin.createLink(req, ctx);
    return methodNotAllowed('GET, POST');
  }
  if (is('links', '*')) return only('PUT', () => admin.updateLink(req, ctx, p[1]!));
  if (is('analytics')) return only('GET', () => admin.analyticsSummary(req, ctx));
  if (is('api-keys')) {
    if (m === 'GET') return admin.listApiKeys(req, ctx);
    if (m === 'POST') return admin.createApiKey(req, ctx);
    return methodNotAllowed('GET, POST');
  }
  if (is('api-keys', '*', 'revoke')) return only('POST', () => admin.revokeApiKey(req, ctx, p[1]!));
  if (is('suppliers')) {
    if (m === 'GET') return admin.listSuppliers(req, ctx);
    if (m === 'POST') return admin.createSupplier(req, ctx);
    return methodNotAllowed('GET, POST');
  }
  if (is('suppliers', '*')) {
    if (m === 'PUT') return admin.updateSupplier(req, ctx, p[1]!);
    if (m === 'DELETE') return admin.deleteSupplier(req, ctx, p[1]!);
    return methodNotAllowed('PUT, DELETE');
  }
  if (is('suppliers', '*', 'sync')) return only('POST', () => admin.syncSupplier(req, ctx, p[1]!));
  if (is('team')) return only('GET', () => admin.listTeam(req, ctx));
  if (is('team', 'invite')) return only('POST', () => admin.invite(req, ctx));
  if (is('team', '*', 'resend')) return only('POST', () => admin.resendInvite(req, ctx, p[1]!));
  if (is('team', '*')) {
    if (m === 'PUT') return admin.changeRole(req, ctx, p[1]!);
    if (m === 'DELETE') return admin.removeMember(req, ctx, p[1]!);
    return methodNotAllowed('PUT, DELETE');
  }
  return notFound();
}

/** Public API v1 (ADR 0016): read-only, so everything is GET. */
function routePublic(req: Request, ctx: TenantContext, p: readonly string[], api: PublicApi): Promise<Response> | Response {
  const get = (fn: () => Promise<Response>) => (req.method === 'GET' ? fn() : methodNotAllowed('GET'));
  if (p.length === 1 && p[0] === 'leads') return get(() => api.listLeads(req, ctx));
  if (p.length === 2 && p[0] === 'leads') return get(() => api.getLead(req, ctx, p[1]!));
  if (p.length === 1 && p[0] === 'products') return get(() => api.listProducts(req, ctx));
  if (p.length === 1 && p[0] === 'analytics') return get(() => api.analytics(req, ctx));
  return notFound();
}
