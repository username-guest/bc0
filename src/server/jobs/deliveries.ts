/**
 * Scheduled CRM delivery retries (ADR 0008). Walks every tenant and attempts its due deliveries.
 * One tenant's failure (bad settings, DB hiccup) never stops the others. Claims are leased in
 * the repo, so running this from several processes at once is safe.
 */
import { loadTenantContext, type TenantDirectory } from '@/server/tenancy/context';
import type { DeliveryService } from '@/server/leads/delivery';

export interface RetryRunResult {
  tenants: number;
  attempted: number;
  delivered: number;
  errors: { tenant: string; error: string }[];
}

export async function runDeliveryRetries(deps: { directory: TenantDirectory; delivery: DeliveryService }): Promise<RetryRunResult> {
  const out: RetryRunResult = { tenants: 0, attempted: 0, delivered: 0, errors: [] };
  for (const slug of await deps.directory.listSlugs()) {
    try {
      const ctx = await loadTenantContext(slug, deps.directory);
      if (!ctx) continue;
      out.tenants++;
      const r = await deps.delivery.runDue(ctx);
      out.attempted += r.attempted;
      out.delivered += r.delivered;
    } catch (e) {
      out.errors.push({ tenant: slug, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** In-process worker for single-node deploys. Never overlaps itself; the timer doesn't hold the process open. */
export function startDeliveryWorker(
  deps: { directory: TenantDirectory; delivery: DeliveryService },
  intervalMs: number,
  log: (msg: string) => void = (m) => console.warn(m),
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runDeliveryRetries(deps);
      for (const e of r.errors) log(`[deliveries] tenant ${e.tenant}: ${e.error}`);
    } catch (e) {
      log(`[deliveries] run failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
