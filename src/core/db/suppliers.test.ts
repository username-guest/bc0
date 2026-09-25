/**
 * Supplier catalog sync on real Postgres (ADR 0017). Integration test: needs DATABASE_URL (app
 * role) and MIGRATION_DATABASE_URL (owner, to provision tenants); skipped without them. Assumes
 * `db:setup` has seeded the reference tables (colour families, decoration methods).
 *
 * Proves what the in-memory repos can only imitate: a full sync from the fake supplier lands in
 * products / product_colors / decoration_compatibility under RLS; re-syncs replace rows instead of
 * duplicating them; the status lock is atomic under concurrent workers; hiding never deletes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DrizzleProductRepo, DrizzleSupplierRepo } from '@/server/repos/drizzle';
import { createSupplierService } from '@/server/suppliers/service';
import { devSecretBox } from '@/server/crypto/secret-box';
import { fakeSupplier, FAKE_CREDENTIALS, FAKE_ENDPOINTS } from '@/integrations/promostandards/fake-supplier';
import type { TenantContext } from '@/server/tenancy/context';

const HAS_DB = !!process.env.DATABASE_URL && !!process.env.MIGRATION_DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d('supplier sync (Postgres)', () => {
  const suppliers = new DrizzleSupplierRepo();
  const products = new DrizzleProductRepo();
  const secrets = devSecretBox();
  const A = randomUUID();
  let owner: Pool;
  // The service only needs the tenant id and the entitlement check.
  const ctx = { tenant: { id: A }, can: () => true } as unknown as TenantContext;
  const service = createSupplierService({ suppliers, catalog: products, secrets, post: fakeSupplier(), now: () => new Date(), log: () => {} });

  const connection = async (name: string) => {
    const id = randomUUID();
    await suppliers.create({
      id, tenantId: A, name, productDataUrl: FAKE_ENDPOINTS.productData, pricingUrl: FAKE_ENDPOINTS.pricing, accountId: FAKE_CREDENTIALS.id,
      passwordSealed: secrets.seal(FAKE_CREDENTIALS.password, A), currency: 'USD', priceType: 'Net', fobId: null, productIds: [],
      status: 'never', statusAt: null, lastSync: null, createdAt: new Date().toISOString(),
    });
    return id;
  };
  const rows = async (table: string) => (await owner.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [A])).rows[0].n as number;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.query(`insert into plans (key, label, rank) values ('enterprise','Enterprise',3) on conflict do nothing`);
    await owner.query(`insert into tenants (id, slug, name, plan_key) values ($1, $2, 'Suppliers A', 'enterprise')`, [A, `sup-${A.slice(0, 8)}`]);
  });

  afterAll(async () => {
    await owner.query(`delete from tenants where id = $1`, [A]); // cascades to connections and products
    await owner.end();
  });

  it('a full sync writes products, colours and decoration rows; a re-sync replaces them', async () => {
    const id = await connection('Acme');
    const first = await service.run(ctx, id);
    expect(first).toMatchObject({ created: 2, updated: 0, hidden: 0, skipped: 1, failed: 0 });
    const listed = await products.list(A);
    const tee = listed.find((p) => p.slug === 'supplier-heavy-cotton-tee')!;
    expect(tee.breaks).toEqual([
      { minQty: 24, blankUnitCost: 410 },
      { minQty: 72, blankUnitCost: 346 },
      { minQty: 144, blankUnitCost: 320 },
    ]);
    expect(tee.colors.map((c) => c.hex).sort()).toEqual(['#000000', '#FFFFFF']);
    expect(tee.methods).toHaveLength(3);
    const counts = [await rows('products'), await rows('product_colors'), await rows('decoration_compatibility')];

    const second = await service.run(ctx, id);
    expect(second).toMatchObject({ created: 0, updated: 2 });
    expect([await rows('products'), await rows('product_colors'), await rows('decoration_compatibility')]).toEqual(counts);

    const saved = (await suppliers.get(A, id))!;
    expect(saved.status).toBe('ok');
    expect(saved.lastSync).toMatchObject({ created: 0, updated: 2, skipped: 1 });
    expect(saved.statusAt).toBeNull();
  });

  it('two workers racing for one connection: exactly one runs it', async () => {
    const id = await connection('Race');
    await suppliers.transition(A, id, ['never'], 'queued', new Date());
    const results = await Promise.all([service.run(ctx, id), service.run(ctx, id), service.run(ctx, id)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('narrowing hides, removing hides everything, and nothing is deleted', async () => {
    const id = await connection('Narrow');
    await service.run(ctx, id);
    const mine = async () => (await owner.query(`select supplier_product_id as id, active from products where tenant_id = $1 and supplier_connection_id = $2 order by 1`, [A, id])).rows;
    expect(await mine()).toEqual([{ id: 'PS-TEE-100', active: true }, { id: 'PS-TUM-20', active: true }]);

    await suppliers.update(A, id, { productIds: ['PS-TEE-100'] });
    expect(await service.run(ctx, id)).toMatchObject({ updated: 1, hidden: 1 });
    expect(await mine()).toEqual([{ id: 'PS-TEE-100', active: true }, { id: 'PS-TUM-20', active: false }]);

    const before = await rows('products');
    expect(await suppliers.remove(A, id)).toBe(true);
    expect(await rows('products')).toBe(before); // hidden and detached, not deleted
    const orphaned = (await owner.query(`select count(*)::int as n from products where tenant_id = $1 and supplier_connection_id is null and supplier_product_id is not null and active`, [A])).rows[0].n;
    expect(orphaned).toBe(0);
  });

  it('a stale lock from a crashed worker is taken over; a fresh one is not', async () => {
    const id = await connection('Stale');
    const crashedAt = new Date(Date.now() - 31 * 60_000);
    expect(await suppliers.transition(A, id, ['never'], 'running', crashedAt)).toBe(true);
    expect(await suppliers.due(A, new Date(0), new Date(Date.now() - 30 * 60_000))).toContain(id);
    expect(await service.run(ctx, id)).not.toBeNull();

    expect(await suppliers.transition(A, id, ['ok'], 'running', new Date())).toBe(true);
    expect(await service.run(ctx, id)).toBeNull();
  });
});
