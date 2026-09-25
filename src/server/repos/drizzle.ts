/**
 * Postgres implementations of the repository contracts (DATA_MODE=postgres).
 * Tenant-scoped reads/writes run inside withTenant(), so RLS — not these WHERE clauses — is the
 * isolation boundary; the explicit tenant filters are defence in depth.
 * Requires a live database: verified by the CI `integration` job, not by the offline suites.
 */
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb, withTenant } from '@/core/db/tenant';
import type { RateWindowStore } from '@/server/rate-limit';
import * as s from '@/core/db/schema';
import type { TenantBranding, TenantDirectory, TenantRecord } from '@/server/tenancy/context';
import type { AdminAuthStore, AdminRole, AdminSession, AuditEntry, AuditRepo, TeamChange, TeamMember, TenantSettingsWriter } from '@/server/admin/types';
import type { CatalogProduct } from '@/features/catalog/catalog';
import type { SupplierCatalogWriter, SupplierConnectionPatch, SupplierConnectionRecord, SupplierImportItem, SupplierRepo, SupplierSyncStatus, SupplierSyncSummary, ApiKeyRecord, ApiKeyRepo, ApiScope, ProofJob, ProofJobOutcome, ProofJobRepo, AnalyticsRepo, FunnelCounts, FunnelEvent, FunnelStage, LinkChannel, TrackedLink, DeliveryBrief, DeliveryRepo, DeliveryStatus, LeadDelivery, LeadEvent, LeadListQuery, LeadRecord, LeadRepo, LeadUpsert, LeadSource, LogoRecord, LogoRepo, ProductRepo } from './types';
import { decodeLeadCursor, encodeLeadCursor } from './types';
import type { ProspectSession, SessionStore } from '@/server/session';
import { SESSION_TTL_SEC } from '@/server/session';
import type { DecorationMethodKey, QuantityBreak, TenantPricingConfig } from '@/pricing/types';
import type { Plan } from '@/flags/registry';
import type { TemplateKind } from '@/imaging/templates';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';
import { DEFAULT_LEAD_SETTINGS, type LeadSettings } from '@/features/leads/rules';
import { mapColorToFamily } from '@/core/domain/color-families';
import { importedIdentity } from '@/server/suppliers/identity';

/** tenant_settings.lead_routing holds LeadSettings; tolerate older/partial rows. */
function parseLeadSettings(v: unknown): LeadSettings {
  const o = (v ?? {}) as Partial<LeadSettings>;
  const gate = o.gate && ['off', 'soft', 'hard'].includes(o.gate.mode) ? o.gate : DEFAULT_LEAD_SETTINGS.gate;
  const routing =
    // Only sealed secrets are accepted (ADR 0008); anything else falls back to the inbox.
    o.routing?.provider === 'webhook' && typeof o.routing.url === 'string' && typeof o.routing.secretSealed === 'string'
      ? o.routing
      : DEFAULT_LEAD_SETTINGS.routing;
  return { gate, routing, ...(typeof o.contactName === 'string' ? { contactName: o.contactName } : {}) };
}

const TEMPLATE_KINDS: readonly TemplateKind[] = ['tee', 'polo', 'cap', 'tumbler', 'tote', 'journal'];

/** Tiny TTL cache: tenant config is read on every request but changes rarely. */
class Ttl<V> {
  private readonly m = new Map<string, { v: V; at: number }>();
  private readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  async get(k: string, load: () => Promise<V>): Promise<V> {
    const hit = this.m.get(k);
    if (hit && Date.now() - hit.at < this.ms) return hit.v;
    const v = await load();
    this.m.set(k, { v, at: Date.now() });
    return v;
  }
  clear() {
    this.m.clear();
  }
}

export class DrizzleTenantDirectory implements TenantDirectory, TenantSettingsWriter {
  private readonly cache = new Ttl<TenantRecord | null>(5_000);
  private readonly kills = new Ttl<ReadonlySet<string>>(15_000);

  findBySlug(slug: string) {
    return this.cache.get(`s:${slug}`, async () => {
      const row = (await getDb().select().from(s.tenants).where(eq(s.tenants.slug, slug)).limit(1))[0];
      return row ? this.hydrate(row) : null;
    });
  }

  findByDomain(domain: string) {
    return this.cache.get(`d:${domain}`, async () => {
      const row = (await getDb().select().from(s.tenants).where(eq(s.tenants.customDomain, domain)).limit(1))[0];
      return row ? this.hydrate(row) : null;
    });
  }

  async listSlugs() {
    const rows = await getDb().select({ slug: s.tenants.slug }).from(s.tenants);
    return rows.map((r) => r.slug);
  }

  globalKillSwitches() {
    return this.kills.get('k', async () => {
      const rows = await getDb().select({ key: s.featureFlags.key }).from(s.featureFlags).where(eq(s.featureFlags.globalKill, true));
      return new Set(rows.map((r) => r.key));
    });
  }

  /**
   * Settings writes go through the directory so it can drop its own cache. Other app instances
   * see the change within the cache TTL (5 s).
   */
  async updateBranding(tenantId: string, b: Omit<TenantBranding, 'logoUrl'>) {
    await withTenant(tenantId, (tx) =>
      tx
        .insert(s.tenantBranding)
        .values({ tenantId, displayName: b.displayName, primaryHex: b.primaryHex, secondaryHex: b.secondaryHex, fontFamily: b.fontFamily })
        .onConflictDoUpdate({
          target: s.tenantBranding.tenantId,
          set: { displayName: b.displayName, primaryHex: b.primaryHex, secondaryHex: b.secondaryHex, fontFamily: b.fontFamily },
        }),
    );
    this.cache.clear();
  }

  async updatePricingConfig(tenantId: string, c: TenantPricingConfig) {
    await withTenant(tenantId, (tx) =>
      tx
        .insert(s.tenantSettings)
        .values({ tenantId, pricingConfig: c, leadRouting: DEFAULT_LEAD_SETTINGS })
        .onConflictDoUpdate({ target: s.tenantSettings.tenantId, set: { pricingConfig: c } }),
    );
    this.cache.clear();
  }

  async updateLeadSettings(tenantId: string, ls: LeadSettings) {
    await withTenant(tenantId, (tx) =>
      tx
        .insert(s.tenantSettings)
        .values({ tenantId, pricingConfig: PLACEHOLDER_TENANT_CONFIG, leadRouting: ls })
        .onConflictDoUpdate({ target: s.tenantSettings.tenantId, set: { leadRouting: ls } }),
    );
    this.cache.clear();
  }

