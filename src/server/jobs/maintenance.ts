/**
 * Maintenance (ADR 0010): deletes what has served its purpose so the auth and rate-limit tables
 * stay small. Idempotent and safe to run from several processes at once (plain DELETEs).
 *
 *   - sign-in tokens: expired or used more than TOKEN_RETENTION ago
 *   - admin sessions: expired or revoked more than SESSION_RETENTION ago (kept a week for
 *     troubleshooting "why was I signed out?")
 *   - rate-limit windows: started more than RATE_WINDOW_RETENTION ago (longest window is 15 min)
 *   - funnel events (ADR 0014): days older than RETENTION_DAYS (the longest report is a year)
 *   - finished proof jobs (ADR 0015): done or failed more than a week ago (the images stay cached)
 *
 * One tenant's failure never stops the others.
 */
import { loadTenantContext, type TenantDirectory } from '@/server/tenancy/context';
import type { AdminAuthStore } from '@/server/admin/types';
import type { RateWindowStore } from '@/server/rate-limit';
import type { AnalyticsRepo, ProofJobRepo } from '@/server/repos/types';
import { JOB_RETENTION_MS } from './proofs';
import { RETENTION_DAYS, utcDay } from '@/features/analytics/funnel';

export const TOKEN_RETENTION_MS = 24 * 3_600_000;
export const SESSION_RETENTION_MS = 7 * 24 * 3_600_000;
export const RATE_WINDOW_RETENTION_MS = 24 * 3_600_000;

export interface MaintenanceDeps {
  directory: TenantDirectory;
  auth: AdminAuthStore;
  rateStore: RateWindowStore;
  /** Optional so older callers keep working; production always passes it. */
  analytics?: AnalyticsRepo;
  proofJobs?: ProofJobRepo;
  now?: () => Date;
}

export interface MaintenanceResult {
  tenants: number;
  tokens: number;
  sessions: number;
  rateWindows: number;
  analyticsEvents: number;
  proofJobs: number;
  errors: { scope: string; error: string }[];
}

export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const out: MaintenanceResult = { tenants: 0, tokens: 0, sessions: 0, rateWindows: 0, analyticsEvents: 0, proofJobs: 0, errors: [] };
  const eventsBefore = utcDay(new Date(now - RETENTION_DAYS * 86_400_000));
  const cutoffs = { tokensBefore: new Date(now - TOKEN_RETENTION_MS), sessionsBefore: new Date(now - SESSION_RETENTION_MS) };
  for (const slug of await deps.directory.listSlugs()) {
    try {
      const ctx = await loadTenantContext(slug, deps.directory);
      if (!ctx) continue;
      out.tenants++;
      const r = await deps.auth.sweep(ctx.tenant.id, cutoffs);
      out.tokens += r.tokens;
      out.sessions += r.sessions;
      if (deps.analytics) out.analyticsEvents += await deps.analytics.sweep(ctx.tenant.id, eventsBefore);
      if (deps.proofJobs) out.proofJobs += await deps.proofJobs.sweep(ctx.tenant.id, new Date(now - JOB_RETENTION_MS));
    } catch (e) {
      out.errors.push({ scope: `tenant ${slug}`, error: (e as Error).message.slice(0, 200) });
    }
  }
  try {
    out.rateWindows = await deps.rateStore.sweep(now - RATE_WINDOW_RETENTION_MS);
  } catch (e) {
    out.errors.push({ scope: 'rate_limits', error: (e as Error).message.slice(0, 200) });
  }
  return out;
}

/** In-process maintenance for single-node deploys. Never overlaps itself; doesn't hold the process open. */
export function startMaintenanceWorker(deps: MaintenanceDeps, intervalMs: number, log: (msg: string) => void = (m) => console.warn(m)): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runMaintenance(deps);
      for (const e of r.errors) log(`[maintenance] ${e.scope}: ${e.error}`);
    } catch (e) {
      log(`[maintenance] run failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
