/**
 * Drizzle schema — a REPRESENTATIVE SUBSET of the §10 data model, chosen to establish the pattern
 * end-to-end (tenancy, RLS target columns, reference vs. tenant-scoped tables, the pricing + mockup
 * + lead seams). Remaining entities follow the identical shape and are additive.
 *
 * Conventions:
 *  - Every TENANT-SCOPED table carries `tenantId` (uuid, not null) and is RLS-protected
 *    (see db/policies/0001_enable_rls.sql). RLS — not app-layer filtering — is the isolation boundary.
 *  - GLOBAL REFERENCE tables (plans, feature_flags, color_families, decoration_methods) have NO
 *    tenantId and are readable by all tenants; only platform_admin writes them.
 *  - Money is integer cents (see src/pricing/types.ts).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ----------------------------------------------------------------------------
 * GLOBAL REFERENCE TABLES (no tenantId; not RLS-scoped)
 * ------------------------------------------------------------------------- */

export const plans = pgTable('plans', {
  key: text('key').primaryKey(), // 'free' | 'starter' | 'pro' | 'enterprise'
  label: text('label').notNull(),
  rank: integer('rank').notNull(),
});

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  default: boolean('default').notNull(),
  killSwitchable: boolean('kill_switchable').notNull(),
  minPlan: text('min_plan')
    .notNull()
    .references(() => plans.key),
  /** Global kill-switch — the highest-precedence override (§6). Platform-admin only. */
  globalKill: boolean('global_kill').notNull().default(false),
});

export const colorFamilies = pgTable('color_families', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  anchorHex: text('anchor_hex').notNull(),
});

export const decorationMethods = pgTable('decoration_methods', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  defaultMoq: integer('default_moq').notNull(),
  meta: jsonb('meta').notNull(), // constraints + traits (see domain/decoration-methods.ts)
});

/* ----------------------------------------------------------------------------
 * TENANT ROOT + CONFIG
 * ------------------------------------------------------------------------- */

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(), // subdomain (acme) / path fallback (/t/acme)
  name: text('name').notNull(),
  planKey: text('plan_key')
    .notNull()
    .references(() => plans.key)
    .default('free'),
  customDomain: text('custom_domain'), // behind a flag
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantBranding = pgTable('tenant_branding', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Storefront name; null → tenants.name. Editable by tenant admins (tenants itself is read-only to the app). */
  displayName: text('display_name'),
  logoAssetId: uuid('logo_asset_id'),
  primaryHex: text('primary_hex').notNull().default('#1F45C6'),
  secondaryHex: text('secondary_hex').notNull().default('#111827'),
  fontFamily: text('font_family').notNull().default('Inter'),
  faviconUrl: text('favicon_url'),
});

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Full TenantPricingConfig (src/pricing/types.ts) as JSON — admin-editable. */
  pricingConfig: jsonb('pricing_config').notNull(),
  leadRouting: jsonb('lead_routing').notNull(), // LeadSettings: { gate, routing, contactName }
});

/** Per-tenant / per-role flag overrides (§6 precedence chain). */
export const featureOverrides = pgTable(
  'feature_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    flagKey: text('flag_key')
      .notNull()
      .references(() => featureFlags.key),
    scope: text('scope').notNull(), // 'tenant' | 'role:tenant_admin' | 'user:<id>'
    enabled: boolean('enabled').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.flagKey, t.scope] }) }),
);

/* ----------------------------------------------------------------------------
 * IDENTITY
 * ------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('tenant_admin'), // tenant_admin | tenant_owner
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who invited them (ADR 0011). Null for seeded / CLI-created accounts. No FK: history survives removal. */
    invitedBy: uuid('invited_by'),
    /** Null until their first sign-in: the team list shows them as invited. */
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  },
  (t) => ({
    byTenant: index('users_tenant_idx').on(t.tenantId),
    // Sign-in is per tenant (ADR 0008): one account per (tenant, lower-cased email).
    uniqEmail: uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
  }),
);

/**
 * Admin sign-in (ADR 0008). Magic-link tokens and sessions store only a SHA-256 of the secret the
 * browser holds, so a database read never yields a usable link or session.
 */
export const adminLoginTokens = pgTable(
  'admin_login_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byHash: uniqueIndex('admin_login_tokens_hash_uq').on(t.tenantId, t.tokenHash) }),
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({ byHash: uniqueIndex('admin_sessions_hash_uq').on(t.tenantId, t.tokenHash) }),
);

/* ----------------------------------------------------------------------------
 * ASSETS + CATALOG (tenant-scoped)
 * ------------------------------------------------------------------------- */

