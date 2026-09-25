/** Proof pre-rendering (ADR 0015): queue on upload, background renders, retries, leases, limits. */
import { describe, it, expect } from 'vitest';
import { buildFixture, ENT_TENANT_ID } from './testing';
import { handleTenantApi } from './http/router';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { MockStorageProvider } from '@/shared/providers/mocks';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { loadTenantContext } from './tenancy/context';
import { runMaintenance } from './jobs/maintenance';
import { MemoryWindowStore } from './rate-limit';
import { LEASE_MS, MAX_ATTEMPTS, MAX_PENDING_PER_TENANT, RETRY_MS, runProofJobs, startProofWorker } from './jobs/proofs';
import type { ProofJob } from './repos/types';

/** Storage whose proof writes can be made to fail (a flaky bucket). */
class FlakyStorage extends MockStorageProvider {
  failProofs = false;
  override async put(key: string, data: Uint8Array, contentType: string, tenantId: string) {
    if (this.failProofs && key.startsWith('proofs/')) throw new Error('bucket unavailable');
    return super.put(key, data, contentType, tenantId);
  }
}

function setup(opts: { storage?: MockStorageProvider; onProofJobsQueued?: () => void } = {}) {
  let now = new Date('2026-09-10T12:00:00Z');
  const fx = buildFixture({ now: () => now, ...opts });
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { fx, advance };
}
type Fx = ReturnType<typeof buildFixture>;

function client(fx: Fx, ref = 'demo') {
  let cookie = '';
  async function call(sub: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const req = new Request(`http://x/api/t/${ref}/${sub}`, { ...init, headers });
    const res = await handleTenantApi(req, ref, new URL(req.url).pathname.split('/').slice(4), { api: fx.api, directory: fx.directory });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  }
  return { call };
}

async function upload(c: ReturnType<typeof client>, knockout = true) {
  const form = new FormData();
  form.set('file', new Blob([encodePng(sampleLogo())], { type: 'image/png' }), 'logo.png');
  form.set('knockout', String(knockout));
  const r = await c.call('logos', { method: 'POST', body: form });
  return ((await r.json()) as { logo: { id: string } }).logo.id;
}

type Item = { slug: string; locked: boolean; proofUrl: string | null };
async function catalog(c: ReturnType<typeof client>, logo: string) {
  return ((await (await c.call(`catalog?logo=${logo}&qty=144`)).json()) as { items: Item[] }).items;
}
const ctxOf = async (fx: Fx, ref = 'demo') => (await loadTenantContext(ref, fx.directory))!;
const configOf = (url: string) => {
  const p = new URL(url, 'http://x').searchParams;
  return [p.get('product'), p.get('color')!.toUpperCase(), p.get('method'), p.get('location')].join('|');
};
const configOfJob = (j: ProofJob) => [j.productSlug, j.colorHex, j.method, j.location].join('|');

describe('queueing on upload', () => {
  it('queues exactly the configurations the default catalog view links to, once each', async () => {
    const { fx } = setup();
    const c = client(fx);
    const logo = await upload(c);
    const jobs = await fx.proofJobs.list(DEMO_TENANT_ID);
    const items = await catalog(c, logo);
    // One job per product in the view. Locked products are rendered too (not served until the
    // gate opens), so every configuration the catalog links to must be among the jobs.
    const expected = items.map((i) => i.proofUrl && configOf(i.proofUrl)).filter(Boolean);
    expect(expected.length).toBeGreaterThan(0);
    expect(jobs.length).toBe(items.length);
    for (const e of expected) expect(jobs.map(configOfJob)).toContain(e);
    expect(new Set(jobs.map((j) => j.cacheKey)).size).toBe(jobs.length);
    expect(jobs.every((j) => j.status === 'queued' && j.attempts === 0 && j.logoId === logo)).toBe(true);
  });

  it('uploading the same logo again queues nothing new; a different cleanup choice is a different proof', async () => {
    const { fx } = setup();
    const c = client(fx);
    await upload(c);
    const n = (await fx.proofJobs.list(DEMO_TENANT_ID)).length;
    await upload(c); // same bytes, same choice: deduplicated logo, deduplicated jobs
    expect((await fx.proofJobs.list(DEMO_TENANT_ID)).length).toBe(n);
    await upload(c, false); // keep enclosed areas: a different image, so different proofs
    expect((await fx.proofJobs.list(DEMO_TENANT_ID)).length).toBe(2 * n);
  });

  it('tells the worker to start at once', async () => {
    let nudged = 0;
    const { fx } = setup({ onProofJobsQueued: () => nudged++ });
    const c = client(fx);
    await upload(c);
    expect(nudged).toBe(1);
    await upload(c); // nothing new queued: no nudge
    expect(nudged).toBe(1);
  });

  it('stops queueing when a tenant already has too much pending work', async () => {
    const { fx } = setup();
    const at = new Date().toISOString();
    const filler: ProofJob[] = Array.from({ length: MAX_PENDING_PER_TENANT }, (_, i) => ({
      id: crypto.randomUUID(), tenantId: DEMO_TENANT_ID, logoId: crypto.randomUUID(), productSlug: 'x', colorHex: '#000000', method: 'screen_print', location: 'front',
      cacheKey: `filler-${i}`, status: 'queued', attempts: 0, runAfter: at, lastError: null, createdAt: at, updatedAt: at,
    }));
    await fx.proofJobs.enqueue(DEMO_TENANT_ID, filler);
    const logo = await upload(client(fx));
    expect((await fx.proofJobs.list(DEMO_TENANT_ID)).some((j) => j.logoId === logo)).toBe(false);
  });
});