  async setFlagOverrides(tenantId: string, managed: readonly string[], overrides: Record<string, boolean>) {
    const O = s.featureOverrides;
    await withTenant(tenantId, async (tx) => {
      await tx.delete(O).where(and(eq(O.tenantId, tenantId), eq(O.scope, 'tenant'), inArray(O.flagKey, [...managed])));
      const rows = Object.entries(overrides)
        .filter(([k]) => managed.includes(k))
        .map(([flagKey, enabled]) => ({ tenantId, flagKey, scope: 'tenant', enabled }));
      if (rows.length) await tx.insert(O).values(rows);
    });
    this.cache.clear();
  }

  private hydrate(t: typeof s.tenants.$inferSelect): Promise<TenantRecord> {
    return withTenant(t.id, async (tx) => {
      const [branding] = await tx.select().from(s.tenantBranding).where(eq(s.tenantBranding.tenantId, t.id));
      const [settings] = await tx.select().from(s.tenantSettings).where(eq(s.tenantSettings.tenantId, t.id));
      const overrides = await tx
        .select()
        .from(s.featureOverrides)
        .where(and(eq(s.featureOverrides.tenantId, t.id), eq(s.featureOverrides.scope, 'tenant')));
      const rec: TenantRecord = {
        id: t.id,
        slug: t.slug,
        name: t.name,
        plan: t.planKey as Plan,
        branding: {
          displayName: branding?.displayName ?? t.name,
          primaryHex: branding?.primaryHex ?? '#1F45C6',
          secondaryHex: branding?.secondaryHex ?? '#111827',
          fontFamily: branding?.fontFamily ?? 'Inter',
        },
        pricingConfig: (settings?.pricingConfig as TenantPricingConfig | undefined) ?? PLACEHOLDER_TENANT_CONFIG,
        flagOverrides: Object.fromEntries(overrides.map((o) => [o.flagKey, o.enabled])),
        leads: parseLeadSettings(settings?.leadRouting),
      };
      if (t.customDomain) rec.customDomain = t.customDomain;
      return rec;
    });
  }
}

export class DrizzleProductRepo implements ProductRepo, SupplierCatalogWriter {
  async list(tenantId: string): Promise<CatalogProduct[]> {
    return withTenant(tenantId, async (tx) => {
      // Sequential on purpose: a transaction is ONE connection, and pg deprecates overlapping
      // queries on a client (removed in pg@9). These are small indexed reads.
      const prods = await tx.select().from(s.products).where(and(eq(s.products.tenantId, tenantId), eq(s.products.active, true)));
      const colors = await tx.select().from(s.productColors).where(eq(s.productColors.tenantId, tenantId));
      const compat = await tx.select().from(s.decorationCompatibility).where(eq(s.decorationCompatibility.tenantId, tenantId));
      return prods
        .filter((p) => (TEMPLATE_KINDS as readonly string[]).includes(p.template))
        .map((p) => {
          const breaks = p.breaks as QuantityBreak[];
          return {
            slug: p.slug,
            template: p.template as TemplateKind,
            name: p.name,
            category: p.category,
            brand: p.brand ?? '',
            traits: { isApparel: p.isApparel, isHardGood: p.isHardGood, isPolyester: p.isPolyester, isEco: p.isEco },
            blankBase: breaks[0]?.blankUnitCost ?? 0,
            breaks,
            colors: colors.filter((c) => c.productId === p.id).map((c) => ({ name: c.name, hex: c.hex, isDark: c.isDark })),
            methods: compat
              .filter((c) => c.productId === p.id)
              .map((c) => ({ method: c.methodKey as DecorationMethodKey, location: c.location, w: c.imprintWidthIn, h: c.imprintHeightIn })),
          };
        });
    });
  }

  async get(tenantId: string, slug: string): Promise<CatalogProduct | null> {
    return (await this.list(tenantId)).find((p) => p.slug === slug) ?? null;
  }

  /** ADR 0017: one transaction, under RLS, per sync. */
  async applySupplierImport(tenantId: string, connectionId: string, items: SupplierImportItem[], opts: { hideMissing: boolean; keep: string[] }) {
    return withTenant(tenantId, async (tx) => {
      // The connection must be visible to this tenant (RLS). A foreign key alone wouldn't catch
      // a foreign connection id: FK checks bypass RLS.
      const conn = await tx.select({ id: s.supplierConnections.id }).from(s.supplierConnections).where(and(eq(s.supplierConnections.tenantId, tenantId), eq(s.supplierConnections.id, connectionId))).limit(1);
      if (!conn.length) throw new Error('unknown supplier connection');
      const out = { created: 0, updated: 0, hidden: 0 };
      const all = await tx
        .select({ id: s.products.id, name: s.products.name, slug: s.products.slug, conn: s.products.supplierConnectionId, spid: s.products.supplierProductId })
        .from(s.products)
        .where(eq(s.products.tenantId, tenantId));
      for (const it of items) {
        const existing = all.find((r) => r.conn === connectionId && r.spid === it.supplierProductId);
        const others = all.filter((r) => r !== existing);
        const ident = importedIdentity(it.product.name, it.product.slug, it.supplierProductId, {
          names: new Set(others.map((r) => r.name.toLowerCase())),
          slugs: new Set(others.map((r) => r.slug)),
        });
        const p = it.product;
        const values = {
          slug: ident.slug,
          name: ident.name,
          template: p.template,
          category: p.category,
          brand: p.brand || null,
          isApparel: p.traits.isApparel ?? false,
          isHardGood: p.traits.isHardGood ?? false,
          isPolyester: p.traits.isPolyester ?? false,
          isEco: p.traits.isEco ?? false,
          moq: p.breaks?.[0]?.minQty ?? 1,
          breaks: p.breaks ?? [],
          active: true,
        };
        let productId: string;
        if (existing) {
          await tx.update(s.products).set(values).where(and(eq(s.products.tenantId, tenantId), eq(s.products.id, existing.id)));
          await tx.delete(s.productColors).where(and(eq(s.productColors.tenantId, tenantId), eq(s.productColors.productId, existing.id)));
          await tx.delete(s.decorationCompatibility).where(and(eq(s.decorationCompatibility.tenantId, tenantId), eq(s.decorationCompatibility.productId, existing.id)));
          productId = existing.id;
          existing.name = ident.name;
          existing.slug = ident.slug;
          out.updated++;
        } else {
          const rows = await tx
            .insert(s.products)
            .values({ tenantId, supplierConnectionId: connectionId, supplierProductId: it.supplierProductId, ...values })
            .returning({ id: s.products.id });
          productId = rows[0]!.id;
          all.push({ id: productId, name: ident.name, slug: ident.slug, conn: connectionId, spid: it.supplierProductId });
          out.created++;
        }
        if (p.colors.length) {
          await tx.insert(s.productColors).values(
            p.colors.map((c) => ({ tenantId, productId, name: c.name, hex: c.hex, familyKey: mapColorToFamily(c.hex), isDark: c.isDark ?? false })),
          );
        }
        if (p.methods.length) {
          await tx.insert(s.decorationCompatibility).values(
            p.methods.map((m) => ({ tenantId, productId, methodKey: m.method, location: m.location, imprintWidthIn: m.w, imprintHeightIn: m.h })),
          );
        }
      }
      if (opts.hideMissing) {
        const seen = [...new Set([...items.map((i) => i.supplierProductId), ...opts.keep])];
        const hidden = await tx
          .update(s.products)
          .set({ active: false })
          .where(
            and(
              eq(s.products.tenantId, tenantId),
              eq(s.products.supplierConnectionId, connectionId),
              eq(s.products.active, true),
              ...(seen.length ? [notInArray(s.products.supplierProductId, seen)] : []),
            ),
          )
          .returning({ id: s.products.id });
        out.hidden = hidden.length;
      }
      return out;
    });
  }
}

