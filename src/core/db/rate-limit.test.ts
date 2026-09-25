/**
 * Shared rate-limit store against real Postgres, as the app role (ADR 0010).
 * INTEGRATION test: skipped without DATABASE_URL, like rls.test.ts.
 *
 * The property that matters is atomicity: many app instances hit the same key at once and every
 * hit must be counted exactly once, or a scaled-out deployment leaks past its limits.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DrizzleRateWindowStore } from '@/server/repos/drizzle';
import { FixedWindowLimiter } from '@/server/rate-limit';

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d('Postgres rate-limit store', () => {
  const store = new DrizzleRateWindowStore();

  it('counts 50 concurrent hits exactly once each', async () => {
    const key = `test:${randomUUID()}`;
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.bump(key, 60_000, now)));
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.windowStart)).size).toBe(1);
  });

  it('starts a fresh window once the old one has elapsed', async () => {
    const key = `test:${randomUUID()}`;
    const t0 = Date.now() - 10_000; // in the past, so maintenance can remove the row later
    expect((await store.bump(key, 1000, t0)).count).toBe(1);
    expect((await store.bump(key, 1000, t0 + 999)).count).toBe(2);
    const fresh = await store.bump(key, 1000, t0 + 1000);
    expect(fresh).toEqual({ count: 1, windowStart: t0 + 1000 });
  });

  it('enforces a limit shared by two limiter instances (two app servers)', async () => {
    const name = `test-${randomUUID()}`;
    const a = new FixedWindowLimiter(2, 60_000, { store, name });
    const b = new FixedWindowLimiter(2, 60_000, { store, name });
    expect((await a.hit('ip')).ok).toBe(true);
    expect((await b.hit('ip')).ok).toBe(true);
    expect((await a.hit('ip')).ok).toBe(false);
  });

  it('sweep deletes only windows that started before the cutoff', async () => {
    const oldKey = `test:${randomUUID()}`;
    const newKey = `test:${randomUUID()}`;
    const past = Date.UTC(2000, 0, 1);
    await store.bump(oldKey, 1000, past);
    await store.bump(newKey, 60_000, Date.now());
    expect(await store.sweep(past + 1)).toBeGreaterThanOrEqual(1);
    expect((await store.bump(oldKey, 1000, past + 10)).count).toBe(1); // it was gone
    expect((await store.bump(newKey, 60_000, Date.now())).count).toBe(2); // it survived
  });
});