export const logoAssets = pgTable(
  'logo_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(), // original upload
    cleanKey: text('clean_key').notNull(), // background-removed, trimmed PNG
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    isVector: boolean('is_vector').notNull().default(false),
    knockoutEnclosed: boolean('knockout_enclosed').notNull().default(false),
    /** { colors, colorCount, isPhotographic } from extractPalette */
    palette: jsonb('palette').notNull(),
    /** { removed, confidence, reason, enclosedRegions } */
    background: jsonb('background').notNull(),
    analysis: jsonb('analysis').notNull(), // { sourceSize, recommendedMethods, warnings }
    needsReview: boolean('needs_review').notNull().default(false),
    hash: text('hash').notNull(), // sha256 of upload; render cache key component
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('logo_assets_tenant_idx').on(t.tenantId),
    byHash: index('logo_assets_hash_idx').on(t.tenantId, t.hash),
  }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    template: text('template').notNull(), // render template kind (tee, polo, cap, ...)
    name: text('name').notNull(),
    category: text('category').notNull(),
    brand: text('brand'),
    isApparel: boolean('is_apparel').notNull().default(false),
    isHardGood: boolean('is_hard_good').notNull().default(false),
    isPolyester: boolean('is_polyester').notNull().default(false),
    isEco: boolean('is_eco').notNull().default(false),
    moq: integer('moq').notNull().default(12),
    /** QuantityBreak[] (src/pricing/types.ts): [{minQty, blankUnitCost}] */
    breaks: jsonb('breaks').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when imported from a supplier (ADR 0017); null for seeded / hand-entered products. */
    supplierConnectionId: uuid('supplier_connection_id').references(() => supplierConnections.id, { onDelete: 'set null' }),
    supplierProductId: text('supplier_product_id'),
    /** Hidden products stay for leads and proofs that reference them, but aren't listed. */
    active: boolean('active').notNull().default(true),
  },
  (t) => ({
    byTenant: index('products_tenant_idx').on(t.tenantId),
    byCategory: index('products_category_idx').on(t.tenantId, t.category),
    // One row per supplier product per connection, so re-syncs update in place.
    uniqSupplier: uniqueIndex('products_supplier_uq').on(t.tenantId, t.supplierConnectionId, t.supplierProductId),
    // Natural key → makes the seed (and CSV import) idempotent.
    uniqName: uniqueIndex('products_tenant_name_uq').on(t.tenantId, t.name),
    uniqSlug: uniqueIndex('products_tenant_slug_uq').on(t.tenantId, t.slug),
  }),
);

export const productColors = pgTable(
  'product_colors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // e.g. 'Royal Blue'
    hex: text('hex').notNull(),
    familyKey: text('family_key')
      .notNull()
      .references(() => colorFamilies.key),
    isDark: boolean('is_dark').notNull().default(false),
  },
  (t) => ({
    byProduct: index('product_colors_product_idx').on(t.productId),
    uniq: uniqueIndex('product_colors_product_name_uq').on(t.productId, t.name),
  }),
);

/** Which methods a product supports, with per-location imprint geometry (§10). */
export const decorationCompatibility = pgTable(
  'decoration_compatibility',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    methodKey: text('method_key')
      .notNull()
      .references(() => decorationMethods.key),
    location: text('location').notNull(), // 'left_chest', 'full_front', ...
    imprintWidthIn: real('imprint_width_in').notNull(),
    imprintHeightIn: real('imprint_height_in').notNull(),
  },
  (t) => ({
    byProduct: index('decoration_compat_product_idx').on(t.productId),
    uniq: uniqueIndex('decoration_compat_uq').on(t.productId, t.methodKey, t.location),
  }),
);

/* ----------------------------------------------------------------------------
 * MOCKUP PIPELINE + LEADS (tenant-scoped)
 * ------------------------------------------------------------------------- */

export const mockupJobs = pgTable(
  'mockup_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    logoAssetId: uuid('logo_asset_id')
      .notNull()
      .references(() => logoAssets.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** The configuration to render (ADR 0015): product slug, garment colour, method, location. */
    productSlug: text('product_slug'),
    colorHex: text('color_hex'),
    method: text('method').notNull(),
    location: text('location'),
    mode: text('mode').notNull().default('brand_exact'), // brand_exact | ai_lifestyle
    status: text('status').notNull().default('queued'), // queued | running | done | failed
    zone: jsonb('zone'), // detected/overridden ImprintZone
    cacheKey: text('cache_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** When a queued job is due, or when a running job's lease expires. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('mockup_jobs_tenant_idx').on(t.tenantId),
    // One job per proof: re-uploading a logo, or two uploads racing, never queues a render twice.
    uniqCache: uniqueIndex('mockup_jobs_tenant_cache_uq').on(t.tenantId, t.cacheKey),
    byDue: index('mockup_jobs_due_idx').on(t.tenantId, t.status, t.runAfter),
  }),
);

export const renderedProofs = pgTable(
  'rendered_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => mockupJobs.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    watermarked: boolean('watermarked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byTenant: index('rendered_proofs_tenant_idx').on(t.tenantId) }),
);

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
    company: text('company'),
    phone: text('phone'),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    /** { version, at } — which consent text the prospect accepted, and when. */
    consent: jsonb('consent'),
    sources: jsonb('sources').notNull().default('[]'), // LeadSource[]
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('leads_tenant_idx').on(t.tenantId),
    uniqEmail: uniqueIndex('leads_tenant_email_uq').on(t.tenantId, t.email),
  }),
);