type SupplierRow = typeof s.supplierConnections.$inferSelect;

function toSupplier(r: SupplierRow): SupplierConnectionRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    productDataUrl: r.productDataUrl,
    pricingUrl: r.pricingUrl,
    accountId: r.accountId,
    passwordSealed: r.passwordSealed,
    currency: r.currency,
    priceType: r.priceType === 'List' ? 'List' : 'Net',
    fobId: r.fobId,
    productIds: Array.isArray(r.productIds) ? (r.productIds as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    status: r.status as SupplierSyncStatus,
    statusAt: r.statusAt ? r.statusAt.toISOString() : null,
    lastSync: (r.lastSync as SupplierSyncSummary | null) ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export class DrizzleSupplierRepo implements SupplierRepo {
  async list(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.supplierConnections).where(eq(s.supplierConnections.tenantId, tenantId)).orderBy(asc(s.supplierConnections.createdAt), asc(s.supplierConnections.id)),
    );
    return rows.map(toSupplier);
  }
  async get(tenantId: string, id: string) {
    const rows = await withTenant(tenantId, (tx) => tx.select().from(s.supplierConnections).where(and(eq(s.supplierConnections.tenantId, tenantId), eq(s.supplierConnections.id, id))).limit(1));
    return rows[0] ? toSupplier(rows[0]) : null;
  }
  async create(c: SupplierConnectionRecord) {
    await withTenant(c.tenantId, (tx) =>
      tx.insert(s.supplierConnections).values({
        id: c.id,
        tenantId: c.tenantId,
        name: c.name,
        productDataUrl: c.productDataUrl,
        pricingUrl: c.pricingUrl,
        accountId: c.accountId,
        passwordSealed: c.passwordSealed,
        currency: c.currency,
        priceType: c.priceType,
        fobId: c.fobId,
        productIds: c.productIds,
        status: c.status,
        createdAt: new Date(c.createdAt),
      }),
    );
  }
  async update(tenantId: string, id: string, patch: SupplierConnectionPatch) {
    if (!Object.keys(patch).length) return this.get(tenantId, id);
    const rows = await withTenant(tenantId, (tx) =>
      tx.update(s.supplierConnections).set(patch).where(and(eq(s.supplierConnections.tenantId, tenantId), eq(s.supplierConnections.id, id))).returning(),
    );
    return rows[0] ? toSupplier(rows[0]) : null;
  }
  async remove(tenantId: string, id: string) {
    return withTenant(tenantId, async (tx) => {
      // Hide first: once the connection row is gone its products are detached (FK set null).
      await tx.update(s.products).set({ active: false }).where(and(eq(s.products.tenantId, tenantId), eq(s.products.supplierConnectionId, id)));
      const rows = await tx.delete(s.supplierConnections).where(and(eq(s.supplierConnections.tenantId, tenantId), eq(s.supplierConnections.id, id))).returning({ id: s.supplierConnections.id });
      return rows.length > 0;
    });
  }
  async transition(tenantId: string, id: string, from: SupplierSyncStatus[], to: SupplierSyncStatus, at: Date, staleBefore?: Date) {
    const c = s.supplierConnections;
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .update(c)
        .set({ status: to, statusAt: at })
        .where(
          and(
            eq(c.tenantId, tenantId),
            eq(c.id, id),
            staleBefore
              ? or(inArray(c.status, from), and(inArray(c.status, ['queued', 'running']), lt(c.statusAt, staleBefore)))
              : inArray(c.status, from),
          ),
        )
        .returning({ id: c.id }),
    );
    return rows.length > 0;
  }
  async finish(tenantId: string, id: string, status: 'ok' | 'partial' | 'failed', summary: SupplierSyncSummary) {
    await withTenant(tenantId, (tx) =>
      tx.update(s.supplierConnections).set({ status, statusAt: null, lastSync: summary }).where(and(eq(s.supplierConnections.tenantId, tenantId), eq(s.supplierConnections.id, id))),
    );
  }
  async due(tenantId: string, refreshBefore: Date, staleBefore: Date) {
    const c = s.supplierConnections;
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select({ id: c.id })
        .from(c)
        .where(
          and(
            eq(c.tenantId, tenantId),
            or(
              eq(c.status, 'queued'),
              and(eq(c.status, 'running'), lt(c.statusAt, staleBefore)),
              and(inArray(c.status, ['ok', 'partial', 'failed']), sql`coalesce(${c.lastSync}->>'at', '') < ${refreshBefore.toISOString()}`),
            ),
          ),
        )
        .orderBy(asc(c.createdAt)),
    );
    return rows.map((r) => r.id);
  }
}

type LogoRow = typeof s.logoAssets.$inferSelect;

