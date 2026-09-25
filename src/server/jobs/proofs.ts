/**
 * Proof pre-rendering (ADR 0015). When a prospect uploads a logo, queue the proofs the catalog is
 * about to ask for (each product's recommended configuration in the default view), and render them
 * in the background so the first page of images comes from the cache.
 *
 * The queue is the tenant's `mockup_jobs` rows under RLS, claimed with a lease (FOR UPDATE SKIP
 * LOCKED in Postgres), so several workers can run at once. Rendering reuses the proof service:
 * same validation, same content-addressed cache as the on-demand endpoint.
 */
import { loadTenantContext, type TenantContext, type TenantDirectory } from '@/server/tenancy/context';
import type { LogoRecord, LogoRepo, ProductRepo, ProofJob, ProofJobRepo } from '@/server/repos/types';
import type { ProofService } from '@/server/http/proof-service';
import { searchCatalog, type CatalogQuery } from '@/features/catalog/catalog';

/** The first screen of the catalog, generously: the default view shows every product in order. */
export const PRERENDER_LIMIT = 24;
/** A tenant can't pile up unbounded work (uploads are rate-limited too). */
export const MAX_PENDING_PER_TENANT = 500;
export const MAX_ATTEMPTS = 3;
/** Waits before the 2nd and 3rd attempts. */
export const RETRY_MS = [30_000, 120_000] as const;
/** A claimed job not finished by then (crashed worker) becomes due again. */
export const LEASE_MS = 60_000;
export const JOB_RETENTION_MS = 7 * 24 * 3_600_000;
/** Must match the storefront's default quantity, or the plan renders the wrong configurations. */
export const DEFAULT_QUANTITY = 144;

export interface ProofQueueDeps {
  jobs: ProofJobRepo;
  products: ProductRepo;
  logos: LogoRepo;
  proofs: ProofService;
  now: () => Date;
  newId: () => string;
  /** Called after new jobs are queued (the inline worker uses it to start at once). */
  onQueued?: () => void;
  log?: (m: string) => void;
}

