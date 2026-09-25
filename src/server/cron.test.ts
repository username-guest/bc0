/** Scheduled jobs over HTTP (ADR 0018). */
import { describe, it, expect } from 'vitest';
import { handleCron, type CronJob } from './jobs/cron';
import { readFileSync } from 'node:fs';

const SECRET = 'c'.repeat(40);
const req = (auth?: string, method = 'GET') => new Request('https://x.vercel.app/api/cron/deliveries', { method, headers: auth ? { authorization: auth } : {} });

describe('cron endpoints', () => {
  it("don't exist until CRON_SECRET is set", async () => {
    let ran = false;
    const r = await handleCron(req(`Bearer ${SECRET}`), 'deliveries', undefined, async () => ((ran = true), { errors: [] }));
    expect(r.status).toBe(404);
    expect(ran).toBe(false);
  });

  it('refuse a missing, wrong or near-miss token without running anything', async () => {
    let ran = 0;
    const run = async () => (ran++, { errors: [] });
    for (const auth of [undefined, 'Bearer nope', `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, SECRET, `bearer ${SECRET}`]) {
      expect((await handleCron(req(auth), 'deliveries', SECRET, run)).status, String(auth)).toBe(401);
    }
    expect((await handleCron(req(`Bearer ${SECRET}`, 'POST'), 'deliveries', SECRET, run)).status).toBe(405);
    expect(ran).toBe(0);
  });

  it('run a known job, and report its errors as 500 so the scheduler flags them', async () => {
    const seen: CronJob[] = [];
    const ok = await handleCron(req(`Bearer ${SECRET}`), 'maintenance', SECRET, async (j) => (seen.push(j), { errors: [], tenants: 3 } as { errors: unknown[] }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ job: 'maintenance', tenants: 3, errors: [] });
    const bad = await handleCron(req(`Bearer ${SECRET}`), 'proofs', SECRET, async () => ({ errors: [{ tenant: 'demo', error: 'boom' }] }));
    expect(bad.status).toBe(500);
    const thrown = await handleCron(req(`Bearer ${SECRET}`), 'suppliers', SECRET, async () => {
      throw new Error('db down');
    });
    expect(thrown.status).toBe(500);
    expect(await thrown.json()).toMatchObject({ errors: [{ error: 'db down' }] });
    expect((await handleCron(req(`Bearer ${SECRET}`), 'rm-rf', SECRET, async () => ({ errors: [] }))).status).toBe(404);
    expect(seen).toEqual(['maintenance']);
  });

  it('bypass tenant routing (they must answer on any host), while tenant pages still go through it', () => {
    // Next requires the matcher to be a literal in middleware.ts, so read it from there.
    const src = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');
    const literal = /matcher:\s*\['([^']+)'\]/.exec(src)![1]!.replace(/\\\\/g, '\\');
    const inner = new RegExp(`^${literal}$`);
    expect(inner.test('/api/cron/deliveries')).toBe(false);
    expect(inner.test('/api/t/demo/catalog')).toBe(true);
    expect(inner.test('/t/demo/admin')).toBe(true);
    expect(inner.test('/api/crony')).toBe(true); // only the exact prefix is exempt
  });
});
