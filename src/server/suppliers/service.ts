/**
 * Supplier catalog sync (ADR 0017): run a connection's PromoStandards pull and write the result
 * into the tenant's catalog.
 *
 * - A sync is requested (status → queued) by an owner, or becomes due for the daily refresh; a
 *   worker runs it (status → running, the lock) and records a summary (ok / partial / failed).
 * - The plan is checked when the run starts, not only when it was requested: a tenant that
 *   dropped below Enterprise gets a failed run with that reason, and its products stay as they were.
 * - Products the supplier no longer sells are hidden, not deleted, and only when the run saw the
 *   whole list (not capped) — a product that errored this run is kept as it was.
 */
import { loadTenantContext, type TenantContext, type TenantDirectory } from '@/server/tenancy/context';
import type { SecretBox } from '@/server/crypto/secret-box';
import type { SupplierCatalogWriter, SupplierConnectionRecord, SupplierRepo, SupplierSyncSummary } from '@/server/repos/types';
import type { SoapPost } from '@/integrations/promostandards/soap';
import { SoapError } from '@/integrations/promostandards/soap';
import { fetchSupplierCatalog } from '@/integrations/promostandards/catalog';

export const SUPPLIER_FLAG = 'promostandards_live' as const;
/** A run that hasn't finished by then (crashed worker) can be taken over. */
export const SYNC_LOCK_MS = 30 * 60_000;
export const REFRESH_MS = 24 * 3_600_000;
export const MAX_PRODUCTS_PER_RUN = 500;
const MAX_NOTES = 200;
const MAX_NOTE_CHARS = 300;

export interface SupplierServiceDeps {
  suppliers: SupplierRepo;
  catalog: SupplierCatalogWriter;
  secrets: SecretBox;
  /** Per connection, so tests (and the dev fake supplier) can substitute transports. */
  post: SoapPost;
  now: () => Date;
  /** Called after a sync is queued (the inline worker starts at once). */
  onQueued?: () => void;
  log?: (m: string) => void;
}

const clip = (s: string) => (s.length > MAX_NOTE_CHARS ? `${s.slice(0, MAX_NOTE_CHARS - 1)}…` : s);