export interface RunResult {
  claimed: number;
  rendered: number;
  cached: number;
  failed: number;
  retried: number;
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

export function createProofQueue(d: ProofQueueDeps) {
  const log = d.log ?? ((m: string) => console.warn(m));

  /** The configurations the catalog's default view links to, in display order. */
  async function plan(ctx: TenantContext, logo: LogoRecord): Promise<ProofJob[]> {
    if (!ctx.can('brand_exact_proof')) return [];
    const q: CatalogQuery = {
      quantity: DEFAULT_QUANTITY,
      logo: { colorCount: logo.palette.colorCount, isPhotographic: logo.palette.isPhotographic },
      entitledMethods: ctx.methods,
      sort: 'recommended',
    };
    const products = await d.products.list(ctx.tenant.id);
    const bySlug = new Map(products.map((p) => [p.slug, p]));
    const at = d.now().toISOString();
    const out: ProofJob[] = [];
    for (const item of searchCatalog(products, q, ctx.tenant.pricingConfig).items.slice(0, PRERENDER_LIMIT)) {
      const product = bySlug.get(item.slug);
      const color = item.color.hex.toUpperCase();
      const variant = product?.colors.find((c) => c.hex.toUpperCase() === color);
      if (!product || !variant) continue;
      const cfg = { product, color, variant, method: item.recommended.method, location: item.recommended.location };
      out.push({
        id: d.newId(),
        tenantId: ctx.tenant.id,
        logoId: logo.id,
        productSlug: product.slug,
        colorHex: color,
        method: cfg.method,
        location: cfg.location,
        cacheKey: d.proofs.cacheKeyFor(logo, cfg),
        status: 'queued',
        attempts: 0,
        runAfter: at,
        lastError: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    return out;
  }

  /** Queue this logo's proofs. Never throws: an upload must not fail because pre-rendering did. */
  async function enqueueFor(ctx: TenantContext, logo: LogoRecord): Promise<number> {
    try {
      if ((await d.jobs.pendingCount(ctx.tenant.id)) >= MAX_PENDING_PER_TENANT) {
        log(`proofs: tenant ${ctx.tenant.id} has ${MAX_PENDING_PER_TENANT}+ pending renders; not queueing more`);
        return 0;
      }
      const added = await d.jobs.enqueue(ctx.tenant.id, await plan(ctx, logo));
      if (added) d.onQueued?.();
      return added;
    } catch (e) {
      log(`proofs: could not queue renders for tenant ${ctx.tenant.id}: ${(e as Error).message.slice(0, 200)}`);
      return 0;
    }
  }

  /**
   * Work through this tenant's due jobs until none are left or `budgetMs` is spent. Claims a few at
   * a time (a crash strands at most a small batch, for one lease) and yields between renders so
   * storefront requests on the same process keep being served.
   */
  async function runDue(ctx: TenantContext, opts: { budgetMs?: number; batch?: number } = {}): Promise<RunResult> {
    const out: RunResult = { claimed: 0, rendered: 0, cached: 0, failed: 0, retried: 0 };
    const started = Date.now();
    const budget = opts.budgetMs ?? 10_000;
    const tenantId = ctx.tenant.id;
    while (Date.now() - started < budget) {
      const now = d.now();
      const batch = await d.jobs.claimDue(tenantId, now, new Date(now.getTime() + LEASE_MS), opts.batch ?? 4);
      if (!batch.length) break;
      out.claimed += batch.length;
      for (const job of batch) {
        await yieldToEventLoop();
        const finish = (o: Parameters<ProofJobRepo['finish']>[2]) => d.jobs.finish(tenantId, job.id, o, d.now());
        try {
          const logo = await d.logos.get(tenantId, job.logoId);
          if (!logo) {
            await finish({ status: 'failed', error: 'logo_not_found' });
            out.failed++;
            continue;
          }
          // Re-validated now: the product may have been removed or the method taken off the plan.
          const resolved = await d.proofs.resolveConfiguration(ctx, { product: job.productSlug, color: job.colorHex, method: job.method, location: job.location });
          if (!resolved.ok) {
            await finish({ status: 'failed', error: `not_renderable (${resolved.response.status})` });
            out.failed++;
            continue;
          }
          const r = await d.proofs.getProof(ctx, logo, resolved.config);
          if (r.status === 'ready') {
            await finish({ status: 'done' });
            if (r.cache === 'hit') out.cached++;
            else out.rendered++;
          } else {
            // needs_placement or a missing logo image: rendering again won't change the answer.
            await finish({ status: 'failed', error: r.status === 'needs_placement' ? 'needs_placement' : `refused (${r.response.status})` });
            out.failed++;
          }
        } catch (e) {
          const error = (e as Error).message.slice(0, 200);
          if (job.attempts < MAX_ATTEMPTS) {
            await finish({ status: 'queued', error, runAfter: new Date(d.now().getTime() + RETRY_MS[job.attempts - 1]!) });
            out.retried++;
          } else {
            await finish({ status: 'failed', error });
            out.failed++;
          }
        }
      }
    }
    return out;
  }

  return { plan, enqueueFor, runDue };
}

export type ProofQueue = ReturnType<typeof createProofQueue>;

/** One pass over every tenant. One tenant's failure never stops the others. */
export async function runProofJobs(deps: { directory: TenantDirectory; queue: ProofQueue; budgetMs?: number }) {
  const out = { tenants: 0, claimed: 0, rendered: 0, cached: 0, failed: 0, retried: 0, errors: [] as { tenant: string; error: string }[] };
  for (const slug of await deps.directory.listSlugs()) {
    try {
      const ctx = await loadTenantContext(slug, deps.directory);
      if (!ctx) continue;
      out.tenants++;
      const r = await deps.queue.runDue(ctx, { budgetMs: deps.budgetMs ?? 10_000 });
      out.claimed += r.claimed;
      out.rendered += r.rendered;
      out.cached += r.cached;
      out.failed += r.failed;
      out.retried += r.retried;
    } catch (e) {
      out.errors.push({ tenant: slug, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/**
 * In-process worker for single-node deploys: a timer, plus `nudge()` to start at once after an
 * upload. Never overlaps itself; a nudge during a pass schedules one more pass.
 */
export function startProofWorker(
  deps: { directory: TenantDirectory; queue: ProofQueue },
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
        const r = await runProofJobs(deps);
        for (const e of r.errors) log(`proofs: tenant ${e.tenant}: ${e.error}`);
      } while (again && !stopped);
    } catch (e) {
      log(`proofs: worker pass failed: ${(e as Error).message.slice(0, 200)}`);
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
