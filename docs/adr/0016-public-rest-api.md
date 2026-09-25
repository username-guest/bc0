# ADR 0016 — Public REST API and API keys

**Status:** Accepted · **Date:** 2026-09-24 · Builds on ADR 0002 (RLS), 0003 (flags), 0008 (admin), 0014 (analytics)

## Context
Enterprise distributors want their own systems (a CRM sync, a data warehouse, an internal
dashboard) to read what BrandCanvas collects without anyone exporting CSVs. The webhook from ADR
0007 pushes each lead once; it can't backfill, re-read a lead's history, or pull the catalog
and funnel numbers. The plan catalog already listed "API access" as an Enterprise entitlement
(`api_access`) with nothing behind it.

## Decisions
1. **Read-only, v1.** Four endpoints, all `GET`:
   - `v1/leads?limit=1..100&cursor=&source=` newest first, keyset-paginated (`nextCursor`);
   - `v1/leads/:id` the lead plus its history (captures, quote requests, CRM routing);
   - `v1/products?qty=` the catalog with estimated *selling* prices at a quantity, exactly as the
     storefront shows them, with the tenant's pricing disclaimer;
   - `v1/analytics?days=7|30|90|365` the dashboard's funnel numbers (ADR 0014), UTC days.

   Writing (creating leads, editing products) is out of scope until a customer needs it; read
   access covers every integration asked for so far and is far easier to make safe.
2. **Costs never leave.** Product responses carry selling prices only: no blank cost, margin or
   rate-table data, whatever scope the key has. A test asserts this on the raw response body.
3. **Keys, not sessions.** `Authorization: Bearer bck_<keyId>_<secret>`: a 12-character public
   id (used to look the key up) and a 256-bit random secret. Only a SHA-256 of the secret is
   stored, compared in constant time; the full key is shown once at creation, then only a hint
   (`bck_<keyId>_…`). The API reads no cookies and sends no CORS headers, so a browser can't
   call it with an admin's session, and keys aren't meant to live in browsers.
4. **Keys are tenant-scoped twice.** The API is served on the tenant's own host (`/api/v1/…`,
   rewritten to `/api/t/<ref>/v1/…`), and the key is looked up inside that tenant under RLS. A
   key from one tenant is simply unknown to another; `api_keys` is in the RLS table list and
   `rls.test.ts` proves an unfiltered select, a revoke and a planted insert all fail across
   tenants. In path mode the base URL is `${PUBLIC_BASE_URL}/api/t/<slug>/v1`, because
   `/t/<slug>/…` is the storefront (`makeApiUrl`, beside `makeAdminUrl`).
5. **Scopes.** `leads:read`, `catalog:read`, `analytics:read`, chosen per key. A missing scope is
   `403 insufficient_scope`, naming the scope needed. Analytics also still needs the analytics
   entitlement.
6. **The plan is checked on every request**, not at creation. If the tenant drops below
   Enterprise, or the platform switches `api_access` off, existing keys get `403 feature_locked`
   at once and work again if access returns. Revoking works on every plan, so an owner can always
   cut access.
7. **Owners only, at most 20 active keys.** Creating and revoking keys is an owner action
   (admins see nothing), audited as `api_keys.create` / `api_keys.revoke`. Revocation is
   immediate and permanent; a revoked key stays listed, marked Revoked.
8. **Rate limit per key**, 600 requests a minute in the shared Postgres store (ADR 0010), so one
   runaway script can't starve the tenant's other keys. `last_used_at` is written at most once a
   minute per key so a busy key doesn't turn every read into a write.
9. **Errors** use the same `{ error: { code, message } }` shape as the rest of the API.

## Consequences
- Migration `drizzle/0003_public_api_keys.sql` adds `api_keys`; the RLS policy file already
  covers it.
- Settings has an **API keys** section for owners on Enterprise (other plans see a one-line
  note). Tested in the browser suites, including calling the advertised URL with the new key,
  scope refusal, and a revoked key failing at once; `smoke:pg` covers the same journey as the app
  role against the production build.
- Not built: write endpoints, webhooks-by-subscription, per-key IP allowlists, key expiry, and
  OpenAPI docs published to tenants. Each can be added without changing the key format.