describe('background rendering', () => {
  it('renders the queue so the catalog images come from the cache, and the lead gate still applies', async () => {
    const { fx } = setup();
    const c = client(fx);
    const logo = await upload(c);
    const r = await fx.api.proofQueue.runDue(await ctxOf(fx));
    const total = (await fx.proofJobs.list(DEMO_TENANT_ID)).length;
    expect(r).toMatchObject({ claimed: total, rendered: total, failed: 0, retried: 0 });
    expect((await fx.proofJobs.list(DEMO_TENANT_ID)).every((j) => j.status === 'done' && j.lastError === null)).toBe(true);

    const items = await catalog(c, logo);
    const open = items.filter((i) => !i.locked && i.proofUrl);
    for (const i of open) {
      const res = await c.call(i.proofUrl!.split('/api/t/demo/')[1]!);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-proof-cache')).toBe('hit');
    }
    // Pre-rendered is not pre-approved: a locked product is still refused until the email is given.
    const shut = items.find((i) => i.locked)!;
    const job = (await fx.proofJobs.list(DEMO_TENANT_ID)).find((j) => j.productSlug === shut.slug)!;
    expect(job.status).toBe('done'); // it IS rendered and cached...
    const q = new URLSearchParams({ logo, product: job.productSlug, color: job.colorHex, method: job.method, location: job.location });
    const locked = await c.call(`proofs?${q}`);
    expect(locked.status).toBe(403); // ...and still refused
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('lead_required');
  });

  it('a second pass finds nothing to do; a job for an already-cached proof finishes as a cache hit', async () => {
    const { fx } = setup();
    const c = client(fx);
    await upload(c);
    const ctx = await ctxOf(fx);
    await fx.api.proofQueue.runDue(ctx);
    expect((await fx.api.proofQueue.runDue(ctx)).claimed).toBe(0);
    // The same proofs due again (e.g. queued after their old jobs were swept): no re-rendering.
    const jobs = await fx.proofJobs.list(DEMO_TENANT_ID);
    for (const j of jobs) await fx.proofJobs.finish(DEMO_TENANT_ID, j.id, { status: 'queued', error: 'requeued', runAfter: new Date('2026-09-10T12:00:00Z') }, new Date('2026-09-10T12:00:00Z'));
    expect(await fx.api.proofQueue.runDue(ctx)).toMatchObject({ rendered: 0, cached: jobs.length });
  });

  it('retries a failing render twice with backoff, then gives up', async () => {
    const storage = new FlakyStorage();
    const { fx, advance } = setup({ storage });
    const c = client(fx);
    await upload(c);
    storage.failProofs = true;
    const ctx = await ctxOf(fx);
    const n = (await fx.proofJobs.list(DEMO_TENANT_ID)).length;

    expect(await fx.api.proofQueue.runDue(ctx)).toMatchObject({ claimed: n, retried: n });
    let jobs = await fx.proofJobs.list(DEMO_TENANT_ID);
    expect(jobs.every((j) => j.status === 'queued' && j.attempts === 1 && j.lastError === 'bucket unavailable')).toBe(true);
    expect((await fx.api.proofQueue.runDue(ctx)).claimed).toBe(0); // not due yet

    advance(RETRY_MS[0]);
    expect(await fx.api.proofQueue.runDue(ctx)).toMatchObject({ retried: n });
    advance(RETRY_MS[1]);
    expect(await fx.api.proofQueue.runDue(ctx)).toMatchObject({ failed: n });
    jobs = await fx.proofJobs.list(DEMO_TENANT_ID);
    expect(jobs.every((j) => j.status === 'failed' && j.attempts === MAX_ATTEMPTS)).toBe(true);
    // The on-demand path still works once storage recovers: pre-rendering is only a head start.
    storage.failProofs = false;
    const open = (await catalog(c, jobs[0]!.logoId)).find((i) => !i.locked && i.proofUrl)!;
    expect((await c.call(open.proofUrl!.split('/api/t/demo/')[1]!)).status).toBe(200);
  });

  it('a job that can never render fails at once without retrying', async () => {
    const { fx } = setup();
    const logo = await upload(client(fx));
    const at = new Date('2026-09-10T12:00:00Z').toISOString();
    const base = { tenantId: DEMO_TENANT_ID, logoId: logo, colorHex: '#000000', method: 'screen_print' as const, location: 'front', status: 'queued' as const, attempts: 0, runAfter: at, lastError: null, createdAt: at, updatedAt: at };
    await fx.proofJobs.enqueue(DEMO_TENANT_ID, [
      { ...base, id: crypto.randomUUID(), productSlug: 'discontinued-mug', cacheKey: 'gone-product' },
      { ...base, id: crypto.randomUUID(), logoId: crypto.randomUUID(), productSlug: 'classic-cotton-tee', cacheKey: 'gone-logo' },
    ]);
    await fx.api.proofQueue.runDue(await ctxOf(fx));
    const byKey = new Map((await fx.proofJobs.list(DEMO_TENANT_ID)).map((j) => [j.cacheKey, j]));
    expect(byKey.get('gone-product')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'not_renderable (404)' });
    expect(byKey.get('gone-logo')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'logo_not_found' });
  });
});

