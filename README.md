# BrandCanvas

Multi-tenant, white-label lead-generation tool for promotional-products distributors.
A prospect uploads a logo, sees it rendered on real promo products, browses a dynamic
catalog with live **estimated** pricing, and converts into a lead.

> **Build status:** foundation phase. See `docs/BUILD-PLAN.md` for exactly what is built,
> what is stubbed behind an interface, and what is not yet started. This is **not** a
> finished product — it is a correct, phased foundation with two fully-implemented and
> tested logic cores (pricing, feature flags) and the architectural seams for the rest.

## See it
`npm run demo` (no install needed, Node ≥ 22.18) writes `demo/index.html`: logo upload → cleanup →
Brand-Exact proofs → priced, faceted catalog with a quantity switcher → every decoration method.

## What actually works right now
- **Core loop, headless** (`src/imaging`, `src/features`): logo intake and cleanup, colour
  counting, deterministic Brand-Exact proofs for all 9 methods, and a priced, faceted catalog.
- **Pricing engine** (`src/pricing`): all 9 decoration methods modelled per industry
  conventions, itemized breakdown, admin-configurable rules, unit-tested. All rate tables
  are labelled `PLACEHOLDER` and every quote is flagged `estimated` with a disclaimer.
- **Feature-flag + entitlement evaluator** (`src/flags`): server-authoritative, correct
  precedence chain (kill-switch → plan → tenant → user → default), unit-tested.
- **Provider abstractions** (`src/shared/providers`): the upgrade seam. Every external
  capability (image gen, bg removal, storage, product data, pricing, CRM, vision) is an
  interface with a working mock, so the app runs without any external service wired.
- **Tenancy + RLS model** (`src/core/db`): Postgres row-level security, `tenant_id` on every
  domain row, `withTenant()` transaction wrapper, and an isolation test (see caveat below).
- **Multi-tenant storefront** (`src/server`, `src/ui`, `src/app`): subdomain / path / custom-domain
  routing, per-request server-side entitlements, logo upload (PNG/JPEG/WebP/SVG), cached proofs,
  priced faceted catalog, white-label branding — driven end to end in a real browser.
- **Lead capture** (`src/features/leads`, `src/server/http/leads-api.ts`, `src/ui/LeadForms.tsx`):
  email gate (Free), server-priced quote requests (Starter), branded PDF leave-behind (Pro), and
  signed webhook routing to the tenant's CRM (Pro). Leads are stored before routing, so a CRM
  outage never loses one.
- **Tenant admin** (`src/server/http/admin-api.ts`, `src/ui/admin`, `/t/<slug>/admin`): passwordless
  sign-in by emailed link, a lead inbox with CSV export and manual CRM retries, and settings for
  storefront look, email gate and where leads go. Failed CRM deliveries retry automatically; the
  webhook guard checks resolved addresses at connect time and secrets are encrypted at rest.
- **Pricing admin** (`src/pricing/config-validation.ts`, `src/ui/admin/PricingPanel.tsx`): each
  distributor sets its own markups, fees and decoration rates for all 9 methods, with a live preview
  of every product's price before saving. Prospects see selling prices only, never cost or margin.
- **Tracked links and analytics** (`src/features/analytics`, `src/server/http/tracking.ts`,
  `src/ui/admin/AnalyticsPanel.tsx`): a short `?src=` link per place the storefront is shared, and a
  dashboard of visitors, proofs and leads per day and per link. Counts sessions once per day, stores
  no IP or personal data, and passes the link into each lead and its CRM payload (ADR 0014).
- **Background proof rendering** (`src/server/jobs/proofs.ts`): an upload queues the catalog's
  first-page proofs and a worker renders them, so prospects get cached images instead of waiting
  for each render (ADR 0015).
- **Decision records** (`docs/adr`): stack, tenancy/RLS, flags, image provider, renderer, app shell,
  lead capture, tenant admin, pricing admin, production readiness, team, browsers, feature
  switches, tracked links and analytics, proof pre-rendering, public REST API, PromoStandards supplier connections, serverless background work (Vercel).

## What is stubbed or not yet built
To host it on Vercel, follow `docs/DEPLOY-VERCEL.md`. See `docs/BUILD-PLAN.md`. In short: the read-only public REST API (ADR 0016) and PromoStandards supplier connections
(ADR 0017, not yet tried against a real supplier) are built; Salesforce and SSO are pending. Storage (local or S3), shared rate limits and maintenance are built
(ADR 0010), and so is team management (ADR 0011).

## Setup
Two database roles, on purpose:
- `MIGRATION_DATABASE_URL` — owner role. Runs migrations, RLS policies, seed. Never used by the app.
- `DATABASE_URL` — `brandcanvas_app`, non-superuser, no BYPASSRLS. The only role the app uses.

```bash
cp .env.example .env        # set both URLs. Providers default to mocks.
npm install
npm run db:setup            # apply committed migrations → RLS policies → seed (all as owner)
# once, per environment: give the app role a login
psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE brandcanvas_app LOGIN PASSWORD '...';"
npm run test                # unit; RLS isolation test runs when both URLs are set
npm run build && npm run smoke:pg   # end-to-end against Postgres (app role needs LOGIN)
```
`npm run dev` serves the storefront at `http://localhost:3000/t/demo` (Free plan: `/t/basic`) and
the admin at `/t/demo/admin` (Leads, Analytics, Pricing, Team and Settings tabs). In memory mode, sign in as `owner@demo.test` (or `staff@demo.test`,
`owner@basic.test`): with `EMAIL_PROVIDER=log` the sign-in link is printed to the server console.
Owners can switch storefront features off under Settings → Storefront features (ADR 0013).
Inviting teammates is an Enterprise feature (§7 "Multi-user admin"): try it as `owner@bigco.test` at
`/t/bigco/admin`. With Postgres, create the first owner with
`npm run admin:add -- demo you@company.com tenant_owner`; after that, Enterprise owners invite everyone
else from the Team tab (invite links work once, for 3 days), and on other plans operators add people
with the same command.

