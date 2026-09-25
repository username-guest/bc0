/**
 * Team management against real Postgres, as the app role under RLS (ADR 0011).
 * INTEGRATION test: skipped without DATABASE_URL + MIGRATION_DATABASE_URL, like rls.test.ts.
 *
 * The property that matters: "never leave a workspace without an owner" must hold when two
 * owners act AT THE SAME TIME. A check-then-write in application code would let both through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DrizzleAdminAuthStore } from '@/server/repos/drizzle';

const HAS_DB = !!process.env.DATABASE_URL && !!process.env.MIGRATION_DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d('team store (Postgres)', () => {
  const store = new DrizzleAdminAuthStore();
  const tenantId = randomUUID();
  let owner: Pool;
  const ownerCount = async () =>
    Number((await owner.query(`select count(*)::int as n from users where tenant_id = $1 and role = 'tenant_owner'`, [tenantId])).rows[0].n);

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.query(`insert into plans (key, label, rank) values ('free','Free',0) on conflict do nothing`);
    await owner.query(`insert into tenants (id, slug, name, plan_key) values ($1, $2, 'Team test', 'free')`, [tenantId, `team-${tenantId.slice(0, 8)}`]);
  });

  afterAll(async () => {
    await owner.query(`delete from tenants where id = $1`, [tenantId]); // cascades to users, tokens, sessions
    await owner.end();
  });

  const add = async (email: string, role: 'tenant_owner' | 'tenant_admin') => {
    const id = randomUUID();
    expect(await store.addMember({ id, tenantId, email, role, invitedBy: id, createdAt: new Date() })).toBe('created');
    return id;
  };

  it('adds members once per email', async () => {
    await add('first@team.test', 'tenant_admin');
    expect(await store.addMember({ id: randomUUID(), tenantId, email: 'first@team.test', role: 'tenant_owner', invitedBy: randomUUID(), createdAt: new Date() })).toBe('exists');
  });

  it('two owners demoting each other at once: exactly one wins, one owner remains (10 rounds)', async () => {
    const a = await add('a@team.test', 'tenant_owner');
    const b = await add('b@team.test', 'tenant_owner');
    for (let round = 0; round < 10; round++) {
      await store.changeRole(tenantId, a, 'tenant_owner');
      await store.changeRole(tenantId, b, 'tenant_owner');
      expect(await ownerCount()).toBe(2);
      const results = await Promise.all([store.changeRole(tenantId, a, 'tenant_admin'), store.changeRole(tenantId, b, 'tenant_admin')]);
      expect(results.sort()).toEqual(['last_owner', 'ok']);
      expect(await ownerCount()).toBe(1);
    }
  });

  it('two owners removing each other at once: exactly one wins (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      await owner.query(`delete from users where tenant_id = $1`, [tenantId]);
      const a = await add(`ra${round}@team.test`, 'tenant_owner');
      const b = await add(`rb${round}@team.test`, 'tenant_owner');
      const results = await Promise.all([store.removeMember(tenantId, a), store.removeMember(tenantId, b)]);
      expect(results.sort()).toEqual(['last_owner', 'ok']);
      expect(await ownerCount()).toBe(1);
    }
  });

  it('removing a member deletes their sign-in links and sessions (FK cascade)', async () => {
    const u = await add('leaving@team.test', 'tenant_admin');
    const now = new Date();
    await store.createLoginToken({ id: randomUUID(), tenantId, userId: u, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now });
    await store.createSession({ id: randomUUID(), tenantId, userId: u, csrfToken: 'c', expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), tokenHash: randomUUID(), createdAt: now });
    expect(await store.removeMember(tenantId, u)).toBe('ok');
    const left = await owner.query(
      `select (select count(*) from admin_login_tokens where user_id = $1)::int as t, (select count(*) from admin_sessions where user_id = $1)::int as s`,
      [u],
    );
    expect(left.rows[0]).toEqual({ t: 0, s: 0 });
  });

  it('records the first sign-in', async () => {
    const u = await add('new@team.test', 'tenant_admin');
    expect((await store.listMembers(tenantId)).find((m) => m.id === u)?.lastSignInAt).toBeNull();
    const at = new Date('2026-09-24T10:00:00Z');
    await store.recordSignIn(tenantId, u, at);
    expect((await store.listMembers(tenantId)).find((m) => m.id === u)?.lastSignInAt).toBe(at.toISOString());
  });

  it("cannot see or change another tenant's members (RLS)", async () => {
    const u = await add('mine@team.test', 'tenant_admin');
    const other = randomUUID();
    expect(await store.changeRole(other, u, 'tenant_owner')).toBe('not_found');
    expect(await store.removeMember(other, u)).toBe('not_found');
    expect((await store.listMembers(tenantId)).some((m) => m.id === u)).toBe(true);
  });
});
