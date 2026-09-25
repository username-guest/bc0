import { describe, it, expect } from 'vitest';
import { runMaintenance, SESSION_RETENTION_MS, TOKEN_RETENTION_MS } from './jobs/maintenance';
import { MemoryAdminAuthStore, MemoryTenantDirectory } from './repos/memory';
import { MemoryWindowStore, type RateWindowStore } from './rate-limit';
import { fixtureAdmins, fixtureTenants } from './testing';

const NOW = Date.UTC(2030, 5, 1);
const at = (msAgo: number) => new Date(NOW - msAgo);
const DAY = 24 * 3_600_000;

async function seeded() {
  const admins = fixtureAdmins();
  const owner = admins.find((a) => a.email === 'owner@demo.test')!;
  const auth = new MemoryAdminAuthStore(admins);
  const tok = (id: string, expiresAgo: number, usedAgo: number | null) =>
    auth.createLoginToken({ id, tenantId: owner.tenantId, userId: owner.id, tokenHash: `h-${id}`, expiresAt: at(expiresAgo), createdAt: at(expiresAgo + 900_000) }).then(async () => {
      if (usedAgo !== null) await auth.consumeLoginToken(owner.tenantId, `h-${id}`, at(usedAgo));
    });
  await tok('live', -600_000, null); // expires in 10 min
  await tok('just-used', -600_000, 60_000); // used a minute ago: kept (troubleshooting window)
  await tok('old-used', -600_000 + 2 * DAY, 2 * DAY); // used 2 days ago
  await tok('old-expired', 2 * DAY, null);
  const sess = (id: string, expiresAgo: number, revokedAgo: number | null) =>
    auth.createSession({ id, tenantId: owner.tenantId, userId: owner.id, csrfToken: 'c', expiresAt: at(expiresAgo).toISOString(), tokenHash: `s-${id}`, createdAt: at(expiresAgo + DAY) }).then(async () => {
      if (revokedAgo !== null) await auth.revokeSession(owner.tenantId, id, at(revokedAgo));
    });
  await sess('live', -DAY, null);
  await sess('signed-out-yesterday', -DAY, DAY); // revoked 1 day ago: kept a week
  await sess('signed-out-long-ago', -DAY, 8 * DAY);
  await sess('expired-long-ago', 8 * DAY, null);
  return { auth, owner };
}

describe('maintenance', () => {
  it('deletes only stale tokens, sessions and rate windows', async () => {
    const { auth } = await seeded();
    const rateStore = new MemoryWindowStore();
    await rateStore.bump('old', 60_000, NOW - 2 * DAY);
    await rateStore.bump('fresh', 60_000, NOW - 60_000);
    const r = await runMaintenance({ directory: new MemoryTenantDirectory(fixtureTenants()), auth, rateStore, now: () => new Date(NOW) });
    expect(r).toMatchObject({ tokens: 2, sessions: 2, rateWindows: 1, errors: [] });
    expect(r.tenants).toBeGreaterThan(0);
    expect(auth.counts()).toEqual({ tokens: 2, sessions: 2 });
  });

  it('a live sign-in link still works after a sweep', async () => {
    const { auth, owner } = await seeded();
    await runMaintenance({ directory: new MemoryTenantDirectory(fixtureTenants()), auth, rateStore: new MemoryWindowStore(), now: () => new Date(NOW) });
    expect(await auth.consumeLoginToken(owner.tenantId, 'h-live', new Date(NOW))).toBe(owner.id);
    expect(await auth.findSession(owner.tenantId, 's-live', new Date(NOW))).not.toBeNull();
  });

  it('is idempotent', async () => {
    const { auth } = await seeded();
    const deps = { directory: new MemoryTenantDirectory(fixtureTenants()), auth, rateStore: new MemoryWindowStore(), now: () => new Date(NOW) };
    await runMaintenance(deps);
    expect(await runMaintenance(deps)).toMatchObject({ tokens: 0, sessions: 0, rateWindows: 0 });
  });

  it('one failing part is reported without stopping the rest', async () => {
    const { auth } = await seeded();
    const broken: RateWindowStore = { bump: async () => ({ count: 1, windowStart: 0 }), sweep: async () => { throw new Error('db down'); } };
    const r = await runMaintenance({ directory: new MemoryTenantDirectory(fixtureTenants()), auth, rateStore: broken, now: () => new Date(NOW) });
    expect(r.tokens).toBe(2);
    expect(r.errors).toEqual([{ scope: 'rate_limits', error: 'db down' }]);
  });

  it('retention windows are what the ADR says', () => {
    expect(TOKEN_RETENTION_MS).toBe(DAY);
    expect(SESSION_RETENTION_MS).toBe(7 * DAY);
  });
});
