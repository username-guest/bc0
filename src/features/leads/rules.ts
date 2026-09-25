/**
 * Lead capture rules (Phase 7). Pure functions: validation, bot screening, and the gate decision
 * shared by the catalog (what to show as locked) and the proof endpoint (what to refuse), so the
 * UI and the server can never disagree about what's gated.
 */

export type GateMode = 'off' | 'soft' | 'hard';

export interface LeadSettings {
  /** off: no prompt · soft: optional "email me my proofs" · hard: proofs for N products, then email */
  gate: { mode: GateMode; freeProducts: number };
  /**
   * `mock` = leads stay in the BrandCanvas inbox only. `webhook` = also POSTed to the tenant's URL;
   * the signing secret is stored sealed (secret-box, bound to the tenant id), never in plaintext.
   */
  routing: { provider: 'mock' } | { provider: 'webhook'; url: string; secretSealed: string };
  /** Shown to prospects so they know who will contact them. */
  contactName?: string;
}

export const DEFAULT_LEAD_SETTINGS: LeadSettings = {
  gate: { mode: 'soft', freeProducts: 3 },
  routing: { provider: 'mock' },
};

/** Versioned so each stored consent records exactly what the prospect agreed to. */
export const CONSENT_TEXT_VERSION = 'marketing-optin-v1';
export const CONSENT_TEXT = 'Send me occasional offers and product news. I can unsubscribe at any time.';

/* ------------------------------ validation ------------------------------ */

const EMAIL = /^[^\s@"<>()[\]\\,;:]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Whole address lower-cased. RFC 5321 allows case-sensitive local parts, but real mailboxes
 * don't use them and CRMs dedupe case-insensitively — "Pat@x.com" and "pat@x.com" must be ONE
 * lead (and the (tenant, email) unique index relies on this canonical form).
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim();
  if (e.length > 254 || !EMAIL.test(e)) return null;
  return e.toLowerCase();
}

function text(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  // Strip control characters (keeps CRM payloads and email headers clean), collapse whitespace.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  const t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : null;
}

export interface BotSignals {
  honeypot?: unknown; // hidden "website" field: humans leave it empty
  startedAt?: unknown; // ms epoch when the form was shown
}

/** True when the submission looks automated. Callers respond as if successful but store nothing. */
export function looksAutomated(b: BotSignals, now = Date.now(), minFillMs = 1500): boolean {
  if (typeof b.honeypot === 'string' && b.honeypot.trim() !== '') return true;
  const started = typeof b.startedAt === 'number' ? b.startedAt : Number(b.startedAt);
  if (!Number.isFinite(started)) return true;
  const elapsed = now - started;
  return elapsed < minFillMs || elapsed > 1000 * 60 * 60 * 24; // too fast, or a replayed stale form
}

export interface EmailGateInput {
  email: string;
  marketingOptIn: boolean;
}

export interface QuoteInput extends EmailGateInput {
  name: string;
  company: string;
  phone: string;
  notes: string;
  product: string;
  color: string;
  method: string;
  location: string;
  quantity: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export function validateEmailGate(body: Record<string, unknown>): Validation<EmailGateInput> {
  const email = normalizeEmail(body.email);
  if (!email) return { ok: false, errors: { email: 'Enter a valid email address.' } };
  // Consent must be an explicit `true`; anything else (missing, "on", 1) is NOT consent.
  return { ok: true, value: { email, marketingOptIn: body.marketingOptIn === true } };
}

export function validateQuote(body: Record<string, unknown>): Validation<QuoteInput> {
  const errors: Record<string, string> = {};
  const email = normalizeEmail(body.email);
  if (!email) errors.email = 'Enter a valid email address.';
  const name = text(body.name, 120);
  if (!name) errors.name = 'Enter your name.';
  const company = text(body.company, 160);
  if (company === null) errors.company = 'Company name is too long.';
  const phone = text(body.phone, 40);
  if (phone === null || (phone && !/^[+()\d][\d\s().-]{5,}$/.test(phone))) errors.phone = 'Enter a valid phone number or leave it blank.';
  const notes = text(body.notes, 2000);
  if (notes === null) errors.notes = 'Notes are too long (2000 characters max).';
  const quantity = typeof body.quantity === 'number' ? body.quantity : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) errors.quantity = 'Enter a quantity from 1 to 100000.';
  for (const k of ['product', 'color', 'method', 'location'] as const) {
    if (typeof body[k] !== 'string' || !body[k]) errors[k] = `Missing ${k}.`;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      email: email!,
      marketingOptIn: body.marketingOptIn === true,
      name: name!,
      company: company!,
      phone: phone!,
      notes: notes!,
      product: body.product as string,
      color: (body.color as string).toUpperCase(),
      method: body.method as string,
      location: body.location as string,
      quantity,
    },
  };
}

/* ------------------------------ gate ------------------------------ */

export interface GateState {
  mode: GateMode;
  freeProducts: number;
  hasLead: boolean;
  seenProducts: readonly string[];
}

/**
 * May this session see a proof for `product`? In hard mode, a session without a lead may see
 * proofs for up to `freeProducts` distinct products; products it has already seen stay visible.
 */
export function proofAllowed(g: GateState, product: string): boolean {
  if (g.mode !== 'hard' || g.hasLead) return true;
  return g.seenProducts.includes(product) || g.seenProducts.length < g.freeProducts;
}

/**
 * Which products in a listing are locked for this session: walk the list in display order,
 * granting remaining allowance to unseen products. Mirrors proofAllowed exactly.
 */
export function lockedProducts(g: GateState, productsInOrder: readonly string[]): Set<string> {
  const locked = new Set<string>();
  if (g.mode !== 'hard' || g.hasLead) return locked;
  let remaining = Math.max(0, g.freeProducts - g.seenProducts.length);
  for (const p of productsInOrder) {
    if (g.seenProducts.includes(p)) continue;
    if (remaining > 0) remaining--;
    else locked.add(p);
  }
  return locked;
}

/** End a sentence after a name without doubling punctuation ("Demo Promo Co." + "." → one period). */
export function endSentence(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}
