/**
 * Lead capture endpoints (Phase 7). Three paths, gated by plan:
 *   POST /leads/email          email gate — Free   (lead_email_gate)
 *   POST /leads/quote          quote request — Starter (quote_requests)
 *   POST /leads/leave-behind   branded PDF product sheet — Pro (all_lead_paths)
 *
 * Common rules: JSON bodies only; per-client rate limit; honeypot + fill-time bot screening
 * (bots get a normal-looking success and nothing is stored); explicit marketing consent recorded
 * with its text version; server-computed estimates only; CRM routing failures never lose a lead —
 * the lead is stored first, routing outcome is logged as an event.
 */
import type { TenantContext } from '@/server/tenancy/context';
import { leadSettings } from '@/server/tenancy/context';
import type { LeadEventKind, LeadSource } from '@/server/repos/types';
import type { ProspectSession } from '@/server/session';
import {
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  endSentence,
  looksAutomated,
  normalizeEmail,
  validateEmailGate,
  validateQuote,
} from '@/features/leads/rules';
import { priceOption, searchCatalog, type CatalogQuery } from '@/features/catalog/catalog';
import { buildLeaveBehind } from '@/features/pdf/leave-behind';
import { decodePng } from '@/imaging/png';
import { disclaimerFor, prospectLines } from '@/pricing/engine';
import { DECORATION_METHODS, isDecorationMethodKey } from '@/core/domain/decoration-methods';
import { isColorFamilyKey, type ColorFamilyKey } from '@/core/domain/color-families';
import type { DecorationMethodKey } from '@/pricing/types';
import type { ApiDeps } from './api';
import type { ProofService } from './proof-service';
import type { DeliveryService } from '@/server/leads/delivery';
import type { Tracker } from './tracking';
import { UUID, apiBase, body, clientIp, fail, jsonResponse, limited, locked, readJsonObject } from './shared';

type SessionHandle = { session: ProspectSession; isNew: boolean };

export interface LeadHandlerDeps {
  deps: ApiDeps;
  proofs: ProofService;
  sessionFor: (req: Request, ctx: TenantContext) => Promise<SessionHandle>;
  withSession: (res: Response, h: SessionHandle) => Promise<Response>;
  gateSummary: (ctx: TenantContext, s: ProspectSession) => unknown;
  delivery: DeliveryService;
  tracker: Tracker;
  now: () => Date;
  newId: () => string;
}

const spaced = (s: string) => s.replace(/_/g, ' ');

