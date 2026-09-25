# ADR 0008 — Tenant admin: sign-in, lead inbox, settings; webhook hardening and delivery outbox

**Status:** Accepted · **Date:** 2026-09-23 · **Supersedes:** the Auth.js choice in ADR 0001 ·
**Amends:** ADR 0007 (webhook SSRF check, secret storage, re-delivery)

## Context
Tenants need to see their leads, change their storefront and gate, and connect a CRM. That needs
staff sign-in, and it makes webhook settings tenant-editable. ADR 0007 left three gaps that become
urgent once tenants type in URLs and secrets: a hostname-only SSRF check, plaintext secrets, and no
re-delivery of failed leads.

## Decisions

### 1. First-party magic-link sign-in instead of Auth.js
Auth.js's email sign-in needs its own adapter tables and looks users up by email across the whole
database. Our `users` table is tenant-scoped under forced RLS, and the same email can be an admin
of two tenants. Its OAuth sign-in would need a redirect URI registered per custom domain. So:

- **Per-tenant accounts.** Sign-in happens on the tenant's own host (`/admin`), and every lookup
  runs inside that tenant's RLS context. `users` is unique on (tenant, email).
- **Magic links.** A 256-bit token, stored only as SHA-256, valid for 15 minutes, single use
  (consumed by one conditional `UPDATE … RETURNING`, so two clicks can't both win).
- **The token rides in the URL fragment** (`/admin/verify#token=…`). Browsers never send
  fragments to servers, logs or `Referer`. The page needs a click to POST it, so corporate
  link-scanners that open the page don't use up the link.
- **Links are built from configuration** (`PUBLIC_BASE_URL`, or the tenant's entitled custom
  domain, or `<slug>.<BASE_DOMAIN>`), never from the request's Host header, which an attacker
  controls.
- **No account enumeration.** Sign-in always answers 202 with the same text. The lookup, token
  and email run off the response path, and there's a per-address cap (5 per 15 minutes) on top of
  the per-client limit.
- **Sessions are server-side.** The cookie holds a random token; the table stores its hash, a
  CSRF token, a 12-hour absolute expiry and a revocation time. The cookie name includes the
  tenant, and it's `HttpOnly; SameSite=Lax` (`Secure` in production). Sign-out revokes
  server-side, so an old copy of the cookie is dead.
- **CSRF.** Every mutation needs the session's token in `x-csrf-token`. Requests marked
  `Sec-Fetch-Site: cross-site` are refused, including sign-in and verify (login CSRF).
- **Roles.** `tenant_owner` and `tenant_admin`. Only owners change where leads go, since that
  sends customer data off-platform.
- Email goes through an `EmailProvider`: `log` in development, Resend in production (production
  refuses to start with `log`). Admins are added with `npm run admin:add`, or `SEED_ADMIN_EMAIL`.
- SSO for Enterprise remains a separate seam; nothing here precludes it.

### 2. Admin API and UI
Mounted at `/api/t/<ref>/admin/*` beside the storefront API, sharing the same tenant resolution,
entitlement checks and rate limiting. Responses are `no-store`. The inbox is keyset-paginated
(stable while new leads arrive), filterable by search, source and "needs attention". CSV export
quotes every cell and prefixes formula-leading values with `'` (CSV injection). Settings writes go
through the tenant directory so it drops its cache: the storefront sees a change on its next
request (other instances within the 5 s cache TTL). Every sign-in, export, retry and settings
change is written to `audit_log`; the settings page shows the last ten with who made them.

Plan gates are enforced server-side exactly as on the storefront: custom look needs Starter
(`custom_branding`), CRM webhooks need Pro (`crm_webhook_routing`). The UI disables and explains;
the API refuses regardless.

### 3. Webhook SSRF protection at connect time (amends ADR 0007 §7)
`src/server/net/address-guard.ts` is installed as the socket's DNS `lookup`. It resolves every
address for the host and refuses the connection if **any** is private, loopback, link-local,
CGNAT, metadata, multicast, reserved, or an IPv6 range that embeds IPv4 (NAT64, 6to4, Teredo).
Node's `BlockList` also matches IPv4-mapped IPv6 against the IPv4 rules. Because the guard *is*
the lookup, the checked address is the connected address: no DNS-rebinding window. No keep-alive
agent (each delivery re-resolves), no redirects (3xx is a failure), 5 s timeout, response body
capped. The settings form also rejects IP literals in any spelling the URL parser normalises
(`2130706433`, `0x7f.1`, `[::ffff:7f00:1]`) with a clear message.

### 4. Secrets encrypted at rest (amends ADR 0007)
Webhook signing secrets are generated server-side (`whsec_…`), shown to the owner once, and stored
sealed with AES-256-GCM (`src/server/crypto/secret-box.ts`). The tenant id is authenticated data,
so a ciphertext copied into another tenant's settings fails to open. Values carry a key id, and
`SETTINGS_ENCRYPTION_KEYS` is a keyring (first key seals, all keys open) for rotation. Required in
production. Settings rows with a legacy plaintext `secret` are ignored (routing falls back to the
inbox) rather than trusted.

### 5. Delivery outbox and retries (amends ADR 0007 §3)
One `lead_deliveries` row per capture holds the exact payload, status, attempt count and next
attempt time. A per-lead status couldn't work: a lead that gave an email and later asked for a
quote has two deliveries, and a later success must not hide an earlier failure. Each capture is
attempted immediately; failures retry after 1 min, 5 min, 30 min, 2 h and 12 h, then become `dead`
(visible, never retried automatically; an admin can retry by hand). Workers claim due rows with a
lease (`FOR UPDATE SKIP LOCKED` in Postgres), so several can run at once. Payloads carry a stable
`deliveryId` for receiver-side dedupe. Retries run in-process (`DELIVERY_WORKER=inline`) or from
cron (`npm run jobs:deliveries`).

### 6. Entitlement on every delivery (bug fix)
`crm_webhook_routing` was defined but never checked, so a downgraded tenant kept routing leads to
its webhook. The CRM router now checks it on every attempt, retries included. A downgraded
tenant's saved webhook is kept but paused, and the admin says so.

### 7. Client IP handling (bug fix)
`clientIp` read `X-Real-IP` even when the proxy wasn't trusted, so anyone could rotate that header
to dodge rate limits. Without `TRUST_PROXY=true`, all requests now share one bucket. Real
deployments must set `TRUST_PROXY` behind their proxy.

## Consequences
- (Superseded by ADR 0011: owners now invite and manage people from the Team tab.) Staff could only be added from the command line or seed; an in-app "invite teammate" flow
  is the natural next step.
- Rate limits and the sign-in per-address cap were per process here (ADR 0007); ADR 0010 made them shared across instances.
- Expired login tokens and sessions accumulate; a periodic sweep should delete them.
- The Resend adapter is checked only against its request shape, not the live service.
- Settings changes can take up to 5 s to reach other app instances.
- The admin page's shell (masthead colours) reflects branding on the next page load, not instantly.

## Verification
- `src/server/delivery.test.ts` (13): address guard incl. mixed DNS answers and mapped IPv6,
  no-redirect, signing, secret box (tenant binding, tampering, rotation), backoff with a controlled
  clock, byte-identical payload on retry, dead-lettering, leases, entitlement per attempt.
- `src/server/admin.test.ts` (15): no enumeration, Host-header-proof links, single-use and expiring
  tokens, cross-tenant token and cookie replay, login CSRF, per-address cap, sign-out revocation,
  session expiry, CSRF on mutations, owner-only routing, plan gates, settings reaching the
  storefront, secret shown once and stored sealed, signed ping, inbox paging/filters/isolation,
  manual retry, inbox-vs-CRM status, CSV injection defusing, audit.
- 16 targeted mutations (6 delivery, 10 admin) each fail at least one test; control mutations
  survive. One more (removing IPv4-mapped unmapping) survived because Node's `BlockList` already
  does it, so that code was removed rather than kept untested.
- `npm run e2e:admin` (28 checks, headless Chromium, real components and API): the full sign-in
  via the emailed link, inbox, search, detail, settings, a real webhook receiver, a failed delivery
  retried by hand, CSV download, owner vs staff, Free plan, mobile 390 px, no console errors.
  Screenshot review caught two bugs the assertions had missed (inbox-only leads stamped "Sent to
  CRM"; list clipped on mobile), both fixed and now asserted.
