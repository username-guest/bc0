/**
 * Funnel tracking for the storefront API (ADR 0014). Recording is best-effort: an analytics
 * failure is logged and never fails the prospect's request.
 */
import type { TenantContext } from '@/server/tenancy/context';
import type { AnalyticsRepo, FunnelStage } from '@/server/repos/types';
import type { ProspectSession } from '@/server/session';
import { parseSrc, utcDay } from '@/features/analytics/funnel';

/** Crawlers and link-preview fetchers that happen to run scripts shouldn't count as visitors. */
const NOT_A_VISITOR = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview/i;

export function createTracker(analytics: AnalyticsRepo, now: () => Date, log: (m: string) => void = (m) => console.warn(m)) {
  async function track(ctx: TenantContext, s: ProspectSession, kind: FunnelStage): Promise<void> {
    try {
      const e = { tenantId: ctx.tenant.id, day: utcDay(now()), sessionId: s.id, linkId: s.linkId ?? null };
      // Anyone who saw a proof or became a lead today was a visitor today, even if the page was
      // opened yesterday and left open (no beacon today). Keeps every rate at or below 100%.
      if (kind !== 'visit') await analytics.record({ ...e, kind: 'visit' });
      await analytics.record({ ...e, kind });
    } catch (e) {
      log(`analytics: could not record ${kind} for tenant ${ctx.tenant.id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /**
   * First touch: attach the link named by ?src= to a session that has none yet. Returns true when
   * the session changed. Unknown, archived or malformed codes are ignored, as are links on plans
   * without tracked links.
   */
  async function attribute(ctx: TenantContext, s: ProspectSession, rawSrc: unknown): Promise<boolean> {
    if (s.linkId || !ctx.can('shareable_tracked_links')) return false;
    const code = parseSrc(rawSrc);
    if (!code) return false;
    try {
      const link = await analytics.findActiveLinkByCode(ctx.tenant.id, code);
      if (!link) return false;
      s.linkId = link.id;
      return true;
    } catch (e) {
      log(`analytics: link lookup failed for tenant ${ctx.tenant.id}: ${(e as Error).message.slice(0, 200)}`);
      return false;
    }
  }

  /** For lead records and CRM payloads: which link brought this prospect, if any. */
  async function linkInfo(ctx: TenantContext, s: ProspectSession): Promise<{ code: string; label: string } | null> {
    if (!s.linkId) return null;
    try {
      const l = await analytics.getLink(ctx.tenant.id, s.linkId);
      return l ? { code: l.code, label: l.label } : null;
    } catch {
      return null;
    }
  }

  const isVisitor = (req: Request) => !NOT_A_VISITOR.test(req.headers.get('user-agent') ?? '');

  return { track, attribute, linkInfo, isVisitor };
}

export type Tracker = ReturnType<typeof createTracker>;