export function createSupplierService(d: SupplierServiceDeps) {
  const log = d.log ?? ((m: string) => console.warn(m));

  /** Owner pressed "Sync now". False when a sync is already queued or running. */
  async function requestSync(ctx: TenantContext, id: string): Promise<boolean> {
    const ok = await d.suppliers.transition(ctx.tenant.id, id, ['never', 'ok', 'partial', 'failed'], 'queued', d.now());
    if (ok) d.onQueued?.();
    return ok;
  }

  async function fail(tenantId: string, id: string, error: string): Promise<SupplierSyncSummary> {
    const summary: SupplierSyncSummary = { at: d.now().toISOString(), created: 0, updated: 0, hidden: 0, skipped: 0, failed: 0, remaining: 0, error: clip(error), notes: [] };
    await d.suppliers.finish(tenantId, id, 'failed', summary);
    return summary;
  }

  /** Run one connection now, if nobody else is. Returns null when it was locked. */
  async function run(ctx: TenantContext, id: string): Promise<SupplierSyncSummary | null> {
    const tenantId = ctx.tenant.id;
    const now = d.now();
    const claimed = await d.suppliers.transition(tenantId, id, ['queued', 'never', 'ok', 'partial', 'failed'], 'running', now, new Date(now.getTime() - SYNC_LOCK_MS));
    if (!claimed) return null;
    const conn = await d.suppliers.get(tenantId, id);
    if (!conn) return null;
    if (!ctx.can(SUPPLIER_FLAG)) return fail(tenantId, id, 'Supplier connections are not included in your plan, so this sync did not run. Your imported products are unchanged.');

    let password: string;
    try {
      password = d.secrets.open(conn.passwordSealed, tenantId);
    } catch {
      return fail(tenantId, id, 'The saved password could not be read. Enter it again and save.');
    }
    try {
      const r = await fetchSupplierCatalog(d.post, {
        endpoints: { productData: conn.productDataUrl, pricing: conn.pricingUrl },
        credentials: { id: conn.accountId, password },
        currency: conn.currency,
        priceType: conn.priceType,
        ...(conn.fobId ? { fobId: conn.fobId } : {}),
        ...(conn.productIds.length ? { productIds: conn.productIds } : {}),
        maxProducts: MAX_PRODUCTS_PER_RUN,
      });
      const applied = await d.catalog.applySupplierImport(tenantId, id, r.imported, {
        // Only a run that saw everything may hide what's missing.
        hideMissing: r.remaining === 0,
        keep: r.failed.map((f) => f.supplierProductId),
      });
      const notes = [
        ...r.failed.map((f) => `Couldn't fetch ${f.supplierProductId}: ${f.error}`),
        ...r.skipped.map((s) => `Not imported: ${s.reason}`),
        ...r.notes,
      ];
      if (r.remaining) notes.unshift(`${r.remaining} more products weren't looked at; a run handles ${MAX_PRODUCTS_PER_RUN}. Pick the products you want to narrow it.`);
      const summary: SupplierSyncSummary = {
        at: d.now().toISOString(),
        ...applied,
        skipped: r.skipped.length,
        failed: r.failed.length,
        remaining: r.remaining,
        notes: notes.slice(0, MAX_NOTES).map(clip),
      };
      await d.suppliers.finish(tenantId, id, r.failed.length || r.remaining ? 'partial' : 'ok', summary);
      return summary;
    } catch (e) {
      const msg = e instanceof SoapError && e.kind === 'service' ? `The supplier refused the request: ${e.message}` : (e as Error).message;
      log(`suppliers: ${tenantId}/${id}: ${msg.slice(0, 200)}`);
      return fail(tenantId, id, msg);
    }
  }

  /** Worker pass for one tenant: queued runs, stale locks, and the daily refresh. */
  async function runDue(ctx: TenantContext): Promise<number> {
    if (!ctx.can(SUPPLIER_FLAG)) {
      // Queued requests still get an answer; the daily refresh just stops.
      const now = d.now();
      for (const id of await d.suppliers.due(ctx.tenant.id, new Date(0), new Date(now.getTime() - SYNC_LOCK_MS))) await run(ctx, id);
      return 0;
    }
    const now = d.now();
    let n = 0;
    for (const id of await d.suppliers.due(ctx.tenant.id, new Date(now.getTime() - REFRESH_MS), new Date(now.getTime() - SYNC_LOCK_MS))) {
      if (await run(ctx, id)) n++;
    }
    return n;
  }

  return { requestSync, run, runDue };
}

export type SupplierService = ReturnType<typeof createSupplierService>;

export async function runSupplierSyncs(deps: { directory: TenantDirectory; service: SupplierService }) {
  const out = { tenants: 0, runs: 0, errors: [] as { tenant: string; error: string }[] };
  for (const slug of await deps.directory.listSlugs()) {
    try {
      const ctx = await loadTenantContext(slug, deps.directory);
      if (!ctx) continue;
      out.tenants++;
      out.runs += await deps.service.runDue(ctx);
    } catch (e) {
      out.errors.push({ tenant: slug, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** In-process worker for single-node deploys and dev: a timer, plus `nudge()` after a request. */
export function startSupplierWorker(
  deps: { directory: TenantDirectory; service: SupplierService },
  intervalMs: number,
  log: (msg: string) => void = (m) => console.warn(m),
): { stop: () => void; nudge: () => void } {
  let running = false;
  let again = false;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const r = await runSupplierSyncs(deps);
        for (const e of r.errors) log(`suppliers: tenant ${e.tenant}: ${e.error}`);
      } while (again && !stopped);
    } catch (e) {
      log(`suppliers: worker pass failed: ${(e as Error).message.slice(0, 200)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    nudge: () => void setTimeout(() => void tick(), 0),
  };
}

/** What the admin sees: never the password. */
export function connectionDto(c: SupplierConnectionRecord) {
  return {
    id: c.id,
    name: c.name,
    productDataUrl: c.productDataUrl,
    pricingUrl: c.pricingUrl,
    accountId: c.accountId,
    hasPassword: !!c.passwordSealed,
    currency: c.currency,
    priceType: c.priceType,
    fobId: c.fobId,
    productIds: c.productIds,
    status: c.status,
    lastSync: c.lastSync,
    createdAt: c.createdAt,
  };
}
