/**
 * Anonymous prospect sessions (Phase 7). A prospect never logs in, but lead gating must be
 * enforced on the server (§17: never gate client-side only), so each browser gets a random
 * session id in an HMAC-signed, HttpOnly cookie that points at server-side state.
 *
 * - The id is 128 random bits; the HMAC stops clients injecting ids of their choosing.
 * - State is bound to ONE tenant. In path mode all tenants share the apex cookie, so a session
 *   presented to a different tenant is treated as absent (a fresh session is issued).
 * - Clearing cookies resets the proof allowance. That's acceptable: the gate is a lead-capture
 *   prompt, not DRM; render rate limits bound abuse.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'bc_ps';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

export interface ProspectSession {
  id: string;
  tenantId: string;
  leadId?: string;
  email?: string;
  /** First tracked link this session arrived through (ADR 0014); never overwritten. */
  linkId?: string;
  /** Products whose proofs this session has been shown (drives the hard gate). */
  proofProducts: string[];
  createdAt: string;
}

export interface SessionStore {
  /** Tenant-scoped (RLS in Postgres): a session is only ever found under its own tenant. */
  get(tenantId: string, id: string): Promise<ProspectSession | null>;
  save(s: ProspectSession): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly m = new Map<string, { s: ProspectSession; at: number }>();
  async get(tenantId: string, id: string): Promise<ProspectSession | null> {
    const e = this.m.get(id);
    if (!e || e.s.tenantId !== tenantId || Date.now() - e.at > SESSION_TTL_SEC * 1000) return null;
    return structuredClone(e.s);
  }
  async save(s: ProspectSession): Promise<void> {
    this.m.set(s.id, { s: structuredClone(s), at: Date.now() });
    if (this.m.size > 100_000) {
      for (const [k, v] of this.m) if (Date.now() - v.at > SESSION_TTL_SEC * 1000) this.m.delete(k);
    }
  }
}

const ID = /^[A-Za-z0-9_-]{22}$/;

function mac(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url').slice(0, 32);
}

export function newSessionId(): string {
  return randomBytes(16).toString('base64url'); // 22 chars
}

export function signSessionId(id: string, secret: string): string {
  return `${id}.${mac(id, secret)}`;
}

/** Returns the session id if the cookie value is well-formed and correctly signed. */
export function verifySessionCookie(value: string | undefined, secret: string): string | null {
  if (!value) return null;
  const [id, sig, extra] = value.split('.');
  if (extra !== undefined || !id || !sig || !ID.test(id)) return null;
  const want = Buffer.from(mac(id, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookieHeader(id: string, secret: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(signSessionId(id, secret))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Load the caller's session for this tenant, or create one. `isNew` tells the caller to set the
 * cookie on the response. Sessions belonging to another tenant are never reused.
 */
export async function loadOrCreateSession(
  req: Request,
  tenantId: string,
  store: SessionStore,
  secret: string,
): Promise<{ session: ProspectSession; isNew: boolean }> {
  const id = verifySessionCookie(readCookie(req.headers.get('cookie'), SESSION_COOKIE), secret);
  if (id) {
    const s = await store.get(tenantId, id);
    if (s) return { session: s, isNew: false };
  }
  return {
    session: { id: newSessionId(), tenantId, proofProducts: [], createdAt: new Date().toISOString() },
    isNew: true,
  };
}
