/**
 * Repository contracts. EVERY method takes tenantId — there is no unscoped read path.
 * Postgres implementations run inside withTenant() (RLS is the real boundary); the in-memory
 * implementations enforce the same scoping so tests exercise the same contract.
 */
import type { DecorationMethodKey } from '@/pricing/types';
import type { PaletteColor } from '@/imaging/palette';
import type { BgConfidence } from '@/imaging/background';
import type { SniffedType } from '@/features/logo-intake/intake';
import type { CatalogProduct } from '@/features/catalog/catalog';

export interface LogoRecord {
  id: string;
  tenantId: string;
  hash: string;
  knockoutEnclosed: boolean;
  sourceType: SniffedType;
  isVector: boolean;
  sourceSize: { width: number; height: number };
  originalKey: string;
  cleanKey: string;
  palette: { colors: PaletteColor[]; colorCount: number; isPhotographic: boolean };
  background: { removed: boolean; confidence: BgConfidence; reason: string; enclosedRegions: number };
  recommendedMethods: DecorationMethodKey[];
  warnings: string[];
  needsReview: boolean;
  createdAt: string;
}

export interface LogoRepo {
  create(rec: LogoRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<LogoRecord | null>;
  findByHash(tenantId: string, hash: string, knockoutEnclosed: boolean): Promise<LogoRecord | null>;
  update(tenantId: string, id: string, patch: Pick<LogoRecord, 'needsReview' | 'warnings'>): Promise<LogoRecord | null>;
}

export interface ProductRepo {
  list(tenantId: string): Promise<CatalogProduct[]>;
  get(tenantId: string, slug: string): Promise<CatalogProduct | null>;
}

export type LeadSource = 'email_gate' | 'quote_request' | 'pdf_leavebehind';

export interface LeadRecord {
  id: string;
  tenantId: string;
  email: string;
  name?: string;
  company?: string;
  phone?: string;
  marketingOptIn: boolean;
  /** Present when the prospect opted in: which consent text, and when. */
  consent?: { version: string; at: string };
  sources: LeadSource[];
  createdAt: string;
  updatedAt: string;
}

export type LeadEventKind = 'captured' | 'quote_requested' | 'leave_behind' | 'routed' | 'routing_failed';

export interface LeadEvent {
  id: string;
  tenantId: string;
  leadId: string;
  kind: LeadEventKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface LeadUpsert {
  email: string;
  source: LeadSource;
  marketingOptIn: boolean;
  consentVersion: string;
  name?: string;
  company?: string;
  phone?: string;
}

export interface LeadRepo {
  /**
   * One lead per (tenant, email). Contact fields are filled/updated when provided. Consent only
   * ever UPGRADES here: an unticked box on a later form is not a withdrawal (that's unsubscribe).
   */
  upsertByEmail(tenantId: string, input: LeadUpsert, now: Date): Promise<{ lead: LeadRecord; created: boolean }>;
  get(tenantId: string, id: string): Promise<LeadRecord | null>;
  addEvent(e: LeadEvent): Promise<void>;
  events(tenantId: string, leadId: string): Promise<LeadEvent[]>;
  /** Newest first, keyset-paginated (stable while new leads arrive). Admin inbox + CSV export. */
  list(tenantId: string, q: LeadListQuery): Promise<{ items: LeadRecord[]; nextCursor: string | null }>;
}

export interface LeadListQuery {
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  /** Case-insensitive substring of email, name or company. */
  search?: string;
  source?: LeadSource;
  /** Restrict to these lead ids (e.g. leads with failed deliveries). */
  ids?: string[];
}

export function encodeLeadCursor(l: { createdAt: string; id: string }): string {
  return Buffer.from(`${l.createdAt}|${l.id}`).toString('base64url');
}
export function decodeLeadCursor(c: string): { createdAt: string; id: string } | null {
  const [createdAt, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

/* ---------------------------------------------------------------------------
 * Lead delivery outbox (ADR 0008). One row per capture: the exact payload sent to the tenant's
 * CRM, its attempt count and when to try next. Events stay as the human-readable audit trail.
 * ------------------------------------------------------------------------- */

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';
export interface DeliveryBrief {
  status: DeliveryStatus;
  routedTo?: string;
}

export interface LeadDelivery {
  id: string;
  tenantId: string;
  leadId: string;
  source: LeadSource;
  /** The LeadPayload as first built; re-sent verbatim on retry. */
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  /** When the next attempt is due (pending/failed), or null once delivered/dead. */
  nextAttemptAt: string | null;
  lastError?: string;
  routedTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRepo {
  create(d: LeadDelivery): Promise<void>;
  get(tenantId: string, id: string): Promise<LeadDelivery | null>;
  update(tenantId: string, id: string, patch: Partial<Omit<LeadDelivery, 'id' | 'tenantId' | 'leadId'>>): Promise<void>;
  /**
   * Atomically claim up to `limit` deliveries that are due (`pending`/`failed`, next attempt
   * <= now), pushing their next attempt to `leaseUntil` so a concurrent worker skips them.
   */
  claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number): Promise<LeadDelivery[]>;
  forLead(tenantId: string, leadId: string): Promise<LeadDelivery[]>;
  /** Delivery status (and destination, once delivered) per lead, for inbox badges. */
  statusesFor(tenantId: string, leadIds: string[]): Promise<Record<string, DeliveryBrief[]>>;
  /** Leads with at least one delivery in these statuses (bounded). */
  leadIdsWithStatus(tenantId: string, statuses: DeliveryStatus[], limit: number): Promise<string[]>;
}

/* ---------------------------------------------------------------------------
 * Tracked links and funnel analytics (ADR 0014).
 * ------------------------------------------------------------------------- */

export const LINK_CHANNELS = ['email', 'print', 'social', 'event', 'other'] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];

export interface TrackedLink {
  id: string;
  tenantId: string;
  /** Short, URL-safe, unique per tenant; appears as ?src=<code>. */
  code: string;
  label: string;
  channel: LinkChannel;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export type FunnelStage = 'visit' | 'proof' | 'lead';

export interface FunnelEvent {
  tenantId: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  sessionId: string;
  kind: FunnelStage;
  linkId: string | null;
}

/** Counts of (session, day) rows per stage, grouped two ways. */
export interface FunnelCounts {
  byDay: { day: string; kind: FunnelStage; count: number }[];
  byLink: { linkId: string | null; kind: FunnelStage; count: number }[];
}

export interface AnalyticsRepo {
  /** Newest first. Archived links are included so historic counts keep their names. */
  listLinks(tenantId: string): Promise<TrackedLink[]>;
  getLink(tenantId: string, id: string): Promise<TrackedLink | null>;
  /** Active (not archived) link with this code, or null. */
  findActiveLinkByCode(tenantId: string, code: string): Promise<TrackedLink | null>;
  countActiveLinks(tenantId: string): Promise<number>;
  /** Returns false when the code is already taken in this tenant (caller retries with a new one). */
  createLink(l: TrackedLink): Promise<boolean>;
  updateLink(tenantId: string, id: string, patch: { label?: string; channel?: LinkChannel; archivedAt?: string | null }): Promise<TrackedLink | null>;
  /** Idempotent: a second event for the same session, stage and day is ignored. */
  record(e: FunnelEvent): Promise<void>;
  /** Inclusive day range (YYYY-MM-DD). */
  counts(tenantId: string, fromDay: string, toDay: string): Promise<FunnelCounts>;
  /** Maintenance: delete events on days before `beforeDay`. Returns rows removed. */
  sweep(tenantId: string, beforeDay: string): Promise<number>;
}

/* ---------------------------------------------------------------------------
 * Proof pre-rendering queue (ADR 0015), backed by mockup_jobs.
 * ------------------------------------------------------------------------- */

export type ProofJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ProofJob {
  id: string;
  tenantId: string;
  logoId: string;
  productSlug: string;
  colorHex: string;
  method: DecorationMethodKey;
  location: string;
  /** The proof's content-addressed cache key: one job per key per tenant. */
  cacheKey: string;
  status: ProofJobStatus;
  attempts: number;
  /** Due time while queued; lease expiry while running. */
  runAfter: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProofJobOutcome =
  | { status: 'done' }
  | { status: 'failed'; error: string }
  | { status: 'queued'; error: string; runAfter: Date };

export interface ProofJobRepo {
  /** Insert jobs, skipping any whose cache key is already queued for the tenant. Returns how many were added. */
  enqueue(tenantId: string, jobs: ProofJob[]): Promise<number>;
  /** Jobs still to do (queued or running). */
  pendingCount(tenantId: string): Promise<number>;
  /**
   * Atomically claim up to `limit` jobs that are due (queued, or running with an expired lease),
   * oldest first: they become `running` with a lease until `leaseUntil`, attempts + 1.
   */
  claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number): Promise<ProofJob[]>;
  finish(tenantId: string, id: string, outcome: ProofJobOutcome, now: Date): Promise<void>;
  list(tenantId: string): Promise<ProofJob[]>;
  /** Maintenance: delete done and failed jobs last updated before `before`. */
  sweep(tenantId: string, before: Date): Promise<number>;
}

/* ---------------------------------------------------------------------------
 * Public API keys (ADR 0016).
 * ------------------------------------------------------------------------- */

export const API_SCOPES = ['leads:read', 'catalog:read', 'analytics:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  /** Public part of the key, used to look it up. */
  keyId: string;
  name: string;
  /** SHA-256 (hex) of the secret part. The secret itself is never stored. */
  secretHash: string;
  scopes: ApiScope[];
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyRepo {
  /** Newest first, revoked included (so the admin can see what was cut off and when). */
  list(tenantId: string): Promise<ApiKeyRecord[]>;
  create(k: ApiKeyRecord): Promise<void>;
  /** Active (not revoked) key with this public id, or null. */
  findActive(tenantId: string, keyId: string): Promise<ApiKeyRecord | null>;
  countActive(tenantId: string): Promise<number>;
  /** Returns the key if it was active and is now revoked; null if unknown or already revoked. */
  revoke(tenantId: string, id: string, at: Date): Promise<ApiKeyRecord | null>;
  touch(tenantId: string, id: string, at: Date): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * Supplier connections + imported products (ADR 0017).
 * ------------------------------------------------------------------------- */

export type SupplierSyncStatus = 'never' | 'queued' | 'running' | 'ok' | 'partial' | 'failed';

export interface SupplierSyncSummary {
  at: string;
  created: number;
  updated: number;
  hidden: number;
  skipped: number;
  failed: number;
  remaining: number;
  /** Error when the whole run failed (unreachable, bad credentials). */
  error?: string;
  /** What was left out and why; capped so one row can't grow without bound. */
  notes: string[];
}

export interface SupplierConnectionRecord {
  id: string;
  tenantId: string;
  name: string;
  productDataUrl: string;
  pricingUrl: string;
  accountId: string;
  /** SecretBox-sealed (ADR 0008), bound to the tenant. Never returned by the admin API. */
  passwordSealed: string;
  currency: string;
  priceType: 'Net' | 'List';
  fobId: string | null;
  /** Import only these supplier product ids; empty = everything sellable (up to the cap). */
  productIds: string[];
  status: SupplierSyncStatus;
  /** When the current queued/running state began, so a crashed worker's lock can expire. */
  statusAt: string | null;
  lastSync: SupplierSyncSummary | null;
  createdAt: string;
}

export type SupplierConnectionPatch = Partial<
  Pick<SupplierConnectionRecord, 'name' | 'productDataUrl' | 'pricingUrl' | 'accountId' | 'passwordSealed' | 'currency' | 'priceType' | 'fobId' | 'productIds'>
>;

export interface SupplierRepo {
  list(tenantId: string): Promise<SupplierConnectionRecord[]>;
  get(tenantId: string, id: string): Promise<SupplierConnectionRecord | null>;
  create(c: SupplierConnectionRecord): Promise<void>;
  update(tenantId: string, id: string, patch: SupplierConnectionPatch): Promise<SupplierConnectionRecord | null>;
  /** Hides the connection's products, then deletes it. Returns false if it didn't exist. */
  remove(tenantId: string, id: string): Promise<boolean>;
  /**
   * Atomically move to `to` only from one of `from` (or from a queued/running state older than
   * `staleBefore`). The lock that stops two workers syncing one connection at once.
   */
  transition(tenantId: string, id: string, from: SupplierSyncStatus[], to: SupplierSyncStatus, at: Date, staleBefore?: Date): Promise<boolean>;
  finish(tenantId: string, id: string, status: 'ok' | 'partial' | 'failed', summary: SupplierSyncSummary): Promise<void>;
  /**
   * This tenant's connections the worker should run: queued, or last synced before
   * `refreshBefore` (the daily refresh), or stuck queued/running since before `staleBefore`.
   */
  due(tenantId: string, refreshBefore: Date, staleBefore: Date): Promise<string[]>;
}

/** What a sync writes into the catalog. */
export interface SupplierImportItem {
  supplierProductId: string;
  product: CatalogProduct;
}

export interface SupplierCatalogWriter {
  /**
   * Upsert these products for the connection (keyed by supplier product id), replacing their
   * colours and decoration rows. When `hideMissing`, the connection's other products are hidden
   * (never deleted: leads and proofs may reference them), except ids in `keep` (failed this run).
   */
  applySupplierImport(
    tenantId: string,
    connectionId: string,
    items: SupplierImportItem[],
    opts: { hideMissing: boolean; keep: string[] },
  ): Promise<{ created: number; updated: number; hidden: number }>;
}
