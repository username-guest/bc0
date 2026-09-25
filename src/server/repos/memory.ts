/** In-memory repositories + tenant directory (tests, offline dev server, demos). */
import type { TenantBranding, TenantDirectory, TenantRecord } from '@/server/tenancy/context';
import type { LeadSettings } from '@/features/leads/rules';
import type { TenantPricingConfig } from '@/pricing/types';
import type { AdminAuthStore, AdminRole, AdminSession, AdminUser, AuditEntry, AuditRepo, TeamChange, TeamMember, TenantSettingsWriter } from '@/server/admin/types';
import type { CatalogProduct } from '@/features/catalog/catalog';
import { randomUUID } from 'node:crypto';
import type { SupplierCatalogWriter, SupplierConnectionPatch, SupplierConnectionRecord, SupplierImportItem, SupplierRepo, SupplierSyncStatus, SupplierSyncSummary, ApiKeyRecord, ApiKeyRepo, ProofJob, ProofJobOutcome, ProofJobRepo, AnalyticsRepo, FunnelCounts, FunnelEvent, FunnelStage, LinkChannel, TrackedLink, DeliveryBrief, DeliveryRepo, DeliveryStatus, LeadDelivery, LeadEvent, LeadListQuery, LeadRecord, LeadRepo, LeadUpsert, LogoRecord, LogoRepo, ProductRepo } from './types';
import { decodeLeadCursor, encodeLeadCursor } from './types';
import { importedIdentity } from '@/server/suppliers/identity';

export class MemoryLogoRepo implements LogoRepo {
  private readonly byTenant = new Map<string, Map<string, LogoRecord>>();
  async create(rec: LogoRecord): Promise<void> {
    let t = this.byTenant.get(rec.tenantId);
    if (!t) this.byTenant.set(rec.tenantId, (t = new Map()));
    t.set(rec.id, structuredClone(rec));
  }
  async get(tenantId: string, id: string): Promise<LogoRecord | null> {
    const r = this.byTenant.get(tenantId)?.get(id);
    return r ? structuredClone(r) : null;
  }
  async update(tenantId: string, id: string, patch: Pick<LogoRecord, 'needsReview' | 'warnings'>) {
    const r = this.byTenant.get(tenantId)?.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return structuredClone(r);
  }
  async findByHash(tenantId: string, hash: string, knockout: boolean): Promise<LogoRecord | null> {
    for (const r of this.byTenant.get(tenantId)?.values() ?? []) {
      if (r.hash === hash && r.knockoutEnclosed === knockout) return structuredClone(r);
    }
    return null;
  }
}

interface MemoryProductRow {
  product: CatalogProduct;
  source?: { connectionId: string; supplierProductId: string };
  active: boolean;
}