export function createLeadHandlers(h: LeadHandlerDeps) {
  const { deps, proofs, sessionFor, withSession, gateSummary, now, newId } = h;

  /** Store the lead + event FIRST, attach it to the session, then route to the CRM. */
  async function recordLead(
    ctx: TenantContext,
    sh: SessionHandle,
    input: { email: string; marketingOptIn: boolean; name?: string; company?: string; phone?: string },
    source: LeadSource,
    kind: LeadEventKind,
    rawDetail: Record<string, unknown>,
  ) {
    const at = now();
    // Which tracked link brought this prospect (ADR 0014): kept on the event and sent to the CRM.
    const link = await h.tracker.linkInfo(ctx, sh.session);
    const detail = link ? { ...rawDetail, trackedLink: link } : rawDetail;
    const { lead, created } = await deps.leads.upsertByEmail(
      ctx.tenant.id,
      { ...input, source, consentVersion: CONSENT_TEXT_VERSION },
      at,
    );
    await deps.leads.addEvent({
      id: newId(),
      tenantId: ctx.tenant.id,
      leadId: lead.id,
      kind,
      payload: { ...detail, consent: input.marketingOptIn ? { version: CONSENT_TEXT_VERSION, text: CONSENT_TEXT } : null },
      createdAt: at.toISOString(),
    });
    sh.session.leadId = lead.id;
    sh.session.email = lead.email;
    await deps.sessions.save(sh.session);
    await h.tracker.track(ctx, sh.session, 'lead');

    const contact = {
      ...(lead.name ? { name: lead.name } : {}),
      ...(lead.company ? { company: lead.company } : {}),
      ...(lead.phone ? { phone: lead.phone } : {}),
    };
    // Outbox: stored + attempted now; failures retried by the scheduled job (ADR 0008).
    await h.delivery.enqueue(ctx, lead.id, source, {
      tenantId: ctx.tenant.id,
      leadId: lead.id,
      email: lead.email,
      source,
      marketingOptIn: lead.marketingOptIn,
      contact,
      details: detail,
    });
    return { lead, created };
  }

  /** Shared preamble: flag, rate limit, JSON body. */
  async function begin(req: Request, ctx: TenantContext, flag: 'lead_email_gate' | 'quote_requests' | 'all_lead_paths') {
    const gate = locked(ctx, flag);
    if (gate) return { error: gate } as const;
    const rl = await limited(deps.limits.lead, `lead:${ctx.tenant.id}:${clientIp(req, deps.trustProxy)}`);
    if (rl) return { error: rl } as const;
    const b = await readJsonObject(req);
    if (!b) return { error: fail(400, 'invalid_body', 'Send a JSON object (max 16 KB).') } as const;
    return { body: b } as const;
  }

  const botSignals = (b: Record<string, unknown>) => ({ honeypot: b.website, startedAt: b.startedAt });
  const sham = () => jsonResponse(200, { ok: true }); // bots see success; nothing is stored

  /* ------------------------------ email gate ------------------------------ */

  async function captureEmail(req: Request, ctx: TenantContext): Promise<Response> {
    const start = await begin(req, ctx, 'lead_email_gate');
    if ('error' in start) return start.error;
    const b = start.body;
    if (looksAutomated(botSignals(b), now().getTime())) return sham();
    const v = validateEmailGate(b);
    if (!v.ok) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields: v.errors });
    const logoId = typeof b.logoId === 'string' && UUID.test(b.logoId) ? b.logoId : undefined;

    const sh = await sessionFor(req, ctx);
    await recordLead(ctx, sh, v.value, 'email_gate', 'captured', { ...(logoId ? { logoId } : {}) });
    return withSession(jsonResponse(201, { ok: true, gate: gateSummary(ctx, sh.session) }), sh);
  }

  /* ------------------------------ quote request ------------------------------ */

  async function requestQuote(req: Request, ctx: TenantContext): Promise<Response> {
    const start = await begin(req, ctx, 'quote_requests');
    if ('error' in start) return start.error;
    const b = start.body;
    if (looksAutomated(botSignals(b), now().getTime())) return sham();
    const v = validateQuote(b);
    if (!v.ok) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields: v.errors });
    const q = v.value;

    const resolved = await proofs.resolveConfiguration(ctx, { product: q.product, color: q.color, method: q.method, location: q.location });
    if (!resolved.ok) return resolved.response;
    const c = resolved.config;

    const logoId = typeof b.logoId === 'string' && UUID.test(b.logoId) ? b.logoId : null;
    const logo = logoId ? await deps.logos.get(ctx.tenant.id, logoId) : null;
    if (logoId && !logo) return fail(404, 'logo_not_found', 'Logo not found.');

    // The estimate is recomputed here from the tenant's pricing config — never taken from the client.
    const opt = c.product.methods.find((m) => m.method === c.method && m.location === c.location)!;
    const priced = priceOption(
      c.product,
      opt,
      q.quantity,
      Boolean(c.variant.isDark),
      logo ? { colorCount: logo.palette.colorCount, isPhotographic: logo.palette.isPhotographic } : { colorCount: 1, isPhotographic: false },
      ctx.tenant.pricingConfig,
    );
    // Internal breakdown (cost + margin) for the distributor's lead record and CRM only.
    const estimate = { unit: priced.unit, total: priced.total, lines: priced.quote.lines, estimated: true, disclaimer: disclaimerFor(ctx.tenant.pricingConfig) };
    const prospectEstimate = {
      unit: priced.unit,
      total: priced.total,
      lines: ctx.tenant.pricingConfig.showItemizedToProspect ? prospectLines(priced.quote) : null,
      estimated: true,
      disclaimer: estimate.disclaimer,
    };
    const detail = {
      product: { slug: c.product.slug, name: c.product.name, brand: c.product.brand },
      color: { name: c.variant.name, hex: c.color },
      decoration: { method: c.method, label: DECORATION_METHODS[c.method].label, location: c.location, imprintIn: { w: opt.w, h: opt.h } },
      quantity: q.quantity,
      estimate,
      notes: q.notes,
      ...(logo
        ? {
            logoId: logo.id,
            proofPath: `${apiBase(ctx)}/proofs?${new URLSearchParams({ logo: logo.id, product: c.product.slug, color: c.color, method: c.method, location: c.location })}`,
          }
        : {}),
    };

    const sh = await sessionFor(req, ctx);
    await recordLead(ctx, sh, { email: q.email, marketingOptIn: q.marketingOptIn, name: q.name, company: q.company, phone: q.phone }, 'quote_request', 'quote_requested', detail);
    const who = leadSettings(ctx).contactName ?? ctx.tenant.branding.displayName;
    return withSession(
      jsonResponse(201, { ok: true, message: `${endSentence(`Sent to ${who}`)} They'll reply to ${q.email}.`, estimate: prospectEstimate, gate: gateSummary(ctx, sh.session) }),
      sh,
    );
  }

  /* ------------------------------ PDF leave-behind ------------------------------ */

  async function leaveBehind(req: Request, ctx: TenantContext): Promise<Response> {
    const start = await begin(req, ctx, 'all_lead_paths');
    if ('error' in start) return start.error;
    const b = start.body;
    const sh = await sessionFor(req, ctx);

    // A prospect who already gave their email this session isn't asked again (no form → no bot check).
    let email = sh.session.email ?? null;
    let marketingOptIn = false;
    if (b.email !== undefined) {
      if (looksAutomated(botSignals(b), now().getTime())) return sham();
      const v = validateEmailGate(b);
      if (!v.ok) return fail(422, 'invalid_body', 'Check the highlighted fields.', { fields: v.errors });
      email = v.value.email;
      marketingOptIn = v.value.marketingOptIn;
    }
    if (!email || !normalizeEmail(email)) return fail(422, 'invalid_body', 'Enter your email to download the product sheet.', { fields: { email: 'Enter a valid email address.' } });

    const logoId = typeof b.logoId === 'string' && UUID.test(b.logoId) ? b.logoId : '';
    const logo = logoId ? await deps.logos.get(ctx.tenant.id, logoId) : null;
    if (!logo) return fail(404, 'logo_not_found', 'Upload a logo first.');
    const qty = Number(b.qty ?? 144);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) return fail(422, 'invalid_body', 'Invalid quantity.', { fields: { qty: 'Enter a quantity from 1 to 100000.' } });

    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const families = arr(b.families).filter(isColorFamilyKey) as ColorFamilyKey[];
    const methods = arr(b.methods).filter((m) => isDecorationMethodKey(m) && ctx.methods.includes(m)) as DecorationMethodKey[];
    const categories = arr(b.categories).slice(0, 20);
    const query: CatalogQuery = {
      quantity: qty,
      logo: { colorCount: logo.palette.colorCount, isPhotographic: logo.palette.isPhotographic },
      entitledMethods: ctx.methods,
      ...(families.length ? { colorFamilies: families } : {}),
      ...(methods.length ? { methods } : {}),
      ...(categories.length ? { categories } : {}),
    };
    const items = searchCatalog(await deps.products.list(ctx.tenant.id), query, ctx.tenant.pricingConfig).items.slice(0, 12);
    if (!items.length) return fail(422, 'invalid_body', 'No products match those filters.');

    const lbItems = [];
    for (const i of items) {
      const r = await proofs.resolveConfiguration(ctx, { product: i.slug, color: i.color.hex, method: i.recommended.method, location: i.recommended.location });
      let proof = null;
      if (r.ok) {
        const pr = await proofs.getProof(ctx, logo, r.config, () => limited(deps.limits.proof, `proof:${ctx.tenant.id}:${clientIp(req, deps.trustProxy)}`));
        if (pr.status === 'refused') return pr.response;
        if (pr.status === 'ready') proof = decodePng(pr.png);
      }
      lbItems.push({
        name: i.name,
        brand: i.brand,
        colorName: i.color.name,
        methodLabel: DECORATION_METHODS[i.recommended.method].label,
        placement: `${i.recommended.imprint.widthIn} × ${i.recommended.imprint.heightIn} in on the ${spaced(i.recommended.location)}`,
        proof,
        unit: i.recommended.unit,
        total: i.recommended.total,
        breaks: i.priceBreaks.map((x) => ({ minQty: x.minQty, unit: x.unit })),
      });
    }
    const clean = await deps.storage.get(logo.cleanKey, ctx.tenant.id);
    if (!clean) return fail(404, 'logo_not_found', 'Logo image missing.');

    const settings = leadSettings(ctx);
    const pdf = buildLeaveBehind({
      tenantName: ctx.tenant.branding.displayName,
      brandHex: ctx.tenant.branding.primaryHex,
      contactName: settings.contactName ?? ctx.tenant.branding.displayName,
      preparedFor: email,
      date: now(),
      quantity: qty,
      logo: decodePng(clean.data),
      items: lbItems,
      disclaimer: disclaimerFor(ctx.tenant.pricingConfig),
    });

    await recordLead(ctx, sh, { email, marketingOptIn }, 'pdf_leavebehind', 'leave_behind', {
      logoId: logo.id,
      quantity: qty,
      products: items.map((i) => i.slug),
    });
    return withSession(
      new Response(body(pdf), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${ctx.tenant.slug}-product-sheet.pdf"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      }),
      sh,
    );
  }

  return { captureEmail, requestQuote, leaveBehind };
}
