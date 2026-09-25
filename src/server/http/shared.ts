/** HTTP helpers shared by the tenant API modules. */
import type { TenantContext } from '@/server/tenancy/context';
import type { RateLimiter } from '@/server/rate-limit';
import type { LogoRecord } from '@/server/repos/types';
import type { FlagSnapshot } from '@/flags/entitlements';
import type { IntakeErrorCode } from '@/features/logo-intake/intake';

/* ------------------------------ helpers ------------------------------ */

export type ErrorCode =
  | 'feature_locked'
  | 'rate_limited'
  | 'invalid_request'
  | 'invalid_query'
  | 'not_found'
  | 'logo_not_found'
  | 'product_not_found'
  | 'invalid_color'
  | 'unsupported_decoration'
  | 'incompatible_decoration'
  | 'needs_placement'
  | 'method_not_allowed'
  | 'lead_required'
  | 'invalid_body'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf_failed'
  | 'invalid_token'
  | 'team_full'
  | 'too_many_links'
  | 'insufficient_scope'
  | 'too_many_keys'
  | 'too_many_suppliers'
  | 'duplicate_name'
  | 'sync_in_progress'
  | 'try_again'
  | 'already_member'
  | 'already_active'
  | 'last_owner'
  | IntakeErrorCode;

/**
 * Response bodies must be ArrayBuffer-backed (TS ≥ 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>,
 * which may be a SharedArrayBuffer and is not a valid BodyInit). Storage adapters may hand back
 * either, so copy into a fresh ArrayBuffer-backed view.
 */
export function body(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function fail(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return jsonResponse(status, { error: { code, message, ...extra } }, headers);
}

export function locked(ctx: TenantContext, flag: keyof FlagSnapshot): Response | null {
  if (ctx.can(flag)) return null;
  const r = ctx.flags[flag];
  return fail(403, 'feature_locked', r.locked ? 'This feature is not included in the current plan.' : 'This feature is turned off for this site.', { feature: flag, upgradeable: r.locked });
}

export function clientIp(req: Request, trustProxy: boolean): string {
  // Client-supplied headers are only meaningful behind a proxy that overwrites them. Without one,
  // anyone could rotate X-Forwarded-For / X-Real-IP to dodge rate limits, so every request shares
  // one bucket instead (set TRUST_PROXY=true in any real deployment).
  if (!trustProxy) return 'direct';
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim().slice(0, 64);
  return req.headers.get('x-real-ip')?.slice(0, 64) ?? 'direct';
}

export async function limited(limiter: RateLimiter, key: string): Promise<Response | null> {
  const d = await limiter.hit(key);
  if (d.ok) return null;
  return fail(429, 'rate_limited', 'Too many requests — please wait a moment.', { retryAfterSec: d.retryAfterSec }, { 'retry-after': String(d.retryAfterSec) });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX = /^#[0-9a-f]{6}$/i;
export const SLUGISH = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const LOCATION = /^[a-z][a-z_]{0,39}$/;

export const INTAKE_STATUS: Record<IntakeErrorCode, number> = {
  empty: 400,
  too_large: 413,
  unsupported_type: 415,
  decoder_unavailable: 415,
  unsafe_svg: 422,
  decode_failed: 422,
  too_small: 422,
  blank_image: 422,
};

export const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg', pdf: 'pdf', unknown: 'bin' };
export const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', unknown: 'application/octet-stream' };

export function apiBase(ctx: TenantContext): string {
  return `/api/t/${encodeURIComponent(ctx.ref)}`;
}

/** Render-cache identity of a logo: the cleaned raster differs with the knockout choice. */
export function logoCacheId(rec: LogoRecord): string {
  return rec.knockoutEnclosed ? `${rec.hash}:k` : rec.hash;
}


/** Parse a small JSON object body. Returns null for wrong type, oversize, or malformed input. */
export async function readJsonObject(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  if (Number(req.headers.get('content-length') ?? '0') > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
