/**
 * Absolute admin URLs for emails (ADR 0008). Built from configuration only: the request's Host
 * header is attacker-controlled, and a sign-in link built from it could point at their server.
 *
 * - PUBLIC_BASE_URL set (dev, or a path-mode deploy) → `${base}/t/<slug>/admin/…`
 * - otherwise the tenant's own host: its custom domain while entitled, else `<slug>.<BASE_DOMAIN>`.
 */
import type { TenantContext } from '@/server/tenancy/context';

export function makeAdminUrl(opts: { publicBaseUrl?: string; baseDomain: string }) {
  const base = opts.publicBaseUrl?.replace(/\/+$/, '');
  return (ctx: TenantContext, path: string): string => {
    if (base) return `${base}/t/${encodeURIComponent(ctx.tenant.slug)}${path}`;
    const host = ctx.tenant.customDomain && ctx.can('custom_domain') ? ctx.tenant.customDomain : `${ctx.tenant.slug}.${opts.baseDomain}`;
    return `https://${host}${path}`;
  };
}

/**
 * Absolute public API URLs (ADR 0016), built from configuration for the same reason.
 *
 * - PUBLIC_BASE_URL set → `${base}/api/t/<slug>…`. Path-mode page URLs (`/t/<slug>/…`) are served
 *   by the storefront, so the API must use its internal path here.
 * - otherwise the tenant's own host → `https://<host>/api…`, which middleware rewrites.
 */
export function makeApiUrl(opts: { publicBaseUrl?: string; baseDomain: string }) {
  const base = opts.publicBaseUrl?.replace(/\/+$/, '');
  return (ctx: TenantContext, path: string): string => {
    if (base) return `${base}/api/t/${encodeURIComponent(ctx.tenant.slug)}${path}`;
    const host = ctx.tenant.customDomain && ctx.can('custom_domain') ? ctx.tenant.customDomain : `${ctx.tenant.slug}.${opts.baseDomain}`;
    return `https://${host}/api${path}`;
  };
}
