/**
 * Proof pre-render queue on real Postgres (ADR 0015). Integration test: needs DATABASE_URL (app
 * role) and MIGRATION_DATABASE_URL (owner, to provision tenants); skipped without them.
 *
 * Proves what the in-memory repo can only imitate: concurrent claims never hand the same job to two
 * workers (FOR UPDATE SKIP LOCKED), duplicates are refused by the unique index, and one tenant can
 * neither see nor claim another's jobs (RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DrizzleLogoRepo, DrizzleProofJobRepo } from '@/server/repos/drizzle';
import type { LogoRecord, ProofJob } from '@/server/repos/types';

const HAS_DB = !!process.env.DATABASE_URL && !!process.env.MIGRATION_DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d('proof job queue (Postgres)', () => {
  const repo = new DrizzleProofJobRepo();
  const A = randomUUID();
  const B = randomUUID();
  const logoA = randomUUID();
  let owner: Pool;

  const logo = (id: string, tenantId: string): LogoRecord => ({
    id, tenantId, hash: `h-${id}`, knockoutEnclosed: true, sourceType: 'png', isVector: false, sourceSize: { width: 10, height: 10 },
    originalKey: `logos/${id}/original.png`, cleanKey: `logos/${id}/clean.png`,
    palette: { colors: [], colorCount: 1, isPhotographic: false },
    background: { removed: false, confidence: 'high', reason: 'test', enclosedRegions: 0 },
    recommendedMethods: [], warnings: [], needsReview: false, createdAt: new Date().toISOString(),
  });
  const job = (tenantId: string, key: string, at = '2026-09-10T12:00:00Z'): ProofJob => ({
    id: randomUUID(), tenantId, logoId: logoA, productSlug: 'classic-cotton-tee', colorHex: '#000000', method: 'screen_print', location: 'front',
    cacheKey: key, status: 'queued', attempts: 0, runAfter: at, lastError: null, createdAt: at, updatedAt: at,
  });

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.query(`insert into plans (key, label, rank) values ('free','Free',0) on conflict do nothing`);
    await owner.query(`insert into tenants (id, slug, name, plan_key) values ($1, $2, 'Jobs A', 'free'), ($3, $4, 'Jobs B', 'free')`, [A, `jobs-${A.slice(0, 8)}`, B, `jobs-${B.slice(0, 8)}`]);
    await new DrizzleLogoRepo().create(logo(logoA, A)); // as the app role, under RLS
  });

  afterAll(async () => {
    await owner.query(`delete from tenants where id = any($1)`, [[A, B]]); // cascades to logos and jobs
    await owner.end();
  });

  it('refuses a second job for the same proof', async () => {
    expect(await repo.enqueue(A, [job(A, 'dup'), job(A, 'dup')])).toBe(1);
    expect(await repo.enqueue(A, [job(A, 'dup')])).toBe(0);
  });

  it('concurrent claims never hand the same job to two workers', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `c-${i}`);
    expect(await repo.enqueue(A, keys.map((k) => job(A, k)))).toBe(40);
    const now = new Date('2026-09-10T12:00:01Z');
    const lease = new Date(now.getTime() + 60_000);
    // 8 workers at once, 6 each: 48 asks for 41 due jobs (40 + the 'dup' one).
    const batches = await Promise.all(Array.from({ length: 8 }, () => repo.claimDue(A, now, lease, 6)));
    const ids = batches.flat().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(41);
    expect(batches.flat().every((j) => j.status === 'running' && j.attempts === 1)).toBe(true);
    expect(await repo.claimDue(A, now, lease, 100)).toEqual([]); // all leased
    // Lease expiry makes them due again, attempt counted.
    const again = await repo.claimDue(A, new Date(lease.getTime() + 1), new Date(lease.getTime() + 60_000), 100);
    expect(again.length).toBe(41);
    expect(again.every((j) => j.attempts === 2)).toBe(true);
  });

  it('another tenant can neither see nor claim these jobs', async () => {
    expect(await repo.list(B)).toEqual([]);
    expect(await repo.pendingCount(B)).toBe(0);
    expect(await repo.claimDue(B, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:01:00Z'), 100)).toEqual([]);
    // Enqueue is scoped by the caller's tenant: a job carrying A's id is dropped, not written to A.
    expect(await repo.enqueue(B, [job(A, 'smuggled')])).toBe(0);
    expect((await repo.list(A)).some((j) => j.cacheKey === 'smuggled')).toBe(false);
  });

  it('finish and sweep', async () => {
    const [j] = await repo.list(A);
    await repo.finish(A, j!.id, { status: 'done' }, new Date('2026-09-10T12:05:00Z'));
    expect((await repo.list(A)).find((x) => x.id === j!.id)).toMatchObject({ status: 'done', lastError: null });
    expect(await repo.sweep(B, new Date('2100-01-01'))).toBe(0);
    expect(await repo.sweep(A, new Date('2026-09-10T12:04:00Z'))).toBe(0); // finished after the cutoff
    expect(await repo.sweep(A, new Date('2026-09-10T12:06:00Z'))).toBe(1);
  });
});
