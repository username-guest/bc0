/**
 * Lead delivery (ADR 0008): the outbox between "lead stored" and "lead in the tenant's CRM".
 *
 * Every capture creates one delivery row with the exact payload, then attempts it immediately.
 * Failures are retried on a backoff schedule by `runDue` (a scheduled job) until they succeed or
 * exhaust MAX_ATTEMPTS and become `dead` — still visible in the admin inbox, where an admin can
 * retry by hand. The lead itself is never at risk: it was stored before any of this runs.
 *
 * Each attempt re-resolves the CRM through the router, so entitlement and settings changes apply
 * to retries too. Payloads carry `deliveryId` so receivers can dedupe a re-sent delivery.
 */
import type { LeadPayload } from '@/shared/providers';
import type { TenantContext } from '@/server/tenancy/context';
import type { CrmRouter } from '@/server/crm';
import type { DeliveryRepo, LeadDelivery, LeadRepo, LeadSource } from '@/server/repos/types';

/** Wait before attempt n+1 after n failures (index n-1). Five retries over ~15 h, then dead. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** How long a claimed delivery is hidden from other workers while being attempted. */
const LEASE_MS = 60_000;

type Ctx = Pick<TenantContext, 'tenant' | 'can'>;

export interface DeliveryDeps {
  deliveries: DeliveryRepo;
  leads: LeadRepo;
  crmFor: CrmRouter;
  now: () => Date;
  newId: () => string;
}

export function createDeliveryService(d: DeliveryDeps) {
  async function attempt(ctx: Ctx, del: LeadDelivery): Promise<LeadDelivery> {
    const tenantId = ctx.tenant.id;
    const attempts = del.attempts + 1;
    try {
      const r = await d.crmFor(ctx).route({ ...(del.payload as unknown as LeadPayload), deliveryId: del.id });
      const at = d.now().toISOString();
      const patch = { status: 'delivered' as const, attempts, nextAttemptAt: null, routedTo: r.routedTo, updatedAt: at };
      await d.deliveries.update(tenantId, del.id, patch);
      await d.leads.addEvent({
        id: d.newId(),
        tenantId,
        leadId: del.leadId,
        kind: 'routed',
        payload: { routedTo: r.routedTo, source: del.source, deliveryId: del.id, attempt: attempts },
        createdAt: at,
      });
      return { ...del, ...patch };
    } catch (e) {
      const now = d.now();
      const error = ((e as Error).message || 'Delivery failed').slice(0, 300);
      const dead = attempts >= MAX_ATTEMPTS;
      const next = dead ? null : new Date(now.getTime() + BACKOFF_MS[attempts - 1]!).toISOString();
      const patch = { status: dead ? ('dead' as const) : ('failed' as const), attempts, nextAttemptAt: next, lastError: error, updatedAt: now.toISOString() };
      await d.deliveries.update(tenantId, del.id, patch);
      await d.leads.addEvent({
        id: d.newId(),
        tenantId,
        leadId: del.leadId,
        kind: 'routing_failed',
        payload: { error, source: del.source, deliveryId: del.id, attempt: attempts, final: dead, ...(next ? { nextAttemptAt: next } : {}) },
        createdAt: now.toISOString(),
      });
      return { ...del, ...patch };
    }
  }

  return {
    attempt,

    /** Queue a delivery for a freshly captured lead and try it right away. Never throws. */
    async enqueue(ctx: Ctx, leadId: string, source: LeadSource, payload: LeadPayload): Promise<LeadDelivery> {
      const at = d.now().toISOString();
      const del: LeadDelivery = {
        id: d.newId(),
        tenantId: ctx.tenant.id,
        leadId,
        source,
        payload: payload as unknown as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      };
      await d.deliveries.create(del);
      return attempt(ctx, del);
    },

    /** Scheduled job body for one tenant: attempt everything that's due. */
    async runDue(ctx: Ctx, limit = 50): Promise<{ attempted: number; delivered: number }> {
      const now = d.now();
      const due = await d.deliveries.claimDue(ctx.tenant.id, now, new Date(now.getTime() + LEASE_MS), limit);
      let delivered = 0;
      for (const del of due) if ((await attempt(ctx, del)).status === 'delivered') delivered++;
      return { attempted: due.length, delivered };
    },

    /** Admin "retry now": allowed for failed and dead deliveries; resets nothing but the clock. */
    async retryNow(ctx: Ctx, deliveryId: string): Promise<LeadDelivery | null> {
      const del = await d.deliveries.get(ctx.tenant.id, deliveryId);
      if (!del || (del.status !== 'failed' && del.status !== 'dead')) return null;
      // A dead delivery gets one more attempt; its count is already past the limit, so a
      // failure leaves it dead rather than re-entering the backoff schedule.
      return attempt(ctx, del);
    },
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