function toRecord(r: LogoRow): LogoRecord {
  const a = r.analysis as Pick<LogoRecord, 'sourceSize' | 'recommendedMethods' | 'warnings'> & { sourceType: LogoRecord['sourceType'] };
  return {
    id: r.id,
    tenantId: r.tenantId,
    hash: r.hash,
    knockoutEnclosed: r.knockoutEnclosed,
    sourceType: a.sourceType,
    isVector: r.isVector,
    sourceSize: a.sourceSize,
    originalKey: r.storageKey,
    cleanKey: r.cleanKey,
    palette: r.palette as LogoRecord['palette'],
    background: r.background as LogoRecord['background'],
    recommendedMethods: a.recommendedMethods,
    warnings: a.warnings,
    needsReview: r.needsReview,
    createdAt: r.createdAt.toISOString(),
  };
}

export class DrizzleLogoRepo implements LogoRepo {
  async create(rec: LogoRecord): Promise<void> {
    await withTenant(rec.tenantId, (tx) =>
      tx.insert(s.logoAssets).values({
        id: rec.id,
        tenantId: rec.tenantId,
        storageKey: rec.originalKey,
        cleanKey: rec.cleanKey,
        contentType: rec.sourceType,
        bytes: 0,
        isVector: rec.isVector,
        knockoutEnclosed: rec.knockoutEnclosed,
        palette: rec.palette,
        background: rec.background,
        analysis: { sourceType: rec.sourceType, sourceSize: rec.sourceSize, recommendedMethods: rec.recommendedMethods, warnings: rec.warnings },
        needsReview: rec.needsReview,
        hash: rec.hash,
      }),
    );
  }

  async get(tenantId: string, id: string): Promise<LogoRecord | null> {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.logoAssets).where(and(eq(s.logoAssets.tenantId, tenantId), eq(s.logoAssets.id, id))).limit(1),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(tenantId: string, id: string, patch: Pick<LogoRecord, 'needsReview' | 'warnings'>): Promise<LogoRecord | null> {
    return withTenant(tenantId, async (tx) => {
      const [row] = await tx.select().from(s.logoAssets).where(and(eq(s.logoAssets.tenantId, tenantId), eq(s.logoAssets.id, id))).limit(1);
      if (!row) return null;
      const analysis = { ...(row.analysis as Record<string, unknown>), warnings: patch.warnings };
      const [updated] = await tx
        .update(s.logoAssets)
        .set({ needsReview: patch.needsReview, analysis })
        .where(and(eq(s.logoAssets.tenantId, tenantId), eq(s.logoAssets.id, id)))
        .returning();
      return updated ? toRecord(updated) : null;
    });
  }

  async findByHash(tenantId: string, hash: string, knockout: boolean): Promise<LogoRecord | null> {
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(s.logoAssets)
        .where(and(eq(s.logoAssets.tenantId, tenantId), eq(s.logoAssets.hash, hash), eq(s.logoAssets.knockoutEnclosed, knockout)))
        .limit(1),
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

type LeadRow = typeof s.leads.$inferSelect;

function toLead(r: LeadRow): LeadRecord {
  const rec: LeadRecord = {
    id: r.id,
    tenantId: r.tenantId,
    email: r.email,
    marketingOptIn: r.marketingOptIn,
    sources: r.sources as LeadSource[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  if (r.name) rec.name = r.name;
  if (r.company) rec.company = r.company;
  if (r.phone) rec.phone = r.phone;
  if (r.consent) rec.consent = r.consent as LeadRecord['consent'] & object;
  return rec;
}

export class DrizzleLeadRepo implements LeadRepo {
  /**
   * Race-safe upsert on (tenant_id, email): two tabs submitting at once can't create two leads.
   * Consent only upgrades (false → true, stamping version + time); contact fields fill in.
   */
  async upsertByEmail(tenantId: string, input: LeadUpsert, now: Date) {
    return withTenant(tenantId, async (tx) => {
      const consent = input.marketingOptIn ? { version: input.consentVersion, at: now.toISOString() } : null;
      const [row] = await tx
        .insert(s.leads)
        .values({
          tenantId,
          email: input.email,
          name: input.name || null,
          company: input.company || null,
          phone: input.phone || null,
          marketingOptIn: input.marketingOptIn,
          consent,
          sources: [input.source],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [s.leads.tenantId, s.leads.email],
          set: {
            name: sql`coalesce(excluded.name, ${s.leads.name})`,
            company: sql`coalesce(excluded.company, ${s.leads.company})`,
            phone: sql`coalesce(excluded.phone, ${s.leads.phone})`,
            consent: sql`case when ${s.leads.marketingOptIn} then ${s.leads.consent} else excluded.consent end`,
            marketingOptIn: sql`${s.leads.marketingOptIn} or excluded.marketing_opt_in`,
            sources: sql`case when ${s.leads.sources} @> excluded.sources then ${s.leads.sources} else ${s.leads.sources} || excluded.sources end`,
            updatedAt: now,
          },
        })
        .returning();
      // On conflict created_at keeps its original value, so equality with `now` means inserted.
      return { lead: toLead(row!), created: row!.createdAt.getTime() === now.getTime() };
    });
  }

  async get(tenantId: string, id: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.leads).where(and(eq(s.leads.tenantId, tenantId), eq(s.leads.id, id))).limit(1),
    );
    return rows[0] ? toLead(rows[0]) : null;
  }

  async addEvent(e: LeadEvent) {
    await withTenant(e.tenantId, (tx) =>
      tx.insert(s.leadEvents).values({ id: e.id, tenantId: e.tenantId, leadId: e.leadId, kind: e.kind, payload: e.payload, createdAt: new Date(e.createdAt) }),
    );
  }

  async list(tenantId: string, q: LeadListQuery) {
    if (q.ids && q.ids.length === 0) return { items: [], nextCursor: null };
    const L = s.leads;
    const conds: SQL[] = [eq(L.tenantId, tenantId)];
    if (q.source) conds.push(sql`${L.sources} @> ${JSON.stringify([q.source])}::jsonb`);
    if (q.ids) conds.push(inArray(L.id, q.ids));
    if (q.search) {
      const pat = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(or(ilike(L.email, pat), ilike(L.name, pat), ilike(L.company, pat))!);
    }
    const after = q.cursor ? decodeLeadCursor(q.cursor) : null;
    if (after) {
      const at = new Date(after.createdAt);
      conds.push(or(lt(L.createdAt, at), and(eq(L.createdAt, at), lt(L.id, after.id)))!);
    }
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(L).where(and(...conds)).orderBy(desc(L.createdAt), desc(L.id)).limit(q.limit + 1),
    );
    const items = rows.slice(0, q.limit).map(toLead);
    return { items, nextCursor: rows.length > q.limit ? encodeLeadCursor(items[items.length - 1]!) : null };
  }

  async events(tenantId: string, leadId: string): Promise<LeadEvent[]> {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.leadEvents).where(and(eq(s.leadEvents.tenantId, tenantId), eq(s.leadEvents.leadId, leadId))),
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      leadId: r.leadId,
      kind: r.kind as LeadEvent['kind'],
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export class DrizzleSessionStore implements SessionStore {
  async get(tenantId: string, id: string): Promise<ProspectSession | null> {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.prospectSessions).where(and(eq(s.prospectSessions.tenantId, tenantId), eq(s.prospectSessions.id, id))).limit(1),
    );
    const r = rows[0];
    if (!r || Date.now() - r.updatedAt.getTime() > SESSION_TTL_SEC * 1000) return null;
    const out: ProspectSession = { id: r.id, tenantId: r.tenantId, proofProducts: r.proofProducts as string[], createdAt: r.createdAt.toISOString() };
    if (r.leadId) out.leadId = r.leadId;
    if (r.email) out.email = r.email;
    if (r.linkId) out.linkId = r.linkId;
    return out;
  }

