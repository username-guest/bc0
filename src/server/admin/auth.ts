/**
 * Admin sign-in primitives (ADR 0008): passwordless magic links + server-side sessions.
 *
 * - Secrets (link tokens, session tokens) are 256-bit random values; the database stores only
 *   their SHA-256, so a leaked table can't be replayed.
 * - Sessions are tenant-scoped: the cookie name includes the tenant, and the lookup runs under
 *   that tenant's RLS context, so a session for tenant A is simply absent for tenant B.
 * - Every state-changing admin request needs the session's CSRF token in `x-csrf-token`, and
 *   cross-site requests (Sec-Fetch-Site: cross-site) are refused outright, including sign-in and
 *   verify (login CSRF).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
export const ADMIN_SESSION_TTL_MS = 12 * 3_600_000;

export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Well-formed secret: 43 base64url chars (32 bytes). Rejects junk before touching the DB. */
export const isSecretShape = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

export function adminCookieName(tenantId: string): string {
  return `bc_admin_${tenantId.replace(/-/g, '').slice(0, 12)}`;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function adminCookieHeader(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Browsers label every request; refuse anything explicitly cross-site. */
export function isCrossSite(req: Request): boolean {
  return req.headers.get('sec-fetch-site') === 'cross-site';
}