export class MemoryProductRepo implements ProductRepo, SupplierCatalogWriter {
  private readonly byTenant: Map<string, MemoryProductRow[]>;
  constructor(seed: Record<string, CatalogProduct[]>) {
    this.byTenant = new Map(Object.entries(seed).map(([t, ps]) => [t, ps.map((product) => ({ product, active: true }))]));
  }
  async list(tenantId: string): Promise<CatalogProduct[]> {
    return structuredClone((this.byTenant.get(tenantId) ?? []).filter((r) => r.active).map((r) => r.product));
  }
  async get(tenantId: string, slug: string): Promise<CatalogProduct | null> {
    const r = (this.byTenant.get(tenantId) ?? []).find((x) => x.active && x.product.slug === slug);
    return r ? structuredClone(r.product) : null;
  }
  async applySupplierImport(tenantId: string, connectionId: string, items: SupplierImportItem[], opts: { hideMissing: boolean; keep: string[] }) {
    let rows = this.byTenant.get(tenantId);
    if (!rows) this.byTenant.set(tenantId, (rows = []));
    const out = { created: 0, updated: 0, hidden: 0 };
    const mine = (r: MemoryProductRow, id: string) => r.source?.connectionId === connectionId && r.source.supplierProductId === id;
    for (const it of items) {
      const existing = rows.find((r) => mine(r, it.supplierProductId));
      const others = rows.filter((r) => r !== existing);
      const id = importedIdentity(it.product.name, it.product.slug, it.supplierProductId, {
        names: new Set(others.map((r) => r.product.name.toLowerCase())),
        slugs: new Set(others.map((r) => r.product.slug)),
      });
      const product = structuredClone({ ...it.product, ...id });
      if (existing) {
        existing.product = product;
        existing.active = true;
        out.updated++;
      } else {
        rows.push({ product, source: { connectionId, supplierProductId: it.supplierProductId }, active: true });
        out.created++;
      }
    }
    if (opts.hideMissing) {
      const seen = new Set([...items.map((i) => i.supplierProductId), ...opts.keep]);
      for (const r of rows) {
        if (r.active && r.source?.connectionId === connectionId && !seen.has(r.source.supplierProductId)) {
          r.active = false;
          out.hidden++;
        }
      }
    }
    return out;
  }
  /** Hide everything a connection imported (used when the connection is deleted). */
  hideConnection(tenantId: string, connectionId: string): void {
    for (const r of this.byTenant.get(tenantId) ?? []) if (r.source?.connectionId === connectionId) r.active = false;
  }
}

export class MemorySupplierRepo implements SupplierRepo {
  private readonly rows: SupplierConnectionRecord[] = [];
  private readonly products: MemoryProductRepo | undefined;
  constructor(products?: MemoryProductRepo) {
    this.products = products;
  }
  private find(tenantId: string, id: string) {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id);
  }
  async list(tenantId: string) {
    return this.rows.filter((r) => r.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => structuredClone(r));
  }
  async get(tenantId: string, id: string) {
    const r = this.find(tenantId, id);
    return r ? structuredClone(r) : null;
  }
  async create(c: SupplierConnectionRecord) {
    if (this.rows.some((r) => r.tenantId === c.tenantId && r.name.toLowerCase() === c.name.toLowerCase())) throw new Error('duplicate supplier name');
    this.rows.push(structuredClone(c));
  }
  async update(tenantId: string, id: string, patch: SupplierConnectionPatch) {
    const r = this.find(tenantId, id);
    if (!r) return null;
    if (patch.name && this.rows.some((x) => x !== r && x.tenantId === tenantId && x.name.toLowerCase() === patch.name!.toLowerCase())) throw new Error('duplicate supplier name');
    Object.assign(r, structuredClone(patch));
    return structuredClone(r);
  }
  async remove(tenantId: string, id: string) {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === id);
    if (i === -1) return false;
    this.products?.hideConnection(tenantId, id);
    this.rows.splice(i, 1);
    return true;
  }
  async transition(tenantId: string, id: string, from: SupplierSyncStatus[], to: SupplierSyncStatus, at: Date, staleBefore?: Date) {
    const r = this.find(tenantId, id);
    if (!r) return false;
    const stale = !!staleBefore && (r.status === 'queued' || r.status === 'running') && !!r.statusAt && r.statusAt < staleBefore.toISOString();
    if (!from.includes(r.status) && !stale) return false;
    r.status = to;
    r.statusAt = at.toISOString();
    return true;
  }
  async finish(tenantId: string, id: string, status: 'ok' | 'partial' | 'failed', summary: SupplierSyncSummary) {
    const r = this.find(tenantId, id);
    if (!r) return;
    r.status = status;
    r.statusAt = null;
    r.lastSync = structuredClone(summary);
  }
  async due(tenantId: string, refreshBefore: Date, staleBefore: Date) {
    const rb = refreshBefore.toISOString();
    const sb = staleBefore.toISOString();
    return this.rows
      .filter((r) => r.tenantId === tenantId)
      .filter(
        (r) =>
          r.status === 'queued' ||
          (r.status === 'running' && !!r.statusAt && r.statusAt < sb) ||
          ((r.status === 'ok' || r.status === 'partial' || r.status === 'failed') && (r.lastSync?.at ?? '') < rb),
      )
      .map((r) => r.id);
  }
}