  async save(x: ProspectSession): Promise<void> {
    const now = new Date();
    await withTenant(x.tenantId, (tx) =>
      tx
        .insert(s.prospectSessions)
        .values({ id: x.id, tenantId: x.tenantId, leadId: x.leadId ?? null, email: x.email ?? null, linkId: x.linkId ?? null, proofProducts: x.proofProducts, createdAt: new Date(x.createdAt), updatedAt: now })
        .onConflictDoUpdate({
          target: s.prospectSessions.id,
          set: { leadId: x.leadId ?? null, email: x.email ?? null, linkId: x.linkId ?? null, proofProducts: x.proofProducts, updatedAt: now },
        }),
    );
  }
}

type DeliveryRow = typeof s.leadDeliveries.$inferSelect;
const toDelivery = (r: DeliveryRow): LeadDelivery => ({
  id: r.id,
  tenantId: r.tenantId,
  leadId: r.leadId,
  source: r.source as LeadSource,
  payload: r.payload as Record<string, unknown>,
  status: r.status as LeadDelivery['status'],
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
  ...(r.lastError ? { lastError: r.lastError } : {}),
  ...(r.routedTo ? { routedTo: r.routedTo } : {}),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const d = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

export class DrizzleDeliveryRepo implements DeliveryRepo {
  async create(x: LeadDelivery) {
    await withTenant(x.tenantId, (tx) =>
      tx.insert(s.leadDeliveries).values({
        id: x.id,
        tenantId: x.tenantId,
        leadId: x.leadId,
        source: x.source,
        payload: x.payload,
        status: x.status,
        attempts: x.attempts,
        nextAttemptAt: d(x.nextAttemptAt),
        lastError: x.lastError ?? null,
        routedTo: x.routedTo ?? null,
        createdAt: new Date(x.createdAt),
        updatedAt: new Date(x.updatedAt),
      }),
    );
  }

  async get(tenantId: string, id: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.leadDeliveries).where(and(eq(s.leadDeliveries.tenantId, tenantId), eq(s.leadDeliveries.id, id))).limit(1),
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  async update(tenantId: string, id: string, p: Partial<LeadDelivery>) {
    const set: Partial<typeof s.leadDeliveries.$inferInsert> = {};
    if (p.status !== undefined) set.status = p.status;
    if (p.attempts !== undefined) set.attempts = p.attempts;
    if (p.nextAttemptAt !== undefined) set.nextAttemptAt = d(p.nextAttemptAt);
    if (p.lastError !== undefined) set.lastError = p.lastError;
    if (p.routedTo !== undefined) set.routedTo = p.routedTo;
    if (p.payload !== undefined) set.payload = p.payload;
    set.updatedAt = p.updatedAt ? new Date(p.updatedAt) : new Date();
    await withTenant(tenantId, (tx) =>
      tx.update(s.leadDeliveries).set(set).where(and(eq(s.leadDeliveries.tenantId, tenantId), eq(s.leadDeliveries.id, id))),
    );
  }

  /** SKIP LOCKED: concurrent workers take disjoint rows instead of queueing behind each other. */
  async claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number) {
    return withTenant(tenantId, async (tx) => {
      const due = await tx
        .select({ id: s.leadDeliveries.id })
        .from(s.leadDeliveries)
        .where(
          and(
            eq(s.leadDeliveries.tenantId, tenantId),
            inArray(s.leadDeliveries.status, ['pending', 'failed']),
            lte(s.leadDeliveries.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(s.leadDeliveries.nextAttemptAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const rows = await tx
        .update(s.leadDeliveries)
        .set({ nextAttemptAt: leaseUntil })
        .where(and(eq(s.leadDeliveries.tenantId, tenantId), inArray(s.leadDeliveries.id, due.map((r) => r.id))))
        .returning();
      return rows.map(toDelivery).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    });
  }

  async statusesFor(tenantId: string, leadIds: string[]) {
    if (leadIds.length === 0) return {};
    const D = s.leadDeliveries;
    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ leadId: D.leadId, status: D.status, routedTo: D.routedTo }).from(D).where(and(eq(D.tenantId, tenantId), inArray(D.leadId, leadIds))),
    );
    const out: Record<string, DeliveryBrief[]> = {};
    for (const r of rows) (out[r.leadId] ??= []).push({ status: r.status as DeliveryStatus, ...(r.routedTo ? { routedTo: r.routedTo } : {}) });
    return out;
  }

  async leadIdsWithStatus(tenantId: string, statuses: DeliveryStatus[], limit: number) {
    const D = s.leadDeliveries;
    const rows = await withTenant(tenantId, (tx) =>
      tx.selectDistinct({ leadId: D.leadId }).from(D).where(and(eq(D.tenantId, tenantId), inArray(D.status, statuses))).limit(limit),
    );
    return rows.map((r) => r.leadId);
  }

  async forLead(tenantId: string, leadId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(s.leadDeliveries)
        .where(and(eq(s.leadDeliveries.tenantId, tenantId), eq(s.leadDeliveries.leadId, leadId)))
        .orderBy(asc(s.leadDeliveries.createdAt)),
    );
    return rows.map(toDelivery);
  }
}

export class DrizzleAdminAuthStore implements AdminAuthStore {
  async findUserByEmail(tenantId: string, email: string) {
    const [u] = await withTenant(tenantId, (tx) =>
      tx.select().from(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.email, email))).limit(1),
    );
    return u ? { id: u.id, tenantId: u.tenantId, email: u.email, role: u.role as AdminRole } : null;
  }

  async getUser(tenantId: string, id: string) {
    const [u] = await withTenant(tenantId, (tx) =>
      tx.select().from(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.id, id))).limit(1),
    );
    return u ? { id: u.id, tenantId: u.tenantId, email: u.email, role: u.role as AdminRole } : null;
  }

  async createLoginToken(t: { id: string; tenantId: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date }) {
    await withTenant(t.tenantId, (tx) => tx.insert(s.adminLoginTokens).values(t));
  }

  /** One conditional UPDATE … RETURNING: two concurrent consumes can't both win. */
  async consumeLoginToken(tenantId: string, tokenHash: string, now: Date) {
    const T = s.adminLoginTokens;
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .update(T)
        .set({ usedAt: now })
        .where(and(eq(T.tenantId, tenantId), eq(T.tokenHash, tokenHash), isNull(T.usedAt), gt(T.expiresAt, now)))
        .returning({ userId: T.userId }),
    );
    return rows[0]?.userId ?? null;
  }

  async createSession(x: AdminSession & { tokenHash: string; createdAt: Date }) {
    await withTenant(x.tenantId, (tx) =>
      tx.insert(s.adminSessions).values({
        id: x.id,
        tenantId: x.tenantId,
        userId: x.userId,
        tokenHash: x.tokenHash,
        csrfToken: x.csrfToken,
        createdAt: x.createdAt,
        expiresAt: new Date(x.expiresAt),
      }),
    );
  }

  async findSession(tenantId: string, tokenHash: string, now: Date) {
    const S = s.adminSessions;
    const [r] = await withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(S)
        .where(and(eq(S.tenantId, tenantId), eq(S.tokenHash, tokenHash), isNull(S.revokedAt), gt(S.expiresAt, now)))
        .limit(1),
    );
    return r ? { id: r.id, tenantId: r.tenantId, userId: r.userId, csrfToken: r.csrfToken, expiresAt: r.expiresAt.toISOString() } : null;
  }

  async revokeSession(tenantId: string, id: string, now: Date) {
    await withTenant(tenantId, (tx) =>
      tx.update(s.adminSessions).set({ revokedAt: now }).where(and(eq(s.adminSessions.tenantId, tenantId), eq(s.adminSessions.id, id))),
    );
  }

  async sweep(tenantId: string, c: { tokensBefore: Date; sessionsBefore: Date }) {
    return withTenant(tenantId, async (tx) => {
      const tokens = await tx
        .delete(s.adminLoginTokens)
        .where(and(eq(s.adminLoginTokens.tenantId, tenantId), or(lt(s.adminLoginTokens.expiresAt, c.tokensBefore), lt(s.adminLoginTokens.usedAt, c.tokensBefore))))
        .returning({ id: s.adminLoginTokens.id });
      const sessions = await tx
        .delete(s.adminSessions)
        .where(and(eq(s.adminSessions.tenantId, tenantId), or(lt(s.adminSessions.expiresAt, c.sessionsBefore), lt(s.adminSessions.revokedAt, c.sessionsBefore))))
        .returning({ id: s.adminSessions.id });
      return { tokens: tokens.length, sessions: sessions.length };
    });
  }

  /* ------------------------------ team (ADR 0011) ------------------------------ */

  async listMembers(tenantId: string): Promise<TeamMember[]> {
    const rows = await withTenant(tenantId, (tx) => tx.select().from(s.users).where(eq(s.users.tenantId, tenantId)).orderBy(asc(s.users.createdAt), asc(s.users.email)));
    return rows.map((u) => ({
      id: u.id,
      tenantId: u.tenantId,
      email: u.email,
      role: u.role as AdminRole,
      createdAt: u.createdAt.toISOString(),
      lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
      invitedBy: u.invitedBy ?? null,
    }));
  }

  async addMember(m: { id: string; tenantId: string; email: string; role: AdminRole; invitedBy: string; createdAt: Date }) {
    const rows = await withTenant(m.tenantId, (tx) =>
      tx.insert(s.users).values(m).onConflictDoNothing({ target: [s.users.tenantId, s.users.email] }).returning({ id: s.users.id }),
    );
    return rows.length ? 'created' : 'exists';
  }

  /**
   * Locks the tenant's owner rows (in id order, so concurrent calls can't deadlock) before
   * deciding. Under READ COMMITTED a waiting transaction re-reads the locked rows once the first
   * commits, so it sees the owner that was just demoted or removed and refuses.
   */
  private async ownerSafe(tenantId: string, id: string, loses: (current: AdminRole) => boolean, write: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>): Promise<TeamChange> {
    return withTenant(tenantId, async (tx) => {
      const owners = await tx
        .select({ id: s.users.id })
        .from(s.users)
        .where(and(eq(s.users.tenantId, tenantId), eq(s.users.role, 'tenant_owner')))
        .orderBy(asc(s.users.id))
        .for('update');
      const [target] = await tx.select({ role: s.users.role }).from(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.id, id))).for('update');
      if (!target) return 'not_found';
      if (loses(target.role as AdminRole) && owners.length <= 1) return 'last_owner';
      await write(tx);
      return 'ok';
    });
  }

  changeRole(tenantId: string, id: string, role: AdminRole) {
    return this.ownerSafe(
      tenantId,
      id,
      (current) => current === 'tenant_owner' && role !== 'tenant_owner',
      (tx) => tx.update(s.users).set({ role }).where(and(eq(s.users.tenantId, tenantId), eq(s.users.id, id))),
    );
  }

  removeMember(tenantId: string, id: string) {
    return this.ownerSafe(
      tenantId,
      id,
      (current) => current === 'tenant_owner',
      (tx) => tx.delete(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.id, id))),
    );
  }

  async recordSignIn(tenantId: string, id: string, at: Date) {
    await withTenant(tenantId, (tx) => tx.update(s.users).set({ lastSignInAt: at }).where(and(eq(s.users.tenantId, tenantId), eq(s.users.id, id))));
  }
}