/**
 * Tracked links (ADR 0014): a short code per source ("Spring trade show", "Dana's emails").
 * A storefront URL carrying ?src=<code> attributes that visitor's session to the link.
 */
export const trackedLinks = pgTable(
  'tracked_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    label: text('label').notNull(),
    channel: text('channel').notNull(), // email | print | social | event | other
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('tracked_links_tenant_idx').on(t.tenantId),
    uniqCode: uniqueIndex('tracked_links_tenant_code_uq').on(t.tenantId, t.code),
  }),
);

/**
 * API keys (ADR 0016). The key is `bck_<keyId>_<secret>`: keyId is public and looked up, only a
 * SHA-256 of the secret is stored. Scopes limit what a key can read.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    name: text('name').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: jsonb('scopes').notNull(), // ApiScope[]
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byTenant: index('api_keys_tenant_idx').on(t.tenantId),
    uniqKey: uniqueIndex('api_keys_tenant_key_uq').on(t.tenantId, t.keyId),
  }),
);

/**
 * PromoStandards supplier connections (ADR 0017). The password is SecretBox-sealed with the tenant
 * bound in (ADR 0008). `status`/`status_at` double as the sync lock.
 */
export const supplierConnections = pgTable(
  'supplier_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    productDataUrl: text('product_data_url').notNull(),
    pricingUrl: text('pricing_url').notNull(),
    accountId: text('account_id').notNull(),
    passwordSealed: text('password_sealed').notNull(),
    currency: text('currency').notNull().default('USD'),
    priceType: text('price_type').notNull().default('Net'), // 'Net' | 'List'
    fobId: text('fob_id'),
    productIds: jsonb('product_ids').notNull().default([]), // string[]
    status: text('status').notNull().default('never'), // SupplierSyncStatus
    statusAt: timestamp('status_at', { withTimezone: true }),
    lastSync: jsonb('last_sync'), // SupplierSyncSummary | null
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('supplier_connections_tenant_idx').on(t.tenantId),
    uniqName: uniqueIndex('supplier_connections_tenant_name_uq').on(t.tenantId, t.name),
  }),
);

/** Anonymous prospect sessions (lead gate state). Keyed by the random id in the signed cookie. */
export const prospectSessions = pgTable(
  'prospect_sessions',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    email: text('email'),
    /** First tracked link this session arrived through (ADR 0014). */
    linkId: uuid('link_id').references(() => trackedLinks.id, { onDelete: 'set null' }),
    proofProducts: jsonb('proof_products').notNull().default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byTenant: index('prospect_sessions_tenant_idx').on(t.tenantId) }),
);

export const leadEvents = pgTable(
  'lead_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // captured | quote_requested | leave_behind | routed | routing_failed
    payload: jsonb('payload').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byTenant: index('lead_events_tenant_idx').on(t.tenantId) }),
);

/**
 * Funnel events (ADR 0014): at most one row per session, stage and UTC day, so refreshing a page
 * never inflates a count. No IP, user agent or contact details: only the random session id.
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(), // visit | proof | lead
    linkId: uuid('link_id').references(() => trackedLinks.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.day, t.sessionId, t.kind] }),
    byTenantDay: index('analytics_events_tenant_day_idx').on(t.tenantId, t.day),
  }),
);

/** CRM delivery outbox (ADR 0008): one row per capture, retried with backoff until delivered or dead. */
export const leadDeliveries = pgTable(
  'lead_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending | delivered | failed | dead
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    routedTo: text('routed_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byLead: index('lead_deliveries_lead_idx').on(t.tenantId, t.leadId),
    due: index('lead_deliveries_due_idx').on(t.tenantId, t.status, t.nextAttemptAt),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(), // user id or 'system'
    action: text('action').notNull(),
    target: text('target'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byTenant: index('audit_log_tenant_idx').on(t.tenantId) }),
);

/**
 * Shared rate-limit windows (ADR 0010). Global, not tenant-scoped: keys already carry the tenant
 * id, and the app role needs one atomic upsert per hit across all tenants. Only a SHA-256 of the
 * key is stored, because keys can contain client IP addresses.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    keyHash: text('key_hash').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => ({ byWindow: index('rate_limits_window_idx').on(t.windowStart) }),
);

/** Tenant-scoped tables that MUST have RLS enabled+forced (asserted by drizzle/0001 + rls.test.ts). */
export const TENANT_SCOPED_TABLES = [
  'tenant_branding',
  'tenant_settings',
  'feature_overrides',
  'users',
  'logo_assets',
  'products',
  'product_colors',
  'decoration_compatibility',
  'mockup_jobs',
  'rendered_proofs',
  'leads',
  'lead_events',
  'lead_deliveries',
  'prospect_sessions',
  'tracked_links',
  'analytics_events',
  'api_keys',
  'supplier_connections',
  'audit_log',
  'admin_login_tokens',
  'admin_sessions',
] as const;
