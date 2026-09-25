/**
 * Per-request tenant context: who the tenant is, what they're entitled to, and their public
 * branding. Built on the server only; the flag snapshot is the single source of truth for every
 * gate in the request (the client gets a copy purely for presentation — §6).
 */
import type { TenantPricingConfig, DecorationMethodKey } from '@/pricing/types';
import type { Plan } from '@/flags/registry';
import { DEFAULT_LEAD_SETTINGS, type LeadSettings } from '@/features/leads/rules';
import { buildFlagSnapshot } from '@/flags/evaluate';
import { entitledMethods, type FlagSnapshot } from '@/flags/entitlements';
import { parseInternalRef } from './resolve';

export interface TenantBranding {
  displayName: string;
  primaryHex: string;
  secondaryHex: string;
  fontFamily: string;
  logoUrl?: string;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  plan: Plan;
  customDomain?: string;
  branding: TenantBranding;
  pricingConfig: TenantPricingConfig;
  flagOverrides: Record<string, boolean>;
  /** Gate, CRM routing, contact. Optional so older records fall back to DEFAULT_LEAD_SETTINGS. */
  leads?: LeadSettings;
}

export interface TenantDirectory {
  findBySlug(slug: string): Promise<TenantRecord | null>;
  findByDomain(domain: string): Promise<TenantRecord | null>;
  /** Every tenant slug, for background jobs (delivery retries). */
  listSlugs(): Promise<string[]>;
  /** Platform-wide kill switches (platform_admin). */
  globalKillSwitches(): Promise<ReadonlySet<string>>;
}

export interface TenantContext {
  tenant: TenantRecord;
  ref: string; // internal ref used in URLs (slug or @domain)
  flags: FlagSnapshot;
  methods: DecorationMethodKey[];
  can(key: keyof FlagSnapshot): boolean;
}

const DEFAULT_BRANDING: Omit<TenantBranding, 'displayName'> = {
  primaryHex: '#1F45C6',
  secondaryHex: '#111827',
  fontFamily: 'Inter',
};

/**
 * Resolve an internal ref to a context, or null (→ 404). Custom domains only resolve while the
 * tenant is entitled to `custom_domain` — a downgraded tenant's domain stops serving rather than
 * silently keeping an Enterprise feature.
 */
export async function loadTenantContext(ref: string, dir: TenantDirectory): Promise<TenantContext | null> {
  const parsed = parseInternalRef(ref);
  if (!parsed) return null;
  const tenant = 'slug' in parsed ? await dir.findBySlug(parsed.slug) : await dir.findByDomain(parsed.domain);
  if (!tenant) return null;

  const flags = buildFlagSnapshot({
    plan: tenant.plan,
    globalKillSwitches: await dir.globalKillSwitches(),
    tenantOverrides: tenant.flagOverrides,
  });
  if ('domain' in parsed && !flags.custom_domain.enabled) return null;

  // White-label branding is a Starter feature: Free tenants get platform defaults + their name.
  const branding: TenantBranding = flags.custom_branding.enabled
    ? tenant.branding
    : { displayName: tenant.branding.displayName, ...DEFAULT_BRANDING };

  const ctx: TenantContext = {
    tenant: { ...tenant, branding },
    ref: 'slug' in parsed ? tenant.slug : `@${parsed.domain}`,
    flags,
    methods: entitledMethods(flags),
    can: (key) => flags[key].enabled,
  };
  return ctx;
}

/** What the browser may see: branding + presentation snapshot. Never pricing config/overrides. */
/** Effective lead settings: tenant's own, else defaults; hard gating needs the email-gate flag. */
export function leadSettings(ctx: TenantContext): LeadSettings {
  const s = ctx.tenant.leads ?? DEFAULT_LEAD_SETTINGS;
  if (!ctx.can('lead_email_gate')) return { ...s, gate: { ...s.gate, mode: 'off' } };
  return s;
}

export function publicTenantConfig(ctx: TenantContext) {
  const leads = leadSettings(ctx);
  return {
    // Gate shape + contact only — never routing URLs or webhook secrets.
    leads: { gate: leads.gate, contactName: leads.contactName ?? ctx.tenant.branding.displayName },
    slug: ctx.tenant.slug,
    ref: ctx.ref,
    plan: ctx.tenant.plan,
    branding: ctx.tenant.branding,
    flags: Object.fromEntries(Object.entries(ctx.flags).map(([k, v]) => [k, { enabled: v.enabled, locked: v.locked }])),
    methods: ctx.methods,
  };
}