Production needs, beyond the database URLs: `AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEYS`
(`id:$(openssl rand -base64 32)`), `EMAIL_PROVIDER=resend` + `RESEND_API_KEY`, and `TRUST_PROXY=true`
behind your proxy (otherwise every client shares one rate-limit bucket).
With `DATA_MODE=memory` (the default) no database is needed. `npm run dev:api` runs the same tenant
API with zero dependencies installed.

## Scripts
| Script            | Purpose                                            |
|-------------------|----------------------------------------------------|
| `npm run dev`     | Next.js dev server                                 |
| `npm run typecheck` | `tsc --noEmit` (strict)                          |
| `npm run lint`    | ESLint                                             |
| `npm run test`    | Vitest (unit + integration)                        |
| `npm run db:setup` | Apply committed migrations + RLS policies + seed (owner role) |
| `npm run db:check` | Fails if `schema.ts` changed without a committed migration (runs in CI) |
| `npm run test:offline` | Pure suites via Node's native TS — no `npm install` needed |
| `npm run demo` | Build the core-loop demo page from the real modules |
| `npm run dev:api` | Tenant API over node:http, no install needed (host-based tenant routing) |
| `npm run typecheck:offline` | Strict tsc with stubs only for uninstalled packages |
| `npm run smoke:http` | Tenant API over real sockets: routing, isolation, gates |
| `npm run smoke:pg` | Production build (`next start`) against Postgres: upload → catalog → proof → lead → admin sign-in → pricing save, checking the rows after each step. Needs `npm run build` + `db:setup` first |
| `npm run e2e:browser` | Real storefront UI in headless Chromium against the real API |
| `npm run e2e:admin` | Real admin UI in headless Chromium: sign-in, inbox, settings, webhook |
| `npm run e2e:safari` | Both suites in WebKit, Safari's engine (`npx playwright install webkit` first). `E2E_BROWSER=webkit\|firefox` works on either suite |
| `npm run admin:add` | Create a tenant's first owner (Postgres); invite the rest from the Team tab |
| `npm run jobs:deliveries` | One pass of CRM delivery retries (for cron, with `DELIVERY_WORKER=off`) |
| `npm run jobs:proofs` | One pass of queued proof renders; `-- --watch` runs as a dedicated worker (with `PROOF_WORKER=off`) |
| `npm run jobs:suppliers` | Queued supplier syncs and the daily refresh (ADR 0017); `-- --watch` runs as a dedicated worker (with `SUPPLIER_WORKER=off`) |
| `npm run verify:pricing` | Dependency-free arithmetic check of the pricing engine (runs without `npm install`) |

## Changing the database schema
Edit `src/core/db/schema.ts`, run `npm run db:generate`, review the new file in `drizzle/`, and
commit both together. Never edit or regenerate a migration that has already been applied anywhere;
add a new one. `npm run db:check` (also in CI) fails if the schema and the committed migrations
disagree. RLS policies live separately in `db/policies/` (a new tenant-scoped table must be added
to `TENANT_SCOPED_TABLES` and the policy file).

## Browser support (ADR 0012)

Safari and iOS Safari **15.4+** (March 2022), plus current Chrome, Edge and Firefox. 15.4 is the floor
because the admin uses `structuredClone` and the CSS uses `overflow-wrap: anywhere`, `:focus-visible`
and `accent-color`. Safari-specific behaviour the code accounts for:

- **Cookies.** Safari drops `Secure` cookies on plain-http origins, `http://localhost` included (Chrome
  exempts localhost). `Secure` therefore follows the scheme of `PUBLIC_BASE_URL` when it is set, and
  NODE_ENV only when it isn't (`cookiesSecure()` in `src/core/config/env.ts`). Before this, a production
  build run locally over http lost every sign-in in Safari.
- **iPhone zoom.** iOS Safari zooms into any text field under 16px when it's tapped. On phones and
  touch devices every text field is at least 16px; both browser suites measure every visible field.
- **No hidden sideways scrolling** on phones: the browser suites fail if anything, even inside a
  scrolling box, sits past the 390px screen edge.

Chromium phone emulation checks the layout rules above. For WebKit rendering itself, run
`npm run e2e:safari` on a Mac (Playwright's WebKit is closest to Safari there).

## Honesty / guardrails (from the spec, enforced here)
- **No real supplier pricing exists.** Every number is a `PLACEHOLDER` and every quote is
  labelled *estimated* with a disclaimer. Real data arrives later via `PricingProvider` /
  `ProductDataProvider` (PromoStandards adapter seam).
- **No image is silently shipped at low confidence.** `VisionAnalyzer` returns a confidence;
  below threshold the pipeline is designed to force manual zone placement (Stage D).
- **Entitlement is never trusted from the client.** `useFeature()` only gates presentation.

## Verification
See `docs/BUILD-PLAN.md` for every run. The last full release check (one tarball, Node 24,
Postgres 18, 2026-09-24) passed every CI step: lint, type-check, build, migration drift check,
238 unit and integration tests, 41 Postgres smoke checks, and the storefront (29) and admin (60)
browser suites in both Chromium and WebKit. Phase 8 (tracked links and analytics) passes the
offline suites and both browser suites locally; its Postgres run is part of the next release check.

Without a local install, point the offline scripts at another node_modules (e.g. a global one):
`BC_EXTRA_MODULES=/path/to/node_modules npm run e2e:browser`.