export class MemoryTenantDirectory implements TenantDirectory, TenantSettingsWriter {
  private readonly tenants: TenantRecord[];
  private kills: Set<string>;
  constructor(tenants: TenantRecord[], kills: string[] = []) {
    this.tenants = tenants;
    this.kills = new Set(kills);
  }
  async findBySlug(slug: string) {
    return structuredClone(this.tenants.find((t) => t.slug === slug) ?? null);
  }
  async findByDomain(domain: string) {
    return structuredClone(this.tenants.find((t) => t.customDomain === domain) ?? null);
  }
  async listSlugs() {
    return this.tenants.map((t) => t.slug);
  }
  async globalKillSwitches() {
    return new Set(this.kills);
  }
  setKillSwitches(keys: string[]) {
    this.kills = new Set(keys);
  }
  async updateBranding(tenantId: string, b: Omit<TenantBranding, 'logoUrl'>) {
    const t = this.tenants.find((x) => x.id === tenantId);
    if (t) t.branding = { ...t.branding, ...structuredClone(b) };
  }
  async updatePricingConfig(tenantId: string, c: TenantPricingConfig) {
    const t = this.tenants.find((x) => x.id === tenantId);
    if (t) t.pricingConfig = structuredClone(c);
  }
  async updateLeadSettings(tenantId: string, ls: LeadSettings) {
    const t = this.tenants.find((x) => x.id === tenantId);
    if (t) t.leads = structuredClone(ls);
  }
  async setFlagOverrides(tenantId: string, managed: readonly string[], overrides: Record<string, boolean>) {
    const t = this.tenants.find((x) => x.id === tenantId);
    if (!t) return;
    const next = Object.fromEntries(Object.entries(t.flagOverrides).filter(([k]) => !managed.includes(k)));
    for (const [k, v] of Object.entries(overrides)) if (managed.includes(k)) next[k] = v;
    t.flagOverrides = next;
  }
}

export class MemoryLeadRepo implements LeadRepo {
  private readonly leads = new Map<string, LeadRecord[]>();
  private readonly evts = new Map<string, LeadEvent[]>();

  async upsertByEmail(tenantId: string, input: LeadUpsert, now: Date) {
    const list = this.leads.get(tenantId) ?? [];
    this.leads.set(tenantId, list);
    const at = now.toISOString();
    let lead = list.find((l) => l.email === input.email);
    const created = !lead;
    if (!lead) {
      lead = { id: randomUUID(), tenantId, email: input.email, marketingOptIn: false, sources: [], createdAt: at, updatedAt: at };
      list.push(lead);
    }
    if (input.name) lead.name = input.name;
    if (input.company) lead.company = input.company;
    if (input.phone) lead.phone = input.phone;
    if (input.marketingOptIn && !lead.marketingOptIn) {
      lead.marketingOptIn = true;
      lead.consent = { version: input.consentVersion, at };
    }
    if (!lead.sources.includes(input.source)) lead.sources.push(input.source);
    lead.updatedAt = at;
    return { lead: structuredClone(lead), created };
  }

  async get(tenantId: string, id: string) {
    const l = (this.leads.get(tenantId) ?? []).find((x) => x.id === id);
    return l ? structuredClone(l) : null;
  }

  async addEvent(e: LeadEvent) {
    const list = this.evts.get(e.tenantId) ?? [];
    list.push(structuredClone(e));
    this.evts.set(e.tenantId, list);
  }

  async events(tenantId: string, leadId: string) {
    return structuredClone((this.evts.get(tenantId) ?? []).filter((e) => e.leadId === leadId));
  }

