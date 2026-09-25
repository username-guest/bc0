/**
 * Tenant resolution (§2, Phase 9). Pure: host + path in, tenant reference out.
 *
 *   acme.brandcanvas.app/catalog        → slug "acme"      (subdomain)
 *   brandcanvas.app/t/acme/catalog      → slug "acme"      (path fallback; also localhost)
 *   promo.acme-corp.com/catalog         → domain lookup    (custom domain, Enterprise flag)
 *   brandcanvas.app/pricing             → platform (no tenant)
 *
 * The result carries an INTERNAL ref used in the rewritten URL: a slug, or "@<host>" for a
 * custom domain. The server re-validates the ref and looks the tenant up; nothing here trusts
 * the request beyond parsing it.
 */
export type TenantRef =
  | { kind: 'subdomain' | 'path'; slug: string; rest: string }
  | { kind: 'custom_domain'; domain: string; rest: string };

export type Resolution = { tenant: TenantRef } | { platform: true; rest: string } | { invalid: string };

/** Subdomains that belong to the platform itself and can never be claimed by a tenant. */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'api', 'admin', 'static', 'assets', 'cdn', 'mail', 'status', 'docs', 'help', 't',
]);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export function isValidSlug(s: string): boolean {
  return SLUG.test(s) && !RESERVED_SUBDOMAINS.has(s);
}

function normaliseHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // IPv6 literal, drop port
  return h.replace(/:\d+$/, '');
}

function pathTenant(pathname: string): Resolution {
  const m = /^\/t\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return { platform: true, rest: pathname || '/' };
  const slug = decodeURIComponent(m[1]!).toLowerCase();
  if (!isValidSlug(slug)) return { invalid: `Invalid tenant slug "${m[1]}"` };
  return { tenant: { kind: 'path', slug, rest: m[2] ?? '/' } };
}

export function resolveTenant(hostHeader: string | null, pathname: string, baseDomain: string): Resolution {
  const base = baseDomain.toLowerCase();
  if (!hostHeader) return { invalid: 'Missing Host header' };
  const host = normaliseHost(hostHeader);

  if (LOCAL_HOSTS.has(host) || host === base || host === `www.${base}`) return pathTenant(pathname);

  if (host.endsWith(`.${base}`)) {
    const sub = host.slice(0, -(base.length + 1));
    if (sub.includes('.')) return { invalid: 'Nested subdomains are not tenants' };
    if (RESERVED_SUBDOMAINS.has(sub)) return pathTenant(pathname);
    if (!SLUG.test(sub)) return { invalid: `Invalid tenant subdomain "${sub}"` };
    return { tenant: { kind: 'subdomain', slug: sub, rest: pathname || '/' } };
  }

  if (!HOSTNAME.test(host)) return { invalid: 'Unrecognised host' };
  return { tenant: { kind: 'custom_domain', domain: host, rest: pathname || '/' } };
}

/** Internal ref placed in rewritten URLs: slug, or "@host" for custom domains. */
export function toInternalRef(t: TenantRef): string {
  return t.kind === 'custom_domain' ? `@${t.domain}` : t.slug;
}

export type ParsedRef = { slug: string } | { domain: string } | null;

export function parseInternalRef(ref: string): ParsedRef {
  const r = decodeURIComponent(ref).toLowerCase();
  if (r.startsWith('@')) return HOSTNAME.test(r.slice(1)) ? { domain: r.slice(1) } : null;
  return isValidSlug(r) ? { slug: r } : null;
}

/** Path the app should serve for a request (what middleware rewrites to). */
export function rewritePath(t: TenantRef): string {
  const ref = encodeURIComponent(toInternalRef(t));
  if (t.rest.startsWith('/api/')) return `/api/t/${ref}${t.rest.slice(4)}`;
  if (t.kind === 'path') return `/t/${ref}${t.rest === '/' ? '' : t.rest}`;
  return `/t/${ref}${t.rest === '/' ? '' : t.rest}`;
}

export type RoutingDecision =
  | { action: 'next' }
  | { action: 'rewrite'; to: string }
  | { action: 'reject'; status: 400 | 404; message: string };

/**
 * The whole middleware decision, as a pure function (unit-tested; Next middleware and the dev
 * server both call it).
 *
 * One URL scheme everywhere: the API always answers at /api/t/<ref>/…, and tenant pages live at
 * /t/<ref>/…. On a tenant's own host (subdomain or custom domain):
 *   - /api/t/<ref>/… passes through ONLY if <ref> is that same tenant — a page on acme's host
 *     can never be used to reach another tenant's API;
 *   - /t/… is refused (no reaching other tenants' pages via path mode on a tenant host);
 *   - everything else is rewritten into the internal routes.
 */
export function planRouting(hostHeader: string | null, pathname: string, baseDomain: string): RoutingDecision {
  const r = resolveTenant(hostHeader, pathname, baseDomain);
  if ('invalid' in r) return { action: 'reject', status: 400, message: r.invalid };
  if ('platform' in r || r.tenant.kind === 'path') return { action: 'next' };

  const t = r.tenant;
  const ref = toInternalRef(t);
  if (t.rest.startsWith('/api/t/')) {
    const seg = t.rest.split('/')[3] ?? '';
    let decoded = '';
    try {
      decoded = decodeURIComponent(seg).toLowerCase();
    } catch {
      /* malformed escape → reject below */
    }
    return decoded === ref ? { action: 'next' } : { action: 'reject', status: 404, message: 'Not found.' };
  }
  if (t.rest === '/t' || t.rest.startsWith('/t/')) return { action: 'reject', status: 404, message: 'Not found.' };
  return { action: 'rewrite', to: rewritePath(t) };
}
