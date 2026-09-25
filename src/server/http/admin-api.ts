/**
 * Tenant admin API (ADR 0008), mounted at /api/t/<ref>/admin/…
 *
 *   POST sign-in                 {email}          → 202 always (no account enumeration)
 *   POST verify                  {token}          → session cookie
 *   POST sign-out                                 → revoke
 *   GET  me                                       → user, role, CSRF token, entitlements
 *   GET  leads?search&source&attention&cursor     → inbox page
 *   GET  leads/<id>                               → lead + events + deliveries
 *   GET  leads.csv                                → export
 *   POST deliveries/<id>/retry                    → manual retry of a failed/dead delivery
 *   GET  settings                                 → branding, gate, routing (secret never returned)
 *   PUT  settings/branding | settings/gate | settings/routing
 *   POST settings/routing/test                    → signed ping to the webhook
 *   GET  features                                 → owner feature switches (ADR 0013)
 *   PUT  features               {features:{k:bool}} → owner: switch included features on/off
 *   GET  team                                     → members (ADR 0011)
 *   POST team/invite            {email, role}     → owner: add + email a 3-day sign-in link
 *   POST team/<id>/resend                         → owner: new invite link (not yet signed in)
 *   PUT  team/<id>              {role}            → owner: change role (never the last owner)
 *   DELETE team/<id>                              → owner: remove; their sessions end at once
 *   GET  suppliers                                → owner: PromoStandards connections (ADR 0017)
 *   POST suppliers              {…}               → owner: add (password sealed, never returned)
 *   PUT  suppliers/<id>         {…}               → owner: edit; a blank password keeps the saved one
 *   DELETE suppliers/<id>                         → owner: remove; its products are hidden
 *   POST suppliers/<id>/sync                      → owner: queue a catalog sync
 *
 * Every response is no-store. Mutations need the CSRF header; cross-site requests are refused.
 * Entitlements are checked here, server-side, exactly as on the storefront.
 */
import type { TenantContext } from '@/server/tenancy/context';
import type { EmailProvider } from '@/shared/providers';
import type { RateLimiter } from '@/server/rate-limit';
import type { ApiKeyRecord, ApiKeyRepo, ApiScope, AnalyticsRepo, DeliveryBrief, DeliveryRepo, LeadRecord, LeadRepo, LeadSource, ProductRepo, TrackedLink } from '@/server/repos/types';
import { API_SCOPES, LINK_CHANNELS } from '@/server/repos/types';
import { mintApiKey } from './public-api';
import { MAX_ACTIVE_LINKS, RANGE_DAYS, dayRange, newLinkCode, parseChannel, parseLabel, summarize } from '@/features/analytics/funnel';
import type { TenantPricingConfig } from '@/pricing/types';
import { validatePricingConfig } from '@/pricing/config-validation';
import { PLACEHOLDER_RATES, PLACEHOLDER_TENANT_CONFIG, resolveRates } from '@/pricing/placeholder-rates';
import { disclaimerFor, prospectLines } from '@/pricing/engine';
import { searchCatalog } from '@/features/catalog/catalog';
import { DECORATION_METHODS } from '@/core/domain/decoration-methods';
import type { DeliveryService } from '@/server/leads/delivery';
import type { SecretBox } from '@/server/crypto/secret-box';
import type { AdminAuthStore, AdminRole, AdminSession, AdminUser, AuditRepo, TeamMember, TenantSettingsWriter } from '@/server/admin/types';
import { DEFAULT_LEAD_SETTINGS, normalizeEmail, type GateMode, type LeadSettings } from '@/features/leads/rules';
import { FLAGS } from '@/flags/registry';
import { OWNER_TOGGLES, OWNER_TOGGLE_KEYS, isOwnerToggle } from '@/flags/owner-toggles';
import { WebhookCrmProvider, webhookUrlProblem, type WebhookOptions } from '@/shared/providers/webhook-crm';
import type { SupplierConnectionPatch, SupplierConnectionRecord, SupplierRepo } from '@/server/repos/types';
import { MAX_PRODUCTS_PER_RUN, SUPPLIER_FLAG, connectionDto, type SupplierService } from '@/server/suppliers/service';
import {
  ADMIN_SESSION_TTL_MS,
  LOGIN_TOKEN_TTL_MS,
  adminCookieHeader,
  adminCookieName,
  hashSecret,
  isCrossSite,
  isSecretShape,
  newSecret,
  readCookie,
  safeEqual,
} from '@/server/admin/auth';
import { HEX, UUID, clientIp, fail, jsonResponse, limited, locked, readJsonObject } from './shared';

export interface AdminDeps {
  auth: AdminAuthStore;
  settings: TenantSettingsWriter;
  audit: AuditRepo;
  email: EmailProvider;
  leads: LeadRepo;
  products: ProductRepo;
  deliveries: DeliveryRepo;
  delivery: DeliveryService;
  /** Tracked links + funnel events (ADR 0014). */
  analytics: AnalyticsRepo;
  /** Public API keys (ADR 0016). */
  apiKeys: ApiKeyRepo;
  /** PromoStandards supplier connections (ADR 0017). */
  suppliers: { repo: SupplierRepo; service: SupplierService };
  secrets: SecretBox;
  limits: { signIn: RateLimiter; signInEmail: RateLimiter; invite: RateLimiter };
  /** Absolute URL of an admin page for this tenant, from CONFIG — never from the Host header. */
  adminUrl: (ctx: TenantContext, path: string) => string;
  /** Absolute public API URL (ADR 0016); differs from adminUrl in path mode. */
  apiUrl: (ctx: TenantContext, path: string) => string;
  secureCookies: boolean;
  trustProxy: boolean;
  webhook?: Pick<WebhookOptions, 'allowInsecure' | 'resolver'>;
  now: () => Date;
  newId: () => string;
  log?: (msg: string) => void;
}

const FONTS = ['Inter', 'Georgia', 'Helvetica', 'Arial', 'Verdana', 'Trebuchet MS', 'system-ui'] as const;
const SOURCES: readonly LeadSource[] = ['email_gate', 'quote_request', 'pdf_leavebehind'];
const GENERIC_SENT = 'If that address has admin access, a sign-in link is on its way. It expires in 15 minutes.';
/** Invite links outlive sign-in links: people don't always read email within 15 minutes (ADR 0011). */
export const INVITE_TTL_MS = 3 * 24 * 3_600_000;
export const MAX_TEAM_SIZE = 25;
export const MAX_API_KEYS = 20;
export const MAX_SUPPLIERS = 10;
const ROLES: readonly AdminRole[] = ['tenant_owner', 'tenant_admin'];
/** Same wording as the Team tab, so the email and the screen agree. */
const ROLE_EMAIL: Record<AdminRole, string> = {
  tenant_owner: 'Owner (everything, including pricing, where leads go, and the team)',
  tenant_admin: 'Admin (works leads, and changes the storefront look and email gate)',
};

type Authed = { session: AdminSession; user: AdminUser };