export class DrizzleAuditRepo implements AuditRepo {
  async record(e: AuditEntry) {
    await withTenant(e.tenantId, (tx) =>
      tx.insert(s.auditLog).values({ tenantId: e.tenantId, actor: e.actor, action: e.action, target: e.target ?? null, at: new Date(e.at) }),
    );
  }
  async recent(tenantId: string, limit: number) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.auditLog).where(eq(s.auditLog.tenantId, tenantId)).orderBy(desc(s.auditLog.at)).limit(limit),
    );
    return rows.map((r) => ({ tenantId: r.tenantId, actor: r.actor, action: r.action, ...(r.target ? { target: r.target } : {}), at: r.at.toISOString() }));
  }
}

/**
 * Shared rate-limit windows (ADR 0010): one atomic upsert per hit, so every app instance counts
 * against the same budget. In an UPDATE, every SET expression reads the row's OLD values, so the
 * reset test is the same for both columns.
 */
export class DrizzleRateWindowStore implements RateWindowStore {
  async bump(key: string, windowMs: number, now: number) {
    const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
    const at = new Date(now).toISOString();
    const expired = sql`${s.rateLimits.windowStart} <= ${at}::timestamptz - (${windowMs}::double precision * interval '1 millisecond')`;
    const rows = await getDb()
      .insert(s.rateLimits)
      .values({ keyHash, windowStart: new Date(now), count: 1 })
      .onConflictDoUpdate({
        target: s.rateLimits.keyHash,
        set: {
          count: sql`case when ${expired} then 1 else ${s.rateLimits.count} + 1 end`,
          windowStart: sql`case when ${expired} then ${at}::timestamptz else ${s.rateLimits.windowStart} end`,
        },
      })
      .returning({ count: s.rateLimits.count, windowStart: s.rateLimits.windowStart });
    const r = rows[0]!;
    return { count: r.count, windowStart: r.windowStart.getTime() };
  }