  async list(tenantId: string, q: LeadListQuery) {
    const after = q.cursor ? decodeLeadCursor(q.cursor) : null;
    const needle = q.search?.toLowerCase();
    const ids = q.ids ? new Set(q.ids) : null;
    const rows = (this.leads.get(tenantId) ?? [])
      .filter((l) => !q.source || l.sources.includes(q.source))
      .filter((l) => !ids || ids.has(l.id))
      .filter((l) => !needle || [l.email, l.name, l.company].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)))
      .filter((l) => !after || l.createdAt < after.createdAt || (l.createdAt === after.createdAt && l.id < after.id));
    const items = rows.slice(0, q.limit);
    const more = rows.length > q.limit;
    return { items: structuredClone(items), nextCursor: more ? encodeLeadCursor(items[items.length - 1]!) : null };
  }

  /** Test helper: every lead for a tenant. */
  all(tenantId: string): LeadRecord[] {
    return structuredClone(this.leads.get(tenantId) ?? []);
  }
}

export class MemoryDeliveryRepo implements DeliveryRepo {
  private readonly rows = new Map<string, LeadDelivery>();

  async create(d: LeadDelivery) {
    this.rows.set(d.id, structuredClone(d));
  }
  async get(tenantId: string, id: string) {
    const d = this.rows.get(id);
    return d && d.tenantId === tenantId ? structuredClone(d) : null;
  }
  async update(tenantId: string, id: string, patch: Partial<LeadDelivery>) {
    const d = this.rows.get(id);
    if (!d || d.tenantId !== tenantId) return;
    Object.assign(d, structuredClone(patch));
  }
  async claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number) {
    const due = [...this.rows.values()]
      .filter(
        (d) =>
          d.tenantId === tenantId &&
          (d.status === 'pending' || d.status === 'failed') &&
          d.nextAttemptAt !== null &&
          d.nextAttemptAt <= now.toISOString(),
      )
      .sort((a, b) => a.nextAttemptAt!.localeCompare(b.nextAttemptAt!))
      .slice(0, limit);
    for (const d of due) d.nextAttemptAt = leaseUntil.toISOString();
    return structuredClone(due);
  }
  async statusesFor(tenantId: string, leadIds: string[]) {
    const want = new Set(leadIds);
    const out: Record<string, DeliveryBrief[]> = {};
    for (const d of this.rows.values())
      if (d.tenantId === tenantId && want.has(d.leadId)) (out[d.leadId] ??= []).push({ status: d.status, ...(d.routedTo ? { routedTo: d.routedTo } : {}) });
    return out;
  }
  async leadIdsWithStatus(tenantId: string, statuses: DeliveryStatus[], limit: number) {
    const ids = new Set<string>();
    for (const d of this.rows.values()) if (d.tenantId === tenantId && statuses.includes(d.status)) ids.add(d.leadId);
    return [...ids].slice(0, limit);
  }
  async forLead(tenantId: string, leadId: string) {
    return structuredClone(
      [...this.rows.values()].filter((d) => d.tenantId === tenantId && d.leadId === leadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }
}

type MemberRow = AdminUser & { createdAt: string; lastSignInAt: string | null; invitedBy: string | null };

export class MemoryAdminAuthStore implements AdminAuthStore {
  private readonly users: MemberRow[];
  private readonly tokens = new Map<string, { tenantId: string; userId: string; tokenHash: string; expiresAt: number; usedAt: number | null }>();
  private readonly sessions = new Map<string, AdminSession & { tokenHash: string; revokedAt: number | null }>();
  constructor(users: AdminUser[] = []) {
    this.users = users.map((u) => ({ ...structuredClone(u), createdAt: new Date(0).toISOString(), lastSignInAt: null, invitedBy: null }));
  }
  private static user(u: MemberRow | undefined): AdminUser | null {
    return u ? { id: u.id, tenantId: u.tenantId, email: u.email, role: u.role } : null;
  }
  async findUserByEmail(tenantId: string, email: string) {
    return MemoryAdminAuthStore.user(this.users.find((u) => u.tenantId === tenantId && u.email === email));
  }
  async getUser(tenantId: string, id: string) {
    return MemoryAdminAuthStore.user(this.users.find((u) => u.tenantId === tenantId && u.id === id));
  }
  async createLoginToken(t: { id: string; tenantId: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date }) {
    this.tokens.set(t.id, { tenantId: t.tenantId, userId: t.userId, tokenHash: t.tokenHash, expiresAt: t.expiresAt.getTime(), usedAt: null });
  }
  async consumeLoginToken(tenantId: string, tokenHash: string, now: Date) {
    for (const t of this.tokens.values()) {
      if (t.tenantId !== tenantId || t.tokenHash !== tokenHash) continue;
      if (t.usedAt !== null || t.expiresAt <= now.getTime()) return null;
      t.usedAt = now.getTime(); // synchronous check-and-set: single use even under concurrency
      return t.userId;
    }
    return null;
  }
  async createSession(s: AdminSession & { tokenHash: string; createdAt: Date }) {
    const { createdAt: _createdAt, ...row } = s;
    this.sessions.set(s.id, { ...structuredClone(row), revokedAt: null });
  }
  async findSession(tenantId: string, tokenHash: string, now: Date) {
    for (const s of this.sessions.values()) {
      if (s.tenantId === tenantId && s.tokenHash === tokenHash && s.revokedAt === null && Date.parse(s.expiresAt) > now.getTime()) {
        return { id: s.id, tenantId: s.tenantId, userId: s.userId, csrfToken: s.csrfToken, expiresAt: s.expiresAt };
      }
    }
    return null;
  }
  async revokeSession(tenantId: string, id: string, now: Date) {
    const s = this.sessions.get(id);
    if (s && s.tenantId === tenantId) s.revokedAt = now.getTime();
  }
  async sweep(tenantId: string, c: { tokensBefore: Date; sessionsBefore: Date }) {
    let tokens = 0;
    let sessions = 0;
    const tb = c.tokensBefore.getTime();
    const sb = c.sessionsBefore.getTime();
    for (const [id, t] of this.tokens) {
      if (t.tenantId === tenantId && (t.expiresAt < tb || (t.usedAt !== null && t.usedAt < tb))) {
        this.tokens.delete(id);
        tokens++;
      }
    }
    for (const [id, s] of this.sessions) {
      if (s.tenantId === tenantId && (Date.parse(s.expiresAt) < sb || (s.revokedAt !== null && s.revokedAt < sb))) {
        this.sessions.delete(id);
        sessions++;
      }
    }
    return { tokens, sessions };
  }
  async listMembers(tenantId: string): Promise<TeamMember[]> {
    return structuredClone(this.users.filter((u) => u.tenantId === tenantId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.email.localeCompare(b.email));
  }
  async addMember(m: { id: string; tenantId: string; email: string; role: AdminRole; invitedBy: string; createdAt: Date }) {
    if (this.users.some((u) => u.tenantId === m.tenantId && u.email === m.email)) return 'exists' as const;
    this.users.push({ id: m.id, tenantId: m.tenantId, email: m.email, role: m.role, invitedBy: m.invitedBy, createdAt: m.createdAt.toISOString(), lastSignInAt: null });
    return 'created' as const;
  }
  private ownerCheck(tenantId: string, id: string, loses: (r: AdminRole) => boolean): TeamChange | MemberRow {
    const target = this.users.find((u) => u.tenantId === tenantId && u.id === id);
    if (!target) return 'not_found';
    const owners = this.users.filter((u) => u.tenantId === tenantId && u.role === 'tenant_owner').length;
    return loses(target.role) && owners <= 1 ? 'last_owner' : target;
  }
  async changeRole(tenantId: string, id: string, role: AdminRole): Promise<TeamChange> {
    const t = this.ownerCheck(tenantId, id, (r) => r === 'tenant_owner' && role !== 'tenant_owner');
    if (typeof t === 'string') return t;
    t.role = role;
    return 'ok';
  }
  async removeMember(tenantId: string, id: string): Promise<TeamChange> {
    const t = this.ownerCheck(tenantId, id, (r) => r === 'tenant_owner');
    if (typeof t === 'string') return t;
    this.users.splice(this.users.indexOf(t), 1);
    // FK cascade in Postgres: their links and sessions go with them.
    for (const [k, v] of this.tokens) if (v.tenantId === tenantId && v.userId === id) this.tokens.delete(k);
    for (const [k, v] of this.sessions) if (v.tenantId === tenantId && v.userId === id) this.sessions.delete(k);
    return 'ok';
  }
  async recordSignIn(tenantId: string, id: string, at: Date) {
    const u = this.users.find((x) => x.tenantId === tenantId && x.id === id);
    if (u) u.lastSignInAt = at.toISOString();
  }
  /** Test helper: live row counts. */
  counts() {
    return { tokens: this.tokens.size, sessions: this.sessions.size };
  }
}

export class MemoryAuditRepo implements AuditRepo {
  private readonly rows: AuditEntry[] = [];
  async record(e: AuditEntry) {
    this.rows.push(structuredClone(e));
  }
  async recent(tenantId: string, limit: number) {
    return structuredClone(this.rows.filter((r) => r.tenantId === tenantId).slice(-limit).reverse());
  }
}

/** ADR 0014. Same contract as the Postgres repo: tenant-scoped, idempotent events. */
export class MemoryAnalyticsRepo implements AnalyticsRepo {
  private readonly links: TrackedLink[] = [];
  private readonly events = new Map<string, FunnelEvent>();

  async listLinks(tenantId: string) {
    return this.links.filter((l) => l.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((l) => structuredClone(l));
  }
  async getLink(tenantId: string, id: string) {
    const l = this.links.find((x) => x.tenantId === tenantId && x.id === id);
    return l ? structuredClone(l) : null;
  }
  async findActiveLinkByCode(tenantId: string, code: string) {
    const l = this.links.find((x) => x.tenantId === tenantId && x.code === code && !x.archivedAt);
    return l ? structuredClone(l) : null;
  }
  async countActiveLinks(tenantId: string) {
    return this.links.filter((l) => l.tenantId === tenantId && !l.archivedAt).length;
  }
  async createLink(l: TrackedLink) {
    if (this.links.some((x) => x.tenantId === l.tenantId && x.code === l.code)) return false;
    this.links.push(structuredClone(l));
    return true;
  }
  async updateLink(tenantId: string, id: string, patch: { label?: string; channel?: LinkChannel; archivedAt?: string | null }) {
    const l = this.links.find((x) => x.tenantId === tenantId && x.id === id);
    if (!l) return null;
    if (patch.label !== undefined) l.label = patch.label;
    if (patch.channel !== undefined) l.channel = patch.channel;
    if (patch.archivedAt !== undefined) l.archivedAt = patch.archivedAt;
    return structuredClone(l);
  }
  async record(e: FunnelEvent) {
    const k = `${e.tenantId}|${e.day}|${e.sessionId}|${e.kind}`;
    if (!this.events.has(k)) this.events.set(k, { ...e });
  }
  async counts(tenantId: string, fromDay: string, toDay: string): Promise<FunnelCounts> {
    const byDay = new Map<string, number>();
    const byLink = new Map<string, number>();
    for (const e of this.events.values()) {
      if (e.tenantId !== tenantId || e.day < fromDay || e.day > toDay) continue;
      byDay.set(`${e.day}|${e.kind}`, (byDay.get(`${e.day}|${e.kind}`) ?? 0) + 1);
      byLink.set(`${e.linkId ?? ''}|${e.kind}`, (byLink.get(`${e.linkId ?? ''}|${e.kind}`) ?? 0) + 1);
    }
    return {
      byDay: [...byDay].map(([k, count]) => { const [day, kind] = k.split('|'); return { day: day!, kind: kind as FunnelStage, count }; }),
      byLink: [...byLink].map(([k, count]) => { const [id, kind] = k.split('|'); return { linkId: id || null, kind: kind as FunnelStage, count }; }),
    };
  }
  async sweep(tenantId: string, beforeDay: string) {
    let n = 0;
    for (const [k, e] of this.events) if (e.tenantId === tenantId && e.day < beforeDay) { this.events.delete(k); n++; }
    return n;
  }
}

/** ADR 0015. Same contract as the Postgres repo: tenant-scoped, deduplicated by cache key. */
export class MemoryProofJobRepo implements ProofJobRepo {
  private readonly jobs: ProofJob[] = [];
  async enqueue(tenantId: string, jobs: ProofJob[]) {
    let n = 0;
    for (const j of jobs) {
      if (j.tenantId !== tenantId || this.jobs.some((x) => x.tenantId === tenantId && x.cacheKey === j.cacheKey)) continue;
      this.jobs.push(structuredClone(j));
      n++;
    }
    return n;
  }
  async pendingCount(tenantId: string) {
    return this.jobs.filter((j) => j.tenantId === tenantId && (j.status === 'queued' || j.status === 'running')).length;
  }
  async claimDue(tenantId: string, now: Date, leaseUntil: Date, limit: number) {
    const due = this.jobs
      .filter((j) => j.tenantId === tenantId && (j.status === 'queued' || j.status === 'running') && Date.parse(j.runAfter) <= now.getTime())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const j of due) {
      j.status = 'running';
      j.attempts += 1;
      j.runAfter = leaseUntil.toISOString();
      j.updatedAt = now.toISOString();
    }
    return due.map((j) => structuredClone(j));
  }
  async finish(tenantId: string, id: string, o: ProofJobOutcome, now: Date) {
    const j = this.jobs.find((x) => x.tenantId === tenantId && x.id === id);
    if (!j) return;
    j.status = o.status;
    j.lastError = o.status === 'done' ? null : o.error;
    if (o.status === 'queued') j.runAfter = o.runAfter.toISOString();
    j.updatedAt = now.toISOString();
  }
  async list(tenantId: string) {
    return this.jobs.filter((j) => j.tenantId === tenantId).map((j) => structuredClone(j));
  }
  async sweep(tenantId: string, before: Date) {
    let n = 0;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i]!;
      if (j.tenantId === tenantId && (j.status === 'done' || j.status === 'failed') && Date.parse(j.updatedAt) < before.getTime()) {
        this.jobs.splice(i, 1);
        n++;
      }
    }
    return n;
  }
}

