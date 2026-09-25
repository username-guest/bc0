/**
 * Per-tenant CRM routing (ADR 0007, 0008).
 *
 * Webhook routing is a Pro entitlement: it is used only while `crm_webhook_routing` is on for the
 * tenant. A tenant that downgrades keeps its saved webhook settings but its leads go to the
 * BrandCanvas inbox until it upgrades again — the entitlement is checked on every delivery,
 * including retries of deliveries queued before the downgrade.
 */
import type { CrmProvider } from '@/shared/providers';
import { MockCrmProvider } from '@/shared/providers/mocks';
import { WebhookCrmProvider, type WebhookOptions } from '@/shared/providers/webhook-crm';
import type { TenantContext } from '@/server/tenancy/context';
import { DEFAULT_LEAD_SETTINGS } from '@/features/leads/rules';
import type { SecretBox } from '@/server/crypto/secret-box';

export type CrmRouter = (ctx: Pick<TenantContext, 'tenant' | 'can'>) => CrmProvider;

export function createCrmRouter(opts: {
  secrets: SecretBox;
  mock?: MockCrmProvider;
  allowInsecureWebhooks?: boolean;
  resolver?: WebhookOptions['resolver'];
}): CrmRouter {
  const mock = opts.mock ?? new MockCrmProvider();
  return (ctx) => {
    const r = (ctx.tenant.leads ?? DEFAULT_LEAD_SETTINGS).routing;
    if (r.provider !== 'webhook' || !ctx.can('crm_webhook_routing')) return mock;
    // Throws on a tampered/foreign ciphertext; the delivery records that as its failure reason.
    const secret = opts.secrets.open(r.secretSealed, ctx.tenant.id);
    return new WebhookCrmProvider(r.url, secret, {
      allowInsecure: opts.allowInsecureWebhooks ?? false,
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
    });
  };
}