  async sweep(before: number) {
    const rows = await getDb().delete(s.rateLimits).where(lt(s.rateLimits.windowStart, new Date(before))).returning({ k: s.rateLimits.keyHash });
    return rows.length;
  }
}

/* ------------------------------ analytics (ADR 0014) ------------------------------ */

type LinkRow = typeof s.trackedLinks.$inferSelect;
const toLink = (r: LinkRow): TrackedLink => ({
  id: r.id,
  tenantId: r.tenantId,
  code: r.code,
  label: r.label,
  channel: r.channel as LinkChannel,
  createdBy: r.createdBy,
  archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});

export class DrizzleAnalyticsRepo implements AnalyticsRepo {
  async listLinks(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.trackedLinks).where(eq(s.trackedLinks.tenantId, tenantId)).orderBy(desc(s.trackedLinks.createdAt), desc(s.trackedLinks.id)),
    );
    return rows.map(toLink);
  }
  async getLink(tenantId: string, id: string) {
    const rows = await withTenant(tenantId, (tx) => tx.select().from(s.trackedLinks).where(and(eq(s.trackedLinks.tenantId, tenantId), eq(s.trackedLinks.id, id))).limit(1));
    return rows[0] ? toLink(rows[0]) : null;
  }
  async findActiveLinkByCode(tenantId: string, code: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.trackedLinks).where(and(eq(s.trackedLinks.tenantId, tenantId), eq(s.trackedLinks.code, code), isNull(s.trackedLinks.archivedAt))).limit(1),
    );
    return rows[0] ? toLink(rows[0]) : null;
  }
  async countActiveLinks(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(s.trackedLinks).where(and(eq(s.trackedLinks.tenantId, tenantId), isNull(s.trackedLinks.archivedAt))),
    );
    return rows[0]?.n ?? 0;
  }
  async createLink(l: TrackedLink) {
    const rows = await withTenant(l.tenantId, (tx) =>
      tx
        .insert(s.trackedLinks)
        .values({ id: l.id, tenantId: l.tenantId, code: l.code, label: l.label, channel: l.channel, createdBy: l.createdBy, archivedAt: d(l.archivedAt), createdAt: new Date(l.createdAt) })
        .onConflictDoNothing({ target: [s.trackedLinks.tenantId, s.trackedLinks.code] })
        .returning({ id: s.trackedLinks.id }),
    );
    return rows.length === 1;
  }
  async updateLink(tenantId: string, id: string, p: { label?: string; channel?: LinkChannel; archivedAt?: string | null }) {
    const set: Partial<typeof s.trackedLinks.$inferInsert> = {};
    if (p.label !== undefined) set.label = p.label;
    if (p.channel !== undefined) set.channel = p.channel;
    if (p.archivedAt !== undefined) set.archivedAt = d(p.archivedAt);
    if (!Object.keys(set).length) return this.getLink(tenantId, id);
    const rows = await withTenant(tenantId, (tx) =>
      tx.update(s.trackedLinks).set(set).where(and(eq(s.trackedLinks.tenantId, tenantId), eq(s.trackedLinks.id, id))).returning(),
    );
    return rows[0] ? toLink(rows[0]) : null;
  }
  async record(e: FunnelEvent) {
    await withTenant(e.tenantId, (tx) =>
      tx.insert(s.analyticsEvents).values({ tenantId: e.tenantId, day: e.day, sessionId: e.sessionId, kind: e.kind, linkId: e.linkId }).onConflictDoNothing(),
    );
  }
  async counts(tenantId: string, fromDay: string, toDay: string): Promise<FunnelCounts> {
    const e = s.analyticsEvents;
    const inRange = and(eq(e.tenantId, tenantId), sql`${e.day} >= ${fromDay}`, sql`${e.day} <= ${toDay}`);
    return withTenant(tenantId, async (tx) => {
      const byDay = await tx.select({ day: e.day, kind: e.kind, count: sql<number>`count(*)::int` }).from(e).where(inRange).groupBy(e.day, e.kind);
      const byLink = await tx.select({ linkId: e.linkId, kind: e.kind, count: sql<number>`count(*)::int` }).from(e).where(inRange).groupBy(e.linkId, e.kind);
      return {
        byDay: byDay.map((r) => ({ day: String(r.day), kind: r.kind as FunnelStage, count: r.count })),
        byLink: byLink.map((r) => ({ linkId: r.linkId, kind: r.kind as FunnelStage, count: r.count })),
      };
    });
  }
  async sweep(tenantId: string, beforeDay: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.delete(s.analyticsEvents).where(and(eq(s.analyticsEvents.tenantId, tenantId), sql`${s.analyticsEvents.day} < ${beforeDay}`)).returning({ k: s.analyticsEvents.sessionId }),
    );
    return rows.length;
  }
}