/** ADR 0016. Same contract as the Postgres repo. */
export class MemoryApiKeyRepo implements ApiKeyRepo {
  private readonly keys: ApiKeyRecord[] = [];
  async list(tenantId: string) {
    return this.keys.filter((k) => k.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((k) => structuredClone(k));
  }
  async create(k: ApiKeyRecord) {
    if (this.keys.some((x) => x.tenantId === k.tenantId && x.keyId === k.keyId)) throw new Error('duplicate key id');
    this.keys.push(structuredClone(k));
  }
  async findActive(tenantId: string, keyId: string) {
    const k = this.keys.find((x) => x.tenantId === tenantId && x.keyId === keyId && !x.revokedAt);
    return k ? structuredClone(k) : null;
  }
  async countActive(tenantId: string) {
    return this.keys.filter((k) => k.tenantId === tenantId && !k.revokedAt).length;
  }
  async revoke(tenantId: string, id: string, at: Date) {
    const k = this.keys.find((x) => x.tenantId === tenantId && x.id === id && !x.revokedAt);
    if (!k) return null;
    k.revokedAt = at.toISOString();
    return structuredClone(k);
  }
  async touch(tenantId: string, id: string, at: Date) {
    const k = this.keys.find((x) => x.tenantId === tenantId && x.id === id);
    if (k) k.lastUsedAt = at.toISOString();
  }
}