describe('leases, isolation and the worker', () => {
  it('two workers never claim the same job; a crashed worker\'s lease expires and the job is picked up again', async () => {
    const { fx, advance } = setup();
    await upload(client(fx));
    const now = new Date('2026-09-10T12:00:00Z');
    const lease = new Date(now.getTime() + LEASE_MS);
    const [a, b] = await Promise.all([fx.proofJobs.claimDue(DEMO_TENANT_ID, now, lease, 3), fx.proofJobs.claimDue(DEMO_TENANT_ID, now, lease, 3)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Worker A "crashes" holding its jobs. Before the lease ends nobody else takes them...
    const rest = await fx.proofJobs.claimDue(DEMO_TENANT_ID, now, lease, 100);
    expect(rest.some((j) => a.some((x) => x.id === j.id))).toBe(false);
    // ...after it, they come back with the attempt counted.
    advance(LEASE_MS + 1);
    const later = await fx.proofJobs.claimDue(DEMO_TENANT_ID, new Date(now.getTime() + LEASE_MS + 1), new Date(now.getTime() + 2 * LEASE_MS), 100);
    expect(later.filter((j) => a.some((x) => x.id === j.id)).every((j) => j.attempts === 2)).toBe(true);
  });

  it('a tenant\'s pass only touches its own queue', async () => {
    const { fx } = setup();
    await upload(client(fx, 'demo'));
    const r = await fx.api.proofQueue.runDue(await ctxOf(fx, 'bigco'));
    expect(r.claimed).toBe(0);
    expect((await fx.proofJobs.list(DEMO_TENANT_ID)).every((j) => j.status === 'queued')).toBe(true);
    expect(await fx.proofJobs.list(ENT_TENANT_ID)).toEqual([]);
  });

  it('the all-tenants pass renders everyone\'s queue and reports per tenant', async () => {
    const { fx } = setup();
    await upload(client(fx, 'demo'));
    await upload(client(fx, 'bigco'));
    const r = await runProofJobs({ directory: fx.directory, queue: fx.api.proofQueue });
    expect(r.errors).toEqual([]);
    expect(r.rendered).toBe((await fx.proofJobs.list(DEMO_TENANT_ID)).length + (await fx.proofJobs.list(ENT_TENANT_ID)).length);
  });

  it('the in-process worker starts on a nudge and finishes the queue', async () => {
    const { fx } = setup();
    const w = startProofWorker({ directory: fx.directory, queue: fx.api.proofQueue }, 60_000, () => {});
    try {
      await upload(client(fx));
      w.nudge();
      for (let i = 0; i < 200 && (await fx.proofJobs.list(DEMO_TENANT_ID)).some((j) => j.status !== 'done'); i++) await new Promise((r) => setTimeout(r, 10));
      expect((await fx.proofJobs.list(DEMO_TENANT_ID)).every((j) => j.status === 'done')).toBe(true);
    } finally {
      w.stop();
    }
  });

  it('maintenance deletes finished jobs after a week; the rendered images stay cached', async () => {
    const { fx } = setup();
    const c = client(fx);
    const logo = await upload(c);
    await fx.api.proofQueue.runDue(await ctxOf(fx));
    const deps = { directory: fx.directory, auth: fx.auth, rateStore: new MemoryWindowStore(), proofJobs: fx.proofJobs };
    expect((await runMaintenance({ ...deps, now: () => new Date('2026-09-12T12:00:00Z') })).proofJobs).toBe(0);
    const r = await runMaintenance({ ...deps, now: () => new Date('2026-09-18T12:00:01Z') });
    expect(r.proofJobs).toBeGreaterThan(0);
    expect(await fx.proofJobs.list(DEMO_TENANT_ID)).toEqual([]);
    const open = (await catalog(c, logo)).find((i) => !i.locked && i.proofUrl)!;
    expect((await c.call(open.proofUrl!.split('/api/t/demo/')[1]!)).headers.get('x-proof-cache')).toBe('hit');
  });
});
