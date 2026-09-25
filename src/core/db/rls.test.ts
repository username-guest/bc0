/**
 * Multi-tenant isolation proof (§12, §15: "one tenant cannot read another's data").
 *
 * This is an INTEGRATION test: it requires a live Postgres reachable at DATABASE_URL, connected as
 * the non-BYPASSRLS app role, with migrations (incl. db/policies/0001_enable_rls.sql) applied. It is
 * skipped automatically when DATABASE_URL is absent (e.g. offline CI unit stage) so the unit suite
 * stays hermetic; the CI `integration` job provisions Postgres and runs it.
 *
 * What it asserts:
 *   1. Reads are tenant-scoped: tenant A cannot see tenant B's product even with no WHERE clause.
 *   2. Writes are tenant-scoped: inserting a row whose tenant_id ≠ current tenant fails WITH CHECK.
 *   3. Unset tenant context yields zero rows (closed default), never a cross-tenant leak.
 *   4. Every table in TENANT_SCOPED_TABLES has RLS enabled AND forced in the live database, so a
 *      new table can't be added to the schema and forgotten in the policy file.
 *   5. Tracked links and funnel events (ADR 0014) stay inside their tenant.
 *   6. API keys (ADR 0016) can't be found, used or revoked from another tenant.
 *   7. Supplier connections and imported products (ADR 0017) stay inside their tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { getDb, withTenant } from './tenant';
import * as s from './schema';
import { DrizzleAnalyticsRepo, DrizzleApiKeyRepo, DrizzleProductRepo, DrizzleSupplierRepo } from '@/server/repos/drizzle';
import { newLinkCode } from '@/features/analytics/funnel';

// DATABASE_URL = app role (RLS enforced). MIGRATION_DATABASE_URL = owner role, used ONLY to
// provision tenants/plans, which the app role is deliberately not allowed to write.
const HAS_DB = !!process.env.DATABASE_URL && !!process.env.MIGRATION_DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

d('RLS tenant isolation', () => {
  let owner: Pool;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.query(
      `insert into plans (key, label, rank) values ('free','Free',0) on conflict do nothing`,
    );
    await owner.query(
      `insert into tenants (id, slug, name, plan_key) values
         ($1,'tenant-a','A','free'), ($2,'tenant-b','B','free')
       on conflict do nothing`,
      [TENANT_A, TENANT_B],
    );

    // Tenant rows are written AS THE APP ROLE through withTenant — this also exercises WITH CHECK.

    await withTenant(TENANT_A, async (tx) => {
      await tx
        .insert(s.products)
        .values({ tenantId: TENANT_A, slug: 'a-only-widget', template: 'tee', name: 'A-only widget', category: 'Apparel', breaks: [] })
        .onConflictDoNothing();
    });
    await withTenant(TENANT_B, async (tx) => {
      await tx
        .insert(s.products)
        .values({ tenantId: TENANT_B, slug: 'b-only-widget', template: 'tee', name: 'B-only widget', category: 'Apparel', breaks: [] })
        .onConflictDoNothing();
    });
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('app role cannot provision tenants (write to global tables is denied)', async () => {
    const db = getDb();
    await expect(
      db.execute(sql`insert into tenants (slug, name) values ('rogue', 'Rogue')`),
    ).rejects.toThrow(/permission denied/);
  });

  it('A cannot read B rows even with an unfiltered select', async () => {
    const rowsSeenByA = await withTenant(TENANT_A, async (tx) => {
      return tx.select({ name: s.products.name }).from(s.products);
    });
    const names = rowsSeenByA.map((r) => r.name);
    expect(names).toContain('A-only widget');
    expect(names).not.toContain('B-only widget');
  });

  it('B cannot read A rows even with an unfiltered select', async () => {
    const rowsSeenByB = await withTenant(TENANT_B, async (tx) => {
      return tx.select({ name: s.products.name }).from(s.products);
    });
    const names = rowsSeenByB.map((r) => r.name);
    expect(names).toContain('B-only widget');
    expect(names).not.toContain('A-only widget');
  });

  it('rejects inserting a row for a different tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(TENANT_A, async (tx) => {
        await tx
          .insert(s.products)
          .values({ tenantId: TENANT_B, slug: 'smuggled', template: 'tee', name: 'smuggled', category: 'Apparel', breaks: [] });
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('with no tenant context set, tenant tables return zero rows (closed default)', async () => {
    const db = getDb();
    const rows = await db.execute(sql`select count(*)::int as n from products`);
    // `db` handle has no app.current_tenant_id set → policy denies all rows.
    const n = (rows.rows?.[0] as { n: number } | undefined)?.n ?? 0;
    expect(n).toBe(0);
  });

  it('every tenant-scoped table has row-level security enabled and forced', async () => {
    const r = await owner.query<{ relname: string; on: boolean; forced: boolean }>(
      `select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = any($1) and relkind = 'r'`,
      [[...s.TENANT_SCOPED_TABLES]],
    );
    const bad = s.TENANT_SCOPED_TABLES.filter((t) => {
      const row = r.rows.find((x) => x.relname === t);
      return !row || !row.on || !row.forced;
    });
    expect(bad).toEqual([]);
  });

  it('tracked links and funnel events are invisible to other tenants', async () => {
    const repo = new DrizzleAnalyticsRepo();
    const code = newLinkCode();
    const id = crypto.randomUUID();
    expect(await repo.createLink({ id, tenantId: TENANT_A, code, label: 'A only', channel: 'email', createdBy: null, archivedAt: null, createdAt: new Date().toISOString() })).toBe(true);
    await repo.record({ tenantId: TENANT_A, day: '2026-09-10', sessionId: `rls-${id}`, kind: 'visit', linkId: id });
    await repo.record({ tenantId: TENANT_A, day: '2026-09-10', sessionId: `rls-${id}`, kind: 'visit', linkId: id }); // idempotent

    expect(await repo.findActiveLinkByCode(TENANT_B, code)).toBeNull();
    expect(await repo.getLink(TENANT_B, id)).toBeNull();
    expect(await repo.updateLink(TENANT_B, id, { label: 'hijacked' })).toBeNull();
    expect((await repo.counts(TENANT_B, '2026-09-10', '2026-09-10')).byLink.some((x) => x.linkId === id)).toBe(false);
    // The same code is free in another tenant: codes are unique per tenant, not globally.
    expect(await repo.createLink({ id: crypto.randomUUID(), tenantId: TENANT_B, code, label: 'B too', channel: 'email', createdBy: null, archivedAt: null, createdAt: new Date().toISOString() })).toBe(true);
    // ...but not twice in one tenant.
    expect(await repo.createLink({ id: crypto.randomUUID(), tenantId: TENANT_A, code, label: 'dup', channel: 'email', createdBy: null, archivedAt: null, createdAt: new Date().toISOString() })).toBe(false);

    const mine = await repo.counts(TENANT_A, '2026-09-10', '2026-09-10');
    expect(mine.byLink.find((x) => x.linkId === id)).toEqual({ linkId: id, kind: 'visit', count: 1 });
    expect(await repo.sweep(TENANT_B, '2100-01-01')).toBe(0); // B's sweep can't touch A's rows
    expect((await repo.counts(TENANT_A, '2026-09-10', '2026-09-10')).byLink.find((x) => x.linkId === id)?.count).toBe(1);
  });

  it('API keys are invisible to other tenants and cannot be revoked across them', async () => {
    const repo = new DrizzleApiKeyRepo();
    const id = crypto.randomUUID();
    const keyId = `rls${id.replace(/-/g, '').slice(0, 9)}`;
    await repo.create({ id, tenantId: TENANT_A, keyId, name: 'A sync', secretHash: 'x'.repeat(64), scopes: ['leads:read'], createdBy: null, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null });

    // Unfiltered select as B: RLS alone must hide A's key.
    const seenByB = await withTenant(TENANT_B, (tx) => tx.select().from(s.apiKeys));
    expect(seenByB.some((k) => k.id === id)).toBe(false);
    expect(await repo.findActive(TENANT_B, keyId)).toBeNull();
    expect(await repo.revoke(TENANT_B, id, new Date())).toBeNull();
    await repo.touch(TENANT_B, id, new Date()); // silently affects nothing
    // B can't plant a key into A either.
    await expect(
      withTenant(TENANT_B, (tx) => tx.insert(s.apiKeys).values({ tenantId: TENANT_A, keyId: 'planted00000', name: 'x', secretHash: 'x', scopes: [] })),
    ).rejects.toThrow();

    const still = await repo.findActive(TENANT_A, keyId);
    expect(still?.revokedAt).toBeNull();
    expect(still?.lastUsedAt).toBeNull();
    expect((await repo.revoke(TENANT_A, id, new Date()))?.id).toBe(id);
    expect(await repo.findActive(TENANT_A, keyId)).toBeNull();
  });

  it('supplier connections are invisible across tenants, and imports only touch their own tenant', async () => {
    const repo = new DrizzleSupplierRepo();
    const products = new DrizzleProductRepo();
    const id = crypto.randomUUID();
    await repo.create({
      id, tenantId: TENANT_A, name: `RLS supplier ${id.slice(0, 8)}`, productDataUrl: 'https://ps.example.com/pd', pricingUrl: 'https://ps.example.com/ppc',
      accountId: 'acct', passwordSealed: 'v1.sealed', currency: 'USD', priceType: 'Net', fobId: null, productIds: [],
      status: 'never', statusAt: null, lastSync: null, createdAt: new Date().toISOString(),
    });

    // Unfiltered select as B: RLS alone hides A's connection (and its sealed password).
    const seenByB = await withTenant(TENANT_B, (tx) => tx.select().from(s.supplierConnections));
    expect(seenByB.some((c) => c.id === id)).toBe(false);
    expect(await repo.get(TENANT_B, id)).toBeNull();
    expect(await repo.update(TENANT_B, id, { accountId: 'hijack' })).toBeNull();
    expect(await repo.transition(TENANT_B, id, ['never'], 'queued', new Date())).toBe(false);
    expect(await repo.remove(TENANT_B, id)).toBe(false);
    await expect(
      withTenant(TENANT_B, (tx) => tx.insert(s.supplierConnections).values({ tenantId: TENANT_A, name: 'planted', productDataUrl: 'x', pricingUrl: 'x', accountId: 'x', passwordSealed: 'x' })),
    ).rejects.toThrow();

    // An import run as B, naming A's connection, writes nothing into A.
    const item = {
      supplierProductId: `RLS-${id.slice(0, 8)}`,
      product: { slug: `rls-${id.slice(0, 8)}`, template: 'tee' as const, name: `RLS import ${id.slice(0, 8)}`, category: 'Apparel', brand: '', traits: { isApparel: true }, blankBase: 300,
        breaks: [{ minQty: 12, blankUnitCost: 300 }], colors: [{ name: 'Black', hex: '#000000', isDark: true }], methods: [{ method: 'screen_print' as const, location: 'full_front', w: 10, h: 12 }] },
    };
    // (A foreign key alone wouldn't stop this: FK checks bypass RLS. The import checks the connection under RLS first.)
    await expect(products.applySupplierImport(TENANT_B, id, [item], { hideMissing: true, keep: [] })).rejects.toThrow(/unknown supplier connection/);
    expect((await products.list(TENANT_B)).some((p) => p.slug === item.product.slug)).toBe(false);
    expect((await products.list(TENANT_A)).some((p) => p.slug === item.product.slug)).toBe(false);

    // As A it imports, and B still can't see the product.
    const r = await products.applySupplierImport(TENANT_A, id, [item], { hideMissing: true, keep: [] });
    expect(r).toEqual({ created: 1, updated: 0, hidden: 0 });
    expect((await products.list(TENANT_A)).some((p) => p.slug === item.product.slug)).toBe(true);
    expect((await products.list(TENANT_B)).some((p) => p.slug === item.product.slug)).toBe(false);
    // Removing hides A's imported product; it is not deleted.
    expect(await repo.remove(TENANT_A, id)).toBe(true);
    expect((await products.list(TENANT_A)).some((p) => p.slug === item.product.slug)).toBe(false);
    const kept = await withTenant(TENANT_A, (tx) => tx.select({ active: s.products.active }).from(s.products).where(eq(s.products.slug, item.product.slug)));
    expect(kept).toEqual([{ active: false }]);
  });
});
