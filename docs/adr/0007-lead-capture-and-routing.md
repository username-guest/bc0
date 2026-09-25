# ADR 0007 — Lead capture: prospect sessions, lead persistence, CRM routing

**Status:** Accepted, amended by ADR 0008 (connect-time SSRF guard, sealed secrets, delivery outbox) · **Date:** 2026-09-23

## Context
Phase 7 turns the storefront into a lead source. Three capture paths, each tied to a plan:

| Path | Flag | Plan |
|---|---|---|
| Email gate on proofs | `lead_email_gate` | Free |
| Per-product quote request | `quote_requests` | Starter |
| Branded PDF leave-behind | `all_lead_paths` | Pro |
| Webhook routing to the tenant's CRM | `crm_webhook_routing` | Pro |

Prospects are anonymous until they give an email, so we need a way to recognise them across
requests. Leads are the product's reason to exist: losing one is worse than any other failure in
this phase.

## Decisions

1. **Anonymous prospect sessions, HMAC-signed and tenant-scoped.** A session cookie carries a
   random ID signed with HMAC-SHA256 (`src/server/session.ts`). The store keys each session to one
   tenant: a cookie from tenant A presented to tenant B is treated as absent, and a new session is
   issued. Sessions expire after 30 days (`SESSION_TTL_SEC`). The session records proofs viewed
   and whether the prospect has unlocked the gate. It is the only per-prospect state the server
   trusts.

2. **The gate is enforced server-side, on the proof and catalog endpoints.** Gate modes are
   `off`, `soft` and `hard`, with a free-proof allowance (default: `soft`, 3 proofs). In `hard`
   mode the proof endpoint refuses further proofs until the session holds a captured email; the
   catalog marks locked products. The browser only mirrors this for presentation, as with all
   flags (ADR 0003).

3. **Store first, route second.** Every capture writes the lead and a `lead_events` row, attaches
   the lead to the session, and only then calls the CRM. A delivered lead gets a `routed` event; a
   failed delivery gets `routing_failed` with the error. The prospect's request succeeds either
   way. A retry job can re-deliver from `routing_failed` events (not built yet). Leads are
   deduplicated per tenant on the lower-cased email (unique index), and repeat captures add events
   rather than new rows.

4. **The server prices every quote.** The quote form sends product, colour, method, quantity and
   locations; the server re-runs the pricing engine and stores its own estimate. Client-supplied
   prices are ignored. The estimate keeps the `estimated` flag and disclaimer from the engine.

5. **Consent is explicit, versioned and one-way.** Marketing opt-in is recorded only when the
   request carries `marketingOptIn === true`, together with `CONSENT_TEXT_VERSION`, so each
   record says exactly what the prospect agreed to. A later form submitted without the box ticked
   never revokes an earlier opt-in; revocation belongs to an explicit unsubscribe path.

6. **Bot screening is cheap and silent.** Forms carry a honeypot field and a render timestamp;
   submissions that fill the honeypot or arrive under 1.5 s are accepted with a normal-looking
   response and not stored. Lead endpoints are rate-limited per IP and tenant.

7. **Webhook routing is treated as an SSRF surface.** Tenants configure a destination URL, so
   `src/shared/providers/webhook-crm.ts`:
   - requires `https`, rejects URLs with embedded credentials, and refuses hostnames that name
     localhost, `*.internal`, or a literal private, loopback, link-local, CGNAT or cloud-metadata
     address (IPv4, plus IPv6 loopback/ULA/link-local);
   - sets `redirect: 'error'`, so a public host cannot bounce the request inward;
   - times out after 5 s;
   - signs the body as `t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<body>"))` so receivers can
     verify origin and reject replays.
   Tenants below Pro, or without a configured webhook, route to the mock provider.

8. **The PDF leave-behind is generated in-process with no dependencies.** A small PDF 1.4 writer
   (`src/features/pdf`) embeds the tenant's branding, the prospect's proofs (RGBA via Flate +
   SMask) and the price breaks. Capturing the email is the price of the download.

## Consequences
- The session table grows with anonymous traffic; expired rows need a periodic sweep.
- Rate limits are per process (`FixedWindowLimiter`). Multi-instance deploys need a shared store.
- Webhook secrets sit in `tenant_settings` as plain JSON. They should move to encrypted storage
  before real tenants configure production CRMs.
- **The SSRF check is lexical, not network-level.** It inspects the hostname only. A public
  name whose DNS points at a private address passes, and so does an IPv4-mapped IPv6 literal
  (`[::ffff:7f00:1]`). Before real tenants configure webhooks, resolve the host, check every
  returned address, and pin the connection to the checked address (which also closes DNS
  rebinding). Until then, deploy the app where outbound traffic to internal ranges is blocked
  at the network layer.
- Re-delivery of `routing_failed` leads is a documented gap, not a silent one: the data to retry
  is always stored.

## Verification
`src/server/leads.test.ts` (24 tests) covers rules, sessions, cross-tenant session reuse, the
hard gate, server-side quote pricing, consent upgrades, bot screening, SSRF refusal, routing
failure and PDF output. Seven security-relevant mutations to this code were each caught by at
least one failing test. The browser suite
drives the full flow: upload → gate → email → all proofs → quote → PDF download rendered by pdf.js.