/* ------------------------------ proof pre-rendering (ADR 0015) ------------------------------ */

type JobRow = typeof s.mockupJobs.$inferSelect;
const toJob = (r: JobRow): ProofJob => ({
  id: r.id,
  tenantId: r.tenantId,
  logoId: r.logoAssetId,
  productSlug: r.productSlug ?? '',
  colorHex: r.colorHex ?? '',
  method: r.method as DecorationMethodKey,
  location: r.location ?? '',
  cacheKey: r.cacheKey,
  status: r.status as ProofJob['status'],
  attempts: r.attempts,
  runAfter: r.runAfter.toISOString(),
  lastError: r.lastError,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export class DrizzleProofJobRepo implements ProofJobRepo {
  async enqueue(tenantId: string, jobs: ProofJob[]) {
    const mine = jobs.filter((j) => j.tenantId === tenantId);
    if (!mine.length) return 0;
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .insert(s.mockupJobs)
        .values(
          mine.map((j) => ({
            id: j.id,
            tenantId,
            logoAssetId: j.logoId,
            productSlug: j.productSlug,
            colorHex: j.colorHex,
            method: j.method,
            location: j.location,
            cacheKey: j.cacheKey,
            idempotencyKey: j.cacheKey,
            status: j.status,
            attempts: j.attempts,
            runAfter: new Date(j.runAfter),
            createdAt: new Date(j.createdAt),
            updatedAt: new Date(j.updatedAt),
          })),
        )
        .onConflictDoNothing({ target: [s.mockupJobs.tenantId, s.mockupJobs.cacheKey] })
        .returning({ id: s.mockupJobs.id }),
    );
    return rows.length;
  }
  async pendingCount(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(s.mockupJobs).where(and(eq(s.mockupJobs.tenantId, tenantId), inArray(s.mockupJobs.status, ['queued', 'running']))),
    );
    return rows[0]?.n ?? 0;
  }
  async claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number) {
    return withTenant(tenantId, async (tx) => {
      const due = await tx
        .select({ id: s.mockupJobs.id })
        .from(s.mockupJobs)
        .where(and(eq(s.mockupJobs.tenantId, tenantId), inArray(s.mockupJobs.status, ['queued', 'running']), lte(s.mockupJobs.runAfter, now)))
        .orderBy(asc(s.mockupJobs.createdAt), asc(s.mockupJobs.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const rows = await tx
        .update(s.mockupJobs)
        .set({ status: 'running', attempts: sql`${s.mockupJobs.attempts} + 1`, runAfter: leaseUntil, updatedAt: now })
        .where(and(eq(s.mockupJobs.tenantId, tenantId), inArray(s.mockupJobs.id, due.map((r) => r.id))))
        .returning();
      return rows.map(toJob).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }
  async finish(tenantId: string, id: string, o: ProofJobOutcome, now: Date) {
    await withTenant(tenantId, (tx) =>
      tx
        .update(s.mockupJobs)
        .set({ status: o.status, lastError: o.status === 'done' ? null : o.error, updatedAt: now, ...(o.status === 'queued' ? { runAfter: o.runAfter } : {}) })
        .where(and(eq(s.mockupJobs.tenantId, tenantId), eq(s.mockupJobs.id, id))),
    );
  }
  async list(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) => tx.select().from(s.mockupJobs).where(eq(s.mockupJobs.tenantId, tenantId)).orderBy(asc(s.mockupJobs.createdAt)));
    return rows.map(toJob);
  }
  async sweep(tenantId: string, before: Date) {
    const rows = await withTenant(tenantId, (tx) =>
      tx
        .delete(s.mockupJobs)
        .where(and(eq(s.mockupJobs.tenantId, tenantId), inArray(s.mockupJobs.status, ['done', 'failed']), lt(s.mockupJobs.updatedAt, before)))
        .returning({ id: s.mockupJobs.id }),
    );
    return rows.length;
  }
}

/* ------------------------------ API keys (ADR 0016) ------------------------------ */

type KeyRow = typeof s.apiKeys.$inferSelect;
const toKey = (r: KeyRow): ApiKeyRecord => ({
  id: r.id,
  tenantId: r.tenantId,
  keyId: r.keyId,
  name: r.name,
  secretHash: r.secretHash,
  scopes: r.scopes as ApiScope[],
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
});

export class DrizzleApiKeyRepo implements ApiKeyRepo {
  async list(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) => tx.select().from(s.apiKeys).where(eq(s.apiKeys.tenantId, tenantId)).orderBy(desc(s.apiKeys.createdAt), desc(s.apiKeys.id)));
    return rows.map(toKey);
  }
  async create(k: ApiKeyRecord) {
    await withTenant(k.tenantId, (tx) =>
      tx.insert(s.apiKeys).values({ id: k.id, tenantId: k.tenantId, keyId: k.keyId, name: k.name, secretHash: k.secretHash, scopes: k.scopes, createdBy: k.createdBy, createdAt: new Date(k.createdAt) }),
    );
  }
  async findActive(tenantId: string, keyId: string) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(s.apiKeys).where(and(eq(s.apiKeys.tenantId, tenantId), eq(s.apiKeys.keyId, keyId), isNull(s.apiKeys.revokedAt))).limit(1),
    );
    return rows[0] ? toKey(rows[0]) : null;
  }
  async countActive(tenantId: string) {
    const rows = await withTenant(tenantId, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(s.apiKeys).where(and(eq(s.apiKeys.tenantId, tenantId), isNull(s.apiKeys.revokedAt))));
    return rows[0]?.n ?? 0;
  }
  async revoke(tenantId: string, id: string, at: Date) {
    const rows = await withTenant(tenantId, (tx) =>
      tx.update(s.apiKeys).set({ revokedAt: at }).where(and(eq(s.apiKeys.tenantId, tenantId), eq(s.apiKeys.id, id), isNull(s.apiKeys.revokedAt))).returning(),
    );
    return rows[0] ? toKey(rows[0]) : null;
  }
  async touch(tenantId: string, id: string, at: Date) {
    await withTenant(tenantId, (tx) => tx.update(s.apiKeys).set({ lastUsedAt: at }).where(and(eq(s.apiKeys.tenantId, tenantId), eq(s.apiKeys.id, id))));
  }
}