export function createAdminApi(d: AdminDeps) {
  const log = d.log ?? ((m: string) => console.warn(m));
  /** Background work (sign-in email) — tracked so tests can await it. */
  const pending = new Set<Promise<unknown>>();
  const background = (p: Promise<unknown>) => {
    const t = p.catch((e) => log(`[admin] ${(e as Error).message}`)).finally(() => pending.delete(t));
    pending.add(t);
  };

  const audit = (ctx: TenantContext, actor: string, action: string, target?: string) =>
    d.audit.record({ tenantId: ctx.tenant.id, actor, action, ...(target ? { target } : {}), at: d.now().toISOString() });

  async function authenticate(req: Request, ctx: TenantContext): Promise<Authed | null> {
    const raw = readCookie(req, adminCookieName(ctx.tenant.id));
    if (!isSecretShape(raw)) return null;
    const session = await d.auth.findSession(ctx.tenant.id, hashSecret(raw), d.now());
    if (!session) return null;
    const user = await d.auth.getUser(ctx.tenant.id, session.userId);
    return user ? { session, user } : null; // a removed user loses access immediately
  }

  /** Auth + CSRF + role gate. Returns the caller or an error Response. */
  async function guard(req: Request, ctx: TenantContext, opts: { mutation?: boolean; owner?: boolean } = {}): Promise<Authed | Response> {
    if (opts.mutation && isCrossSite(req)) return fail(403, 'csrf_failed', 'Cross-site request refused.');
    const a = await authenticate(req, ctx);
    if (!a) return fail(401, 'unauthorized', 'Sign in to continue.');
    if (opts.mutation) {
      const token = req.headers.get('x-csrf-token') ?? '';
      if (!safeEqual(token, a.session.csrfToken)) return fail(403, 'csrf_failed', 'Your session token is missing or stale. Reload the page.');
    }
    if (opts.owner && a.user.role !== 'tenant_owner') return fail(403, 'forbidden', 'Only the account owner can change this.');
    return a;
  }

  /* ------------------------------ sign-in ------------------------------ */

  async function signIn(req: Request, ctx: TenantContext): Promise<Response> {
    if (isCrossSite(req)) return fail(403, 'csrf_failed', 'Cross-site request refused.');
    const ip = clientIp(req, d.trustProxy);
    const rl = await limited(d.limits.signIn, `signin:${ctx.tenant.id}:${ip}`);
    if (rl) return rl;
    const b = await readJsonObject(req);
    const email = b ? normalizeEmail(b.email) : null;
    if (!email) return fail(400, 'invalid_body', 'Enter a valid email address.');
    // Per-address cap stops mail-bombing one inbox; the answer stays generic either way.
    if (!(await d.limits.signInEmail.hit(`signin-email:${ctx.tenant.id}:${hashSecret(email)}`)).ok) {
      return jsonResponse(202, { ok: true, message: GENERIC_SENT });
    }
    // Look-up, token and email happen off the response path, so timing doesn't reveal accounts.
    background(
      (async () => {
        const user = await d.auth.findUserByEmail(ctx.tenant.id, email);
        if (!user) return;
        const token = newSecret();
        const now = d.now();
        await d.auth.createLoginToken({
          id: d.newId(),
          tenantId: ctx.tenant.id,
          userId: user.id,
          tokenHash: hashSecret(token),
          expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MS),
          createdAt: now,
        });
        // Token in the URL FRAGMENT: never sent to servers, logs or Referer; a link scanner
        // fetching the page can't consume it (the page needs a click to POST it).
        const link = `${d.adminUrl(ctx, '/admin/verify')}#token=${token}`;
        await d.email.send({
          to: user.email,
          subject: `Sign in to ${ctx.tenant.branding.displayName}`,
          text: `Use this link to sign in to your ${ctx.tenant.branding.displayName} admin. It works once and expires in 15 minutes.\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
        });
        await audit(ctx, user.id, 'admin.sign_in_link_sent');
      })(),
    );
    return jsonResponse(202, { ok: true, message: GENERIC_SENT });
  }

  async function verify(req: Request, ctx: TenantContext): Promise<Response> {
    if (isCrossSite(req)) return fail(403, 'csrf_failed', 'Cross-site request refused.');
    const rl = await limited(d.limits.signIn, `verify:${ctx.tenant.id}:${clientIp(req, d.trustProxy)}`);
    if (rl) return rl;
    const b = await readJsonObject(req);
    const bad = () => fail(400, 'invalid_token', 'This sign-in link is invalid, already used or expired. Request a new one.');
    if (!b || !isSecretShape(b.token)) return bad();
    const now = d.now();
    const userId = await d.auth.consumeLoginToken(ctx.tenant.id, hashSecret(b.token), now);
    const user = userId ? await d.auth.getUser(ctx.tenant.id, userId) : null;
    if (!user) return bad();
    const token = newSecret();
    const session: AdminSession = {
      id: d.newId(),
      tenantId: ctx.tenant.id,
      userId: user.id,
      csrfToken: newSecret(),
      expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS).toISOString(),
    };
    await d.auth.createSession({ ...session, tokenHash: hashSecret(token), createdAt: now });
    await d.auth.recordSignIn(ctx.tenant.id, user.id, now);
    await audit(ctx, user.id, 'admin.sign_in');
    return jsonResponse(
      200,
      { ok: true, redirect: d.adminUrl(ctx, '/admin') },
      { 'set-cookie': adminCookieHeader(adminCookieName(ctx.tenant.id), token, ADMIN_SESSION_TTL_MS / 1000, d.secureCookies) },
    );
  }

  async function signOut(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    await d.auth.revokeSession(ctx.tenant.id, a.session.id, d.now());
    await audit(ctx, a.user.id, 'admin.sign_out');
    return jsonResponse(200, { ok: true }, { 'set-cookie': adminCookieHeader(adminCookieName(ctx.tenant.id), '', 0, d.secureCookies) });
  }

  async function me(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    return jsonResponse(200, {
      user: { email: a.user.email, role: a.user.role },
      csrfToken: a.session.csrfToken,
      tenant: { name: ctx.tenant.branding.displayName, plan: ctx.tenant.plan },
      // Where leads go right now: the webhook only counts while the tenant is entitled to it.
      routing: leadSettings(ctx).routing.provider === 'webhook' && ctx.can('crm_webhook_routing') ? 'webhook' : 'inbox',
      can: {
        customBranding: ctx.can('custom_branding'),
        webhookRouting: ctx.can('crm_webhook_routing'),
        quoteRequests: ctx.can('quote_requests'),
        leaveBehind: ctx.can('all_lead_paths'),
        pricing: ctx.can('admin_pricing_config'),
        manageTeam: a.user.role === 'tenant_owner',
        inviteTeam: ctx.can('multi_user_admin'),
        analytics: ctx.can('analytics_dashboard'),
        /** Locked by plan (upgrade would help), as opposed to switched off. */
        analyticsUpgradeable: ctx.flags.analytics_dashboard.locked,
      },
    });
  }

  /* --------------------------- feature switches (ADR 0013) --------------------------- */

  const PLAN_NAME = { free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' } as const;

  function featuresDto(ctx: TenantContext, a: Authed) {
    return {
      canEdit: a.user.role === 'tenant_owner',
      features: OWNER_TOGGLES.map((t) => {
        const f = ctx.flags[t.key];
        // Available = the owner's switch decides. Otherwise the plan or the platform does.
        const blockedBy = f.reason === 'not_entitled' ? 'plan' : f.reason === 'kill_switch' ? 'platform' : null;
        return {
          key: t.key,
          label: t.label,
          help: t.help,
          on: f.enabled,
          available: blockedBy === null,
          blockedBy,
          plan: PLAN_NAME[FLAGS[t.key].minPlan],
        };
      }),
    };
  }

  async function getFeatures(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    return jsonResponse(200, featuresDto(ctx, a));
  }

  async function putFeatures(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const b = await readJsonObject(req);
    const input = b?.features;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'invalid_body', 'Send {"features": {"<feature>": true|false}}.');
    const errors: Record<string, string> = {};
    const changes: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (!isOwnerToggle(k)) errors[k] = 'Not a feature you can switch here.';
      else if (typeof v !== 'boolean') errors[k] = 'Must be true or false.';
      else if (ctx.flags[k].reason === 'not_entitled' && v) errors[k] = `Available on the ${PLAN_NAME[FLAGS[k].minPlan]} plan.`;
      else if (ctx.flags[k].reason === 'kill_switch' && v) errors[k] = 'Temporarily unavailable for all sites.';
      else changes[k] = v;
    }
    if (Object.keys(errors).length) return fail(400, 'invalid_body', 'Some switches could not be saved.', { errors });
    // Start from the tenant's current switches for the managed keys, then apply the changes.
    // "On" is the registry default for every managed flag, so only "off" needs storing.
    const next: Record<string, boolean> = {};
    for (const k of OWNER_TOGGLE_KEYS) {
      const current = ctx.tenant.flagOverrides[k];
      const value = k in changes ? changes[k]! : current;
      if (value !== undefined && value !== FLAGS[k].default) next[k] = value;
    }
    await d.settings.setFlagOverrides(ctx.tenant.id, OWNER_TOGGLE_KEYS, next);
    const summary = Object.entries(changes)
      .filter(([k, v]) => ctx.flags[k as keyof typeof ctx.flags].enabled !== v)
      .map(([k, v]) => `${k} ${v ? 'on' : 'off'}`)
      .join(', ');
    if (summary) await audit(ctx, a.user.id, 'settings.features', summary);
    return jsonResponse(200, { ok: true });
  }

  /* ------------------------------- team (ADR 0011) ------------------------------- */

  const memberDto = (m: TeamMember, all: TeamMember[], me: AdminUser) => ({
    id: m.id,
    email: m.email,
    role: m.role,
    status: m.lastSignInAt ? ('active' as const) : ('invited' as const),
    lastSignInAt: m.lastSignInAt,
    addedAt: m.createdAt,
    invitedBy: m.invitedBy ? (all.find((x) => x.id === m.invitedBy)?.email ?? 'a former member') : null,
    isYou: m.id === me.id,
  });

  /** Emails a single-use invite link. Returns whether the email went out (the member exists either way). */
  async function sendInvite(ctx: TenantContext, member: { id: string; email: string; role: AdminRole }, inviter: AdminUser): Promise<boolean> {
    const token = newSecret();
    const now = d.now();
    await d.auth.createLoginToken({ id: d.newId(), tenantId: ctx.tenant.id, userId: member.id, tokenHash: hashSecret(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS), createdAt: now });
    const name = ctx.tenant.branding.displayName;
    const link = `${d.adminUrl(ctx, '/admin/verify')}#token=${token}`;
    try {
      await d.email.send({
        to: member.email,
        subject: `You're invited to the ${name} admin`,
        text:
          `${inviter.email} invited you to the ${name} admin.\nYour role: ${ROLE_EMAIL[member.role]}.\n\n` +
          `Accept and sign in (the link works once and expires in 3 days):\n${link}\n\n` +
          `After that, sign in any time at ${d.adminUrl(ctx, '/admin')} with this email address.\n\n` +
          `If you weren't expecting this, you can ignore this email.`,
      });
      return true;
    } catch (e) {
      log(`[admin] invite email failed: ${(e as Error).message}`);
      return false;
    }
  }

  async function listTeam(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const all = await d.auth.listMembers(ctx.tenant.id);
    return jsonResponse(200, {
      members: all.map((m) => memberDto(m, all, a.user)),
      canManage: a.user.role === 'tenant_owner',
      // Inviting is plan-gated (§7 "Multi-user admin"); `upgradeable` = locked by plan, not switched off.
      canInvite: ctx.can('multi_user_admin'),
      inviteUpgradeable: ctx.flags.multi_user_admin.locked,
      maxSize: MAX_TEAM_SIZE,
    });
  }

  async function invite(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    // Adding people is "Multi-user admin" (§7: Enterprise). Removing and re-roling stay open on
    // every plan so an owner can always cut access, e.g. after a downgrade.
    const gate = locked(ctx, 'multi_user_admin');
    if (gate) return gate;
    const rl = await limited(d.limits.invite, `invite:${ctx.tenant.id}`);
    if (rl) return rl;
    const b = await readJsonObject(req);
    const email = b ? normalizeEmail(b.email) : null;
    if (!email) return fail(400, 'invalid_body', 'Enter a valid email address.');
    const role = b?.role === undefined ? 'tenant_admin' : b.role;
    if (!ROLES.includes(role as AdminRole)) return fail(400, 'invalid_body', 'Role must be owner or admin.');
    const all = await d.auth.listMembers(ctx.tenant.id);
    if (all.length >= MAX_TEAM_SIZE) return fail(409, 'team_full', `A workspace can have up to ${MAX_TEAM_SIZE} people. Remove someone first.`);
    const id = d.newId();
    const created = await d.auth.addMember({ id, tenantId: ctx.tenant.id, email, role: role as AdminRole, invitedBy: a.user.id, createdAt: d.now() });
    if (created === 'exists') return fail(409, 'already_member', `${email} already has access.`);
    const emailSent = await sendInvite(ctx, { id, email, role: role as AdminRole }, a.user);
    await audit(ctx, a.user.id, 'team.invite', `${email} as ${role}`);
    const after = await d.auth.listMembers(ctx.tenant.id);
    const m = after.find((x) => x.id === id)!;
    return jsonResponse(201, { member: memberDto(m, after, a.user), emailSent });
  }

  async function resendInvite(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'No such person.');
    const gate = locked(ctx, 'multi_user_admin');
    if (gate) return gate;
    const rl = await limited(d.limits.invite, `invite:${ctx.tenant.id}`);
    if (rl) return rl;
    const m = (await d.auth.listMembers(ctx.tenant.id)).find((x) => x.id === id);
    if (!m) return fail(404, 'not_found', 'No such person.');
    if (m.lastSignInAt) return fail(409, 'already_active', `${m.email} has already signed in. They can request a sign-in link from the admin page.`);
    const emailSent = await sendInvite(ctx, m, a.user);
    await audit(ctx, a.user.id, 'team.invite_resent', m.email);
    return jsonResponse(200, { ok: true, emailSent });
  }

  async function changeRole(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'No such person.');
    const b = await readJsonObject(req);
    if (!b || !ROLES.includes(b.role as AdminRole)) return fail(400, 'invalid_body', 'Role must be owner or admin.');
    const role = b.role as AdminRole;
    const before = (await d.auth.listMembers(ctx.tenant.id)).find((x) => x.id === id);
    const r = await d.auth.changeRole(ctx.tenant.id, id, role);
    if (r === 'not_found') return fail(404, 'not_found', 'No such person.');
    if (r === 'last_owner') return fail(409, 'last_owner', 'Every workspace needs an owner. Make someone else an owner first.');
    if (before && before.role !== role) await audit(ctx, a.user.id, 'team.role_changed', `${before.email}: ${before.role} → ${role}`);
    const all = await d.auth.listMembers(ctx.tenant.id);
    return jsonResponse(200, { member: memberDto(all.find((x) => x.id === id)!, all, a.user) });
  }

  async function removeMember(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'No such person.');
    const before = (await d.auth.listMembers(ctx.tenant.id)).find((x) => x.id === id);
    const r = await d.auth.removeMember(ctx.tenant.id, id);
    if (r === 'not_found') return fail(404, 'not_found', 'No such person.');
    if (r === 'last_owner') return fail(409, 'last_owner', 'Every workspace needs an owner. Make someone else an owner first.');
    await audit(ctx, a.user.id, 'team.removed', before?.email);
    // Removing yourself signs you out here too (your session no longer resolves to a user).
    const self = id === a.user.id;
    return jsonResponse(200, { ok: true, signedOut: self }, self ? { 'set-cookie': adminCookieHeader(adminCookieName(ctx.tenant.id), '', 0, d.secureCookies) } : {});
  }

  /* ------------------------------- leads ------------------------------- */

  const leadDto = (l: LeadRecord, deliveries: DeliveryBrief[] = []) => ({
    id: l.id,
    email: l.email,
    name: l.name ?? null,
    company: l.company ?? null,
    phone: l.phone ?? null,
    marketingOptIn: l.marketingOptIn,
    consent: l.consent ?? null,
    sources: l.sources,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    delivery: summarise(deliveries),
  });

  /**
   * Worst-first: an admin should see a problem even if a later delivery worked. A delivery to
   * the built-in inbox is `inbox`, not `crm`: only a real CRM delivery earns "Sent to CRM".
   */
  function summarise(ds: DeliveryBrief[]): 'none' | 'inbox' | 'crm' | 'pending' | 'failed' | 'dead' {
    for (const s of ['dead', 'failed', 'pending'] as const) if (ds.some((d) => d.status === s)) return s;
    if (ds.some((d) => d.status === 'delivered' && d.routedTo && d.routedTo !== 'mock')) return 'crm';
    return ds.some((d) => d.status === 'delivered') ? 'inbox' : 'none';
  }

  function parseListQuery(url: URL) {
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
    const source = url.searchParams.get('source') ?? '';
    const cursor = url.searchParams.get('cursor') ?? '';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25));
    if (source && !SOURCES.includes(source as LeadSource)) return null;
    if (cursor && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
    return { search, source: source as LeadSource | '', cursor, limit, attention: url.searchParams.get('attention') === '1' };
  }

  async function listLeads(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const q = parseListQuery(new URL(req.url));
    if (!q) return fail(400, 'invalid_query', 'Unrecognised filter.');
    const ids = q.attention ? await d.deliveries.leadIdsWithStatus(ctx.tenant.id, ['failed', 'dead'], 1000) : undefined;
    const page = await d.leads.list(ctx.tenant.id, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.search ? { search: q.search } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(ids ? { ids } : {}),
    });
    const st = await d.deliveries.statusesFor(ctx.tenant.id, page.items.map((l) => l.id));
    return jsonResponse(200, { items: page.items.map((l) => leadDto(l, st[l.id])), nextCursor: page.nextCursor });
  }

  async function leadDetail(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Lead not found.');
    const lead = await d.leads.get(ctx.tenant.id, id);
    if (!lead) return fail(404, 'not_found', 'Lead not found.');
    const [events, deliveries] = await Promise.all([d.leads.events(ctx.tenant.id, id), d.deliveries.forLead(ctx.tenant.id, id)]);
    return jsonResponse(200, {
      lead: leadDto(lead, deliveries),
      events: events.sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map((e) => ({ kind: e.kind, at: e.createdAt, payload: e.payload })),
      deliveries: deliveries.map((x) => ({
        id: x.id,
        source: x.source,
        status: x.status,
        attempts: x.attempts,
        nextAttemptAt: x.nextAttemptAt,
        lastError: x.lastError ?? null,
        routedTo: x.routedTo ?? null,
        toCrm: x.status === 'delivered' && !!x.routedTo && x.routedTo !== 'mock',
        createdAt: x.createdAt,
        retryable: x.status === 'failed' || x.status === 'dead',
      })),
    });
  }

  /** Spreadsheet-safe CSV: quoted, and formula-leading cells defused (CSV injection). */
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  async function exportCsv(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const header = ['email', 'name', 'company', 'phone', 'marketing_opt_in', 'consent_version', 'consent_at', 'sources', 'created_at', 'crm_delivery'];
    const lines = [header.join(',')];
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = await d.leads.list(ctx.tenant.id, { limit: 100, ...(cursor ? { cursor } : {}) });
      const st = await d.deliveries.statusesFor(ctx.tenant.id, page.items.map((l) => l.id));
      for (const l of page.items) {
        lines.push(
          [l.email, l.name, l.company, l.phone, l.marketingOptIn ? 'yes' : 'no', l.consent?.version, l.consent?.at, l.sources.join(' '), l.createdAt, summarise(st[l.id] ?? [])]
            .map(cell)
            .join(','),
        );
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    await audit(ctx, a.user.id, 'leads.export_csv', `${lines.length - 1} rows`);
    const day = d.now().toISOString().slice(0, 10);
    return new Response('\ufeff' + lines.join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="leads-${ctx.tenant.slug}-${day}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  async function retryDelivery(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Delivery not found.');
    const r = await d.delivery.retryNow(ctx, id);
    if (!r) return fail(404, 'not_found', 'Nothing to retry: the delivery is unknown or already delivered.');
    await audit(ctx, a.user.id, 'delivery.retry', id);
    return jsonResponse(200, { status: r.status, attempts: r.attempts, lastError: r.lastError ?? null });
  }

  /* ------------------------------ settings ----------------------------- */

  const leadSettings = (ctx: TenantContext): LeadSettings => ctx.tenant.leads ?? DEFAULT_LEAD_SETTINGS;

  async function getSettings(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const ls = leadSettings(ctx);
    const b = ctx.tenant.branding;
    return jsonResponse(200, {
      branding: { displayName: b.displayName, primaryHex: b.primaryHex, secondaryHex: b.secondaryHex, fontFamily: b.fontFamily },
      fonts: FONTS,
      gate: { ...ls.gate, contactName: ls.contactName ?? '' },
      routing: ls.routing.provider === 'webhook' ? { provider: 'webhook', url: ls.routing.url, hasSecret: true } : { provider: 'mock' },
      can: { customBranding: ctx.can('custom_branding'), webhookRouting: ctx.can('crm_webhook_routing'), pricing: ctx.can('admin_pricing_config') },
      isOwner: a.user.role === 'tenant_owner',
      recentActivity: await recentActivity(ctx),
    });
  }

  /** Last changes with WHO made them (email, or "the system"); details stay in the audit log. */
  async function recentActivity(ctx: TenantContext) {
    const rows = await d.audit.recent(ctx.tenant.id, 10);
    const names = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.actor))) {
      names.set(id, id === 'system' ? 'the system' : ((await d.auth.getUser(ctx.tenant.id, id))?.email ?? 'a removed user'));
    }
    return rows.map((e) => ({ action: e.action, at: e.at, target: e.target ?? null, by: names.get(e.actor)! }));
  }

  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim().replace(/\s+/g, ' ') : null);

  async function putBranding(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'custom_branding');
    if (gate) return gate;
    const b = await readJsonObject(req);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const errors: Record<string, string> = {};
    const displayName = text(b.displayName, 80);
    if (!displayName) errors.displayName = 'Enter a name up to 80 characters.';
    if (typeof b.primaryHex !== 'string' || !HEX.test(b.primaryHex)) errors.primaryHex = 'Use a hex colour like #1F45C6.';
    if (typeof b.secondaryHex !== 'string' || !HEX.test(b.secondaryHex)) errors.secondaryHex = 'Use a hex colour like #111827.';
    if (!FONTS.includes(b.fontFamily as (typeof FONTS)[number])) errors.fontFamily = 'Choose one of the listed fonts.';
    if (Object.keys(errors).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { errors });
    await d.settings.updateBranding(ctx.tenant.id, {
      displayName: displayName!,
      primaryHex: (b.primaryHex as string).toUpperCase(),
      secondaryHex: (b.secondaryHex as string).toUpperCase(),
      fontFamily: b.fontFamily as string,
    });
    await audit(ctx, a.user.id, 'settings.branding');
    return jsonResponse(200, { ok: true });
  }

  async function putGate(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    const b = await readJsonObject(req);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const errors: Record<string, string> = {};
    const mode = b.mode as GateMode;
    if (!['off', 'soft', 'hard'].includes(mode)) errors.mode = 'Choose off, soft or hard.';
    const free = Number(b.freeProducts);
    if (!Number.isInteger(free) || free < 0 || free > 20) errors.freeProducts = 'Enter a whole number from 0 to 20.';
    const contact = b.contactName === '' || b.contactName === undefined ? '' : text(b.contactName, 80);
    if (contact === null) errors.contactName = 'Up to 80 characters.';
    if (Object.keys(errors).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { errors });
    const cur = leadSettings(ctx);
    const next: LeadSettings = { gate: { mode, freeProducts: free }, routing: cur.routing, ...(contact ? { contactName: contact } : {}) };
    await d.settings.updateLeadSettings(ctx.tenant.id, next);
    await audit(ctx, a.user.id, 'settings.gate', `${mode}/${free}`);
    return jsonResponse(200, { ok: true });
  }

  async function putRouting(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const b = await readJsonObject(req);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const cur = leadSettings(ctx);
    if (b.provider === 'mock') {
      await d.settings.updateLeadSettings(ctx.tenant.id, { ...cur, routing: { provider: 'mock' } });
      await audit(ctx, a.user.id, 'settings.routing', 'inbox');
      return jsonResponse(200, { ok: true });
    }
    if (b.provider !== 'webhook') return fail(422, 'invalid_body', 'Choose inbox or webhook.');
    const gate = locked(ctx, 'crm_webhook_routing');
    if (gate) return gate;
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const problem = url.length > 2000 ? 'is too long' : webhookUrlProblem(url, d.webhook?.allowInsecure ?? false);
    if (problem) return fail(422, 'invalid_body', `That URL ${problem}.`, { errors: { url: `URL ${problem}.` } });
    // Keep the existing secret unless asked to rotate; a new secret is shown exactly once.
    let secret: string | null = null;
    let sealed = cur.routing.provider === 'webhook' ? cur.routing.secretSealed : null;
    if (!sealed || b.rotateSecret === true) {
      secret = `whsec_${newSecret()}`;
      sealed = d.secrets.seal(secret, ctx.tenant.id);
    }
    await d.settings.updateLeadSettings(ctx.tenant.id, { ...cur, routing: { provider: 'webhook', url, secretSealed: sealed } });
    await audit(ctx, a.user.id, 'settings.routing', `webhook ${new URL(url).host}${secret ? ' (new secret)' : ''}`);
    return jsonResponse(200, { ok: true, ...(secret ? { secret } : {}) });
  }

  async function testRouting(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'crm_webhook_routing');
    if (gate) return gate;
    const r = leadSettings(ctx).routing;
    if (r.provider !== 'webhook') return fail(409, 'invalid_request', 'Save a webhook URL first.');
    const rl = await limited(d.limits.signIn, `webhook-test:${ctx.tenant.id}`);
    if (rl) return rl;
    try {
      const p = new WebhookCrmProvider(r.url, d.secrets.open(r.secretSealed, ctx.tenant.id), d.webhook ?? {});
      await p.ping(ctx.tenant.id);
      await audit(ctx, a.user.id, 'settings.routing_test', 'ok');
      return jsonResponse(200, { ok: true });
    } catch (e) {
      const error = (e as Error).message.slice(0, 200);
      await audit(ctx, a.user.id, 'settings.routing_test', 'failed');
      return jsonResponse(200, { ok: false, error });
    }
  }

  /* ------------------------------- pricing ------------------------------ */

  const categoriesOf = async (ctx: TenantContext) => [...new Set((await d.products.list(ctx.tenant.id)).map((p) => p.category))].sort();

  /** The config as the editor shows it: rates always filled in (placeholder where unset). */
  const editable = (c: TenantPricingConfig): TenantPricingConfig => ({ ...c, rates: resolveRates(c.rates) });

  async function getPricing(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'admin_pricing_config');
    if (gate) return gate;
    return jsonResponse(200, {
      config: editable(ctx.tenant.pricingConfig),
      usingOwnRates: !!ctx.tenant.pricingConfig.rates,
      defaults: { ...PLACEHOLDER_TENANT_CONFIG, rates: PLACEHOLDER_RATES },
      categories: await categoriesOf(ctx),
      methods: ctx.methods.map((m) => ({ key: m, label: DECORATION_METHODS[m].label })),
      isOwner: a.user.role === 'tenant_owner',
    });
  }

  async function validateFor(ctx: TenantContext, raw: unknown) {
    return validatePricingConfig(raw, { categories: await categoriesOf(ctx), currency: ctx.tenant.pricingConfig.currency });
  }

  /** One line for the audit log: what changed, in the admin's terms. */
  function pricingDiff(a: TenantPricingConfig, b: TenantPricingConfig): string {
    const pct = (x: number) => `${Math.round((x - 1) * 10_000) / 100}%`;
    const out: string[] = [];
    if (a.marginMarkup !== b.marginMarkup) out.push(`blank markup ${pct(a.marginMarkup)} → ${pct(b.marginMarkup)}`);
    if (a.decorationMarkup !== b.decorationMarkup) out.push(`decoration markup ${pct(a.decorationMarkup)} → ${pct(b.decorationMarkup)}`);
    if (JSON.stringify(a.categoryMarkupOverrides ?? {}) !== JSON.stringify(b.categoryMarkupOverrides ?? {})) out.push('category markups');
    if (JSON.stringify(a.fees) !== JSON.stringify(b.fees)) out.push('fees');
    if (a.rounding !== b.rounding) out.push(`rounding ${a.rounding} → ${b.rounding}`);
    if (a.showItemizedToProspect !== b.showItemizedToProspect) out.push(b.showItemizedToProspect ? 'breakdown shown' : 'breakdown hidden');
    const ra = resolveRates(a.rates);
    const rb = resolveRates(b.rates);
    const changed = (Object.keys(rb) as (keyof typeof rb)[]).filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(rb[k]));
    if (changed.length) out.push(`rates: ${changed.map((k) => DECORATION_METHODS[k].label).join(', ')}`);
    return out.join('; ').slice(0, 300) || 'no change';
  }

  async function putPricing(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'admin_pricing_config');
    if (gate) return gate;
    const b = await readJsonObject(req, 64 * 1024);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const v = await validateFor(ctx, b.config);
    if (!v.ok) return fail(422, 'invalid_body', 'Check the highlighted fields.', { errors: v.errors });
    await d.settings.updatePricingConfig(ctx.tenant.id, v.value);
    await audit(ctx, a.user.id, 'settings.pricing', pricingDiff(ctx.tenant.pricingConfig, v.value));
    return jsonResponse(200, { ok: true, warnings: v.warnings });
  }

  /**
   * Price every product at a sample order with an UNSAVED config, beside today's prices.
   * Read-only: any admin may use it; nothing is stored.
   */
  async function previewPricing(req: Request, ctx: TenantContext): Promise<Response> {
    if (isCrossSite(req)) return fail(403, 'csrf_failed', 'Cross-site request refused.');
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'admin_pricing_config');
    if (gate) return gate;
    const b = await readJsonObject(req, 64 * 1024);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const quantity = Number(b.quantity);
    const colorCount = Number(b.colorCount);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) return fail(422, 'invalid_body', 'Quantity must be 1 to 100,000.', { errors: { quantity: 'Enter 1 to 100,000.' } });
    if (!Number.isInteger(colorCount) || colorCount < 1 || colorCount > 12) return fail(422, 'invalid_body', 'Colours must be 1 to 12.', { errors: { colorCount: 'Enter 1 to 12.' } });
    const v = await validateFor(ctx, b.config);
    if (!v.ok) return fail(422, 'invalid_body', 'Check the highlighted fields.', { errors: v.errors });
    const products = await d.products.list(ctx.tenant.id);
    const q = { quantity, logo: { colorCount, isPhotographic: false }, entitledMethods: ctx.methods };
    const now = new Map(searchCatalog(products, q, ctx.tenant.pricingConfig).items.map((i) => [i.slug, i.recommended]));
    const next = searchCatalog(products, q, v.value).items;
    return jsonResponse(200, {
      quantity,
      colorCount,
      warnings: v.warnings,
      disclaimer: disclaimerFor(v.value),
      rows: next.map((i) => ({
        slug: i.slug,
        name: i.name,
        category: i.category,
        method: DECORATION_METHODS[i.recommended.method].label,
        unit: i.recommended.unit,
        total: i.recommended.total,
        currentUnit: now.get(i.slug)?.unit ?? null,
        lines: v.value.showItemizedToProspect ? prospectLines(i.recommended.quote) : null,
      })),
    });
  }

  /* ------------------------------ tracked links + analytics (ADR 0014) ------------------------------ */

  const linkDto = (ctx: TenantContext, l: TrackedLink) => ({
    id: l.id,
    code: l.code,
    label: l.label,
    channel: l.channel,
    archived: !!l.archivedAt,
    createdAt: l.createdAt,
    // Built from configuration like sign-in links, never from the Host header.
    url: d.adminUrl(ctx, `/?src=${l.code}`),
  });

  /** GET links: everyone signed in can see them; creating needs the plan feature. */
  async function listLinks(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const links = await d.analytics.listLinks(ctx.tenant.id);
    return jsonResponse(200, {
      links: links.map((l) => linkDto(ctx, l)),
      channels: LINK_CHANNELS,
      canCreate: ctx.can('shareable_tracked_links'),
      upgradeable: ctx.flags.shareable_tracked_links.locked,
      maxActive: MAX_ACTIVE_LINKS,
    });
  }

  /** POST links { label, channel } */
  async function createLink(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'shareable_tracked_links');
    if (gate) return gate;
    const b = await readJsonObject(req);
    const label = b ? parseLabel(b.label) : null;
    const channel = b ? parseChannel(b.channel) : null;
    const fields: Record<string, string> = {};
    if (!label) fields.label = 'Give the link a name of up to 80 characters.';
    if (!channel) fields.channel = 'Choose where you will share it.';
    if (!label || !channel) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields });
    if ((await d.analytics.countActiveLinks(ctx.tenant.id)) >= MAX_ACTIVE_LINKS) {
      return fail(409, 'too_many_links', `You can have up to ${MAX_ACTIVE_LINKS} active links. Archive one you no longer use.`);
    }
    // 31^7 ≈ 27 billion codes: a clash is vanishingly rare, but retry rather than fail on one.
    for (let i = 0; i < 5; i++) {
      const link: TrackedLink = { id: d.newId(), tenantId: ctx.tenant.id, code: newLinkCode(), label, channel, createdBy: a.user.id, archivedAt: null, createdAt: d.now().toISOString() };
      if (await d.analytics.createLink(link)) {
        await audit(ctx, a.user.id, 'links.create', `${link.code} ${label}`);
        return jsonResponse(201, { link: linkDto(ctx, link) });
      }
    }
    return fail(503, 'try_again', 'Could not create the link. Please try again.');
  }

  /** PUT links/:id { label?, channel?, archived? } — archiving always works, even after a downgrade. */
  async function updateLink(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Link not found.');
    const current = await d.analytics.getLink(ctx.tenant.id, id);
    if (!current) return fail(404, 'not_found', 'Link not found.');
    const b = await readJsonObject(req);
    if (!b) return fail(400, 'invalid_body', 'Send a JSON object.');
    const patch: { label?: string; channel?: TrackedLink['channel']; archivedAt?: string | null } = {};
    const fields: Record<string, string> = {};
    if (b.label !== undefined) {
      const v = parseLabel(b.label);
      if (v) patch.label = v;
      else fields.label = 'Give the link a name of up to 80 characters.';
    }
    if (b.channel !== undefined) {
      const v = parseChannel(b.channel);
      if (v) patch.channel = v;
      else fields.channel = 'Choose where you will share it.';
    }
    if (b.archived !== undefined) {
      if (typeof b.archived !== 'boolean') fields.archived = 'Send true or false.';
      else if (b.archived !== !!current.archivedAt) patch.archivedAt = b.archived ? d.now().toISOString() : null;
    }
    if (Object.keys(fields).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields });
    const reviving = patch.archivedAt === null;
    const editing = patch.label !== undefined || patch.channel !== undefined;
    if (reviving || editing) {
      const gate = locked(ctx, 'shareable_tracked_links');
      if (gate) return gate;
    }
    if (reviving && (await d.analytics.countActiveLinks(ctx.tenant.id)) >= MAX_ACTIVE_LINKS) {
      return fail(409, 'too_many_links', `You can have up to ${MAX_ACTIVE_LINKS} active links. Archive one you no longer use.`);
    }
    if (!Object.keys(patch).length) return jsonResponse(200, { link: linkDto(ctx, current) });
    const updated = await d.analytics.updateLink(ctx.tenant.id, id, patch);
    if (!updated) return fail(404, 'not_found', 'Link not found.');
    const what = [patch.archivedAt !== undefined ? (patch.archivedAt ? 'archived' : 'restored') : null, editing ? 'edited' : null].filter(Boolean).join(', ');
    await audit(ctx, a.user.id, 'links.update', `${updated.code} ${what}`);
    return jsonResponse(200, { link: linkDto(ctx, updated) });
  }

  /** GET analytics?days=7|30|90|365 — funnel totals, per day and per link. */
  async function analyticsSummary(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx);
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'analytics_dashboard');
    if (gate) return gate;
    const asked = Number(new URL(req.url).searchParams.get('days') ?? '30');
    const days = (RANGE_DAYS as readonly number[]).includes(asked) ? asked : 30;
    const range = dayRange(d.now(), days);
    const [counts, links] = await Promise.all([d.analytics.counts(ctx.tenant.id, range.from, range.to), d.analytics.listLinks(ctx.tenant.id)]);
    return jsonResponse(200, { summary: summarize(counts, links, range), timezone: 'UTC' });
  }

  /* ------------------------------ API keys (ADR 0016) ------------------------------ */

  const keyDto = (k: ApiKeyRecord) => ({
    id: k.id,
    name: k.name,
    // Enough to recognise a key in a config file, never enough to use it.
    hint: `bck_${k.keyId}_…`,
    scopes: k.scopes,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revoked: !!k.revokedAt,
    revokedAt: k.revokedAt,
  });

  /** GET api-keys (owners): metadata only. */
  async function listApiKeys(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { owner: true });
    if (a instanceof Response) return a;
    return jsonResponse(200, {
      keys: (await d.apiKeys.list(ctx.tenant.id)).map(keyDto),
      scopes: API_SCOPES,
      canCreate: ctx.can('api_access'),
      upgradeable: ctx.flags.api_access.locked,
      maxActive: MAX_API_KEYS,
      // Where to call it: the tenant's own host, from configuration (never the Host header).
      baseUrl: d.apiUrl(ctx, '/v1'),
    });
  }

  /** POST api-keys { name, scopes } (owners) → the full key, shown this once. */
  async function createApiKey(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = locked(ctx, 'api_access');
    if (gate) return gate;
    const b = await readJsonObject(req);
    const name = b ? parseLabel(b.name) : null;
    const scopes = b && Array.isArray(b.scopes) ? [...new Set(b.scopes)] : [];
    const fields: Record<string, string> = {};
    if (!name) fields.name = 'Name the key after what uses it, up to 80 characters.';
    if (!scopes.length || !scopes.every((x) => (API_SCOPES as readonly unknown[]).includes(x))) fields.scopes = 'Choose at least one thing this key can read.';
    if (Object.keys(fields).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields });
    if ((await d.apiKeys.countActive(ctx.tenant.id)) >= MAX_API_KEYS) {
      return fail(409, 'too_many_keys', `You can have up to ${MAX_API_KEYS} active keys. Revoke one you no longer use.`);
    }
    const minted = mintApiKey();
    const rec: ApiKeyRecord = {
      id: d.newId(),
      tenantId: ctx.tenant.id,
      keyId: minted.keyId,
      name: name!,
      secretHash: minted.secretHash,
      scopes: (API_SCOPES as readonly ApiScope[]).filter((x) => scopes.includes(x)),
      createdBy: a.user.id,
      createdAt: d.now().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await d.apiKeys.create(rec);
    await audit(ctx, a.user.id, 'api_keys.create', `${rec.name} (${rec.scopes.join(', ')})`);
    return jsonResponse(201, { key: keyDto(rec), secret: minted.token });
  }

  /* ---- Supplier connections (ADR 0017): owners only; credentials never leave the server ---- */

  const SUPPLIER_ID = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,63}$/;

  /** Validate a create (all required) or update (all optional) body. */
  function parseSupplier(b: Record<string, unknown> | null, creating: boolean, defaultCurrency: string) {
    const fields: Record<string, string> = {};
    const patch: SupplierConnectionPatch & { password?: string } = {};
    const str = (k: string) => (typeof b?.[k] === 'string' ? (b[k] as string).trim() : undefined);
    const need = (k: string) => creating || b?.[k] !== undefined;
    if (!b) return { fields: { body: 'Send the connection details as JSON.' }, patch };
    if (need('name')) {
      const v = str('name');
      if (!v || v.length > 60) fields.name = 'Name the supplier, up to 60 characters.';
      else patch.name = v;
    }
    for (const [k, label] of [['productDataUrl', 'Product Data'], ['pricingUrl', 'Pricing and Configuration']] as const) {
      if (!need(k)) continue;
      const v = str(k);
      // Always strict: the webhook test switch must not loosen supplier addresses (real ones are https).
      const problem = v ? webhookUrlProblem(v, false) : 'is required';
      if (problem || !v || v.length > 500) fields[k] = `The ${label} service address ${problem ?? 'is too long'}.`;
      else patch[k] = v;
    }
    if (need('accountId')) {
      const v = str('accountId');
      if (!v || v.length > 200) fields.accountId = 'Enter the account ID the supplier gave you.';
      else patch.accountId = v;
    }
    // Password: required when creating; on update, absent or blank keeps the saved one.
    const pw = typeof b.password === 'string' ? b.password : undefined;
    if (creating && !pw) fields.password = 'Enter the password the supplier gave you.';
    else if (pw && pw.length > 500) fields.password = 'That password is too long.';
    else if (pw) patch.password = pw;
    if (need('currency')) {
      const v = (str('currency') ?? defaultCurrency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(v)) fields.currency = 'Use a three-letter currency code, like USD.';
      else patch.currency = v;
    }
    if (need('priceType')) {
      const v = str('priceType') ?? 'Net';
      if (v !== 'Net' && v !== 'List') fields.priceType = 'Choose your cost (Net) or the list price.';
      else patch.priceType = v;
    }
    if (b.fobId !== undefined) {
      const v = str('fobId') ?? '';
      if (v.length > 50) fields.fobId = 'That FOB ID is too long.';
      else patch.fobId = v || null;
    } else if (creating) patch.fobId = null;
    if (b.productIds !== undefined) {
      const raw = typeof b.productIds === 'string' ? b.productIds.split(/[\s,]+/) : Array.isArray(b.productIds) ? b.productIds : null;
      const ids = raw ? [...new Set(raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))] : null;
      if (!ids || ids.length > MAX_PRODUCTS_PER_RUN || !ids.every((x) => SUPPLIER_ID.test(x))) {
        fields.productIds = `List up to ${MAX_PRODUCTS_PER_RUN} product IDs, separated by commas or new lines.`;
      } else patch.productIds = ids;
    } else if (creating) patch.productIds = [];
    return { fields, patch };
  }

  function suppliersGate(ctx: TenantContext) {
    return locked(ctx, SUPPLIER_FLAG);
  }

  /** GET suppliers (owners). */
  async function listSuppliers(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { owner: true });
    if (a instanceof Response) return a;
    return jsonResponse(200, {
      suppliers: (await d.suppliers.repo.list(ctx.tenant.id)).map(connectionDto),
      canUse: ctx.can(SUPPLIER_FLAG),
      upgradeable: ctx.flags[SUPPLIER_FLAG].locked,
      defaultCurrency: ctx.tenant.pricingConfig.currency,
      maxSuppliers: MAX_SUPPLIERS,
      maxProductsPerRun: MAX_PRODUCTS_PER_RUN,
    });
  }

  /** POST suppliers (owners, plan-gated). */
  async function createSupplier(req: Request, ctx: TenantContext): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = suppliersGate(ctx);
    if (gate) return gate;
    const { fields, patch } = parseSupplier(await readJsonObject(req), true, ctx.tenant.pricingConfig.currency);
    if (Object.keys(fields).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields });
    const existing = await d.suppliers.repo.list(ctx.tenant.id);
    if (existing.length >= MAX_SUPPLIERS) return fail(409, 'too_many_suppliers', `You can connect up to ${MAX_SUPPLIERS} suppliers.`);
    if (existing.some((c) => c.name.toLowerCase() === patch.name!.toLowerCase())) {
      return fail(409, 'duplicate_name', 'You already have a supplier with that name.', { fields: { name: 'Choose a different name.' } });
    }
    const rec: SupplierConnectionRecord = {
      id: d.newId(),
      tenantId: ctx.tenant.id,
      name: patch.name!,
      productDataUrl: patch.productDataUrl!,
      pricingUrl: patch.pricingUrl!,
      accountId: patch.accountId!,
      passwordSealed: d.secrets.seal(patch.password!, ctx.tenant.id),
      currency: patch.currency!,
      priceType: patch.priceType!,
      fobId: patch.fobId ?? null,
      productIds: patch.productIds ?? [],
      status: 'never',
      statusAt: null,
      lastSync: null,
      createdAt: d.now().toISOString(),
    };
    await d.suppliers.repo.create(rec);
    await audit(ctx, a.user.id, 'suppliers.create', rec.name);
    return jsonResponse(201, { supplier: connectionDto(rec) });
  }

  /** PUT suppliers/:id (owners, plan-gated). A blank password keeps the saved one. */
  async function updateSupplier(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = suppliersGate(ctx);
    if (gate) return gate;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Supplier not found.');
    const { fields, patch } = parseSupplier(await readJsonObject(req), false, ctx.tenant.pricingConfig.currency);
    if (Object.keys(fields).length) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields });
    const current = await d.suppliers.repo.get(ctx.tenant.id, id);
    if (!current) return fail(404, 'not_found', 'Supplier not found.');
    if (patch.name && (await d.suppliers.repo.list(ctx.tenant.id)).some((c) => c.id !== id && c.name.toLowerCase() === patch.name!.toLowerCase())) {
      return fail(409, 'duplicate_name', 'You already have a supplier with that name.', { fields: { name: 'Choose a different name.' } });
    }
    const { password, ...rest } = patch;
    const updated = await d.suppliers.repo.update(ctx.tenant.id, id, { ...rest, ...(password ? { passwordSealed: d.secrets.seal(password, ctx.tenant.id) } : {}) });
    if (!updated) return fail(404, 'not_found', 'Supplier not found.');
    const changed = [...Object.keys(rest), ...(password ? ['password'] : [])];
    await audit(ctx, a.user.id, 'suppliers.update', `${updated.name}${changed.length ? ` (${changed.join(', ')})` : ''}`);
    return jsonResponse(200, { supplier: connectionDto(updated) });
  }

  /** DELETE suppliers/:id (owners). Works on every plan, so credentials can always be removed. */
  async function deleteSupplier(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Supplier not found.');
    const current = await d.suppliers.repo.get(ctx.tenant.id, id);
    if (!current || !(await d.suppliers.repo.remove(ctx.tenant.id, id))) return fail(404, 'not_found', 'Supplier not found.');
    await audit(ctx, a.user.id, 'suppliers.delete', current.name);
    return jsonResponse(200, { deleted: true });
  }

  /** POST suppliers/:id/sync (owners, plan-gated): queue a run; the worker does it. */
  async function syncSupplier(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    const gate = suppliersGate(ctx);
    if (gate) return gate;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Supplier not found.');
    const current = await d.suppliers.repo.get(ctx.tenant.id, id);
    if (!current) return fail(404, 'not_found', 'Supplier not found.');
    if (!(await d.suppliers.service.requestSync(ctx, id))) return fail(409, 'sync_in_progress', 'A sync for this supplier is already queued or running.');
    await audit(ctx, a.user.id, 'suppliers.sync', current.name);
    return jsonResponse(202, { supplier: connectionDto((await d.suppliers.repo.get(ctx.tenant.id, id))!) });
  }

  /** POST api-keys/:id/revoke (owners). Works on every plan, so access can always be cut. */
  async function revokeApiKey(req: Request, ctx: TenantContext, id: string): Promise<Response> {
    const a = await guard(req, ctx, { mutation: true, owner: true });
    if (a instanceof Response) return a;
    if (!UUID.test(id)) return fail(404, 'not_found', 'Key not found.');
    const k = await d.apiKeys.revoke(ctx.tenant.id, id, d.now());
    if (!k) return fail(404, 'not_found', 'Key not found, or already revoked.');
    await audit(ctx, a.user.id, 'api_keys.revoke', k.name);
    return jsonResponse(200, { key: keyDto(k) });
  }

  return {
    listSuppliers,
    createSupplier,
    updateSupplier,
    deleteSupplier,
    syncSupplier,
    listApiKeys,
    createApiKey,
    revokeApiKey,
    listLinks,
    createLink,
    updateLink,
    analyticsSummary,
    getPricing,
    putPricing,
    previewPricing,
    signIn,
    verify,
    signOut,
    me,
    listLeads,
    leadDetail,
    exportCsv,
    retryDelivery,
    getSettings,
    putBranding,
    putGate,
    putRouting,
    testRouting,
    getFeatures,
    putFeatures,
    listTeam,
    invite,
    resendInvite,
    changeRole,
    removeMember,
    authenticate,
    /** Tests: wait for background sign-in work. */
    settled: () => Promise.all([...pending]),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
