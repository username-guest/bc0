# Build plan & status (§14 phases)

Legend: [x] done  ·  [~] partial / interface + mock only  ·  [ ] not started

## Phase 1 — Foundation
- [x] Repo structure, module boundaries, TS strict config, ESLint/Prettier
- [x] zod-validated env (`src/core/config/env.ts`), `.env.example`
- [x] CI pipeline (`.github/workflows/ci.yml`: lint → typecheck → test → build)
- [~] DB schema (18 of the §10 entities incl. all reference tables; the rest follow the same shape)
- [x] Migration flow: drizzle-kit generate/migrate + separate RLS policy file, owner vs app roles
- [x] Tenancy + RLS (ENABLE+FORCE, closed default) + `withTenant()` + isolation test (CI job runs it as the app role)
- [x] Idempotent seed: plans, all flags, 15 colour families, 9 methods, demo tenant, 6-product catalog
- [x] Domain modules: decoration-method registry + compatibility rules, colour-family classifier (tested)
- [x] Staff auth: first-party magic-link sign-in, server-side sessions, CSRF, roles (ADR 0008,
  supersedes the Auth.js choice in ADR 0001)

## Phase 2 — Flags & entitlements
- [x] Typed registry + evaluator + precedence chain + entitlement map + tests
- [x] Owner feature switches (ADR 0013): six storefront features, refine-only within the plan,
  owner-only, audited; Settings → Storefront features
- [ ] Platform kill-switch UI (operator action; SQL/CLI today)

## Phase 3 — Logo intake + cleanup + colour extraction
- [x] Intake service: magic-byte sniffing, size limits, SVG safety screen, typed errors, sha256 hash
- [x] Local PNG codec (all colour types/depths, palette+tRNS, CRC-checked, bomb guard)
- [x] Background removal (uniform bg, soft edges, colour decontamination, enclosed-area reporting)
- [x] Palette extraction in Lab space — AA-aware spot-colour count; photographic detection
- [x] `sharp` ImageCodec (JPEG/WebP/SVG tested with real sharp; PDF wired but untested)
- [x] Persistence: logo_assets (Drizzle) + StorageProvider (local FS with traversal-proof keys); upload dedupe by hash

## Phase 4 — Vision detection + mockup pipeline
- [x] Brand-Exact renderer: all 9 methods with physical constraints + legibility notes (ADR 0005)
- [x] Product templates (6 kinds), colourways, authored zones; confidence gate → needs_placement
- [x] Deterministic proofs + content-addressed cache key (renderer-versioned)
- [~] `VisionAnalyzer` + AI Lifestyle `ImageGenerationProvider`: interfaces + mocks only
- [x] Proof cache persisted in storage (content-addressed, ETag/304), render rate limit on cache misses
- [x] Template warm-up at server start (removes ~1.5 s cold cost from the first proof)
- [x] Background pre-rendering (ADR 0015): an upload queues the default catalog view's proofs in
  `mockup_jobs` (Postgres, RLS, leased claims, unique per proof); an inline worker or
  `npm run jobs:proofs` renders them; retries with backoff; 500-job cap per tenant; migration
  `drizzle/0002`. pg-boss dropped (ADR 0015 §2).
- [ ] Queue cancellation, per-plan render quotas, pre-rendering other quantities or filtered views

## Phase 5 — Catalog + faceted search + qty/price-break UI
- [x] Catalog service: compatibility ∩ entitlement ∩ logo suitability, cheapest-method pick,
      distinct alternatives, price-break preview, correct faceted counts
- [x] Offline demo page (`npm run demo`) showing the full core loop from the real modules
- [x] Tenant API: upload, cleaned-logo image, catalog, proofs, public config (ADR 0006)
- [x] Storefront UI (`src/ui`): upload + knockout question, quantity, facets, proof cards with
      renderer notes, price breaks, breakdown; mobile layout; driven in headless Chromium
- [~] Next.js mounting (middleware, layouts, catch-all route): thin, written, not yet built here

## Phase 6 — Pricing engine + admin config
- [x] Engine, per-method modules, itemized breakdown, tests, verified arithmetic
- [x] Per-tenant decoration rates for all 9 methods (were a global constant); placeholder fallback
- [x] Pricing admin (ADR 0009): markups (blank, decoration, per category), fees, rounding, breakdown
  visibility, rate tables incl. screen-print tiers; strict validation by field path; warnings
- [x] Live preview: every product at a sample order with unsaved values, beside current prices
- [x] Owner-only save, staff read-only, Starter plan gate, audited with a readable change summary
- [x] Bug fix: prospects were shown blank cost and margin; now selling prices only (`prospectLines`)
  and the "show breakdown" setting is honoured
- [ ] Multi-currency

## Phase 7 — Lead capture (3 paths) + routing
- [x] Anonymous prospect sessions: HMAC-signed cookie, tenant-scoped, 30-day TTL
- [x] Email gate (Free): off / soft / hard modes with a free-proof allowance, enforced server-side
- [x] Quote request (Starter): server re-prices every quote; client prices ignored
- [x] PDF leave-behind (Pro): dependency-free PDF writer, branded, with proofs and price breaks
- [x] Leads stored before routing; `routed` / `routing_failed` events; dedup on lower-cased email
- [x] Explicit, versioned, upgrade-only marketing consent; honeypot + timing bot screen
- [x] Signed webhook CRM routing (Pro) with https-only, host-pattern SSRF block, no redirects, 5 s timeout
- [x] "Keep as printed ink" persisted via `POST /logos/:id/confirm`
- [x] Retry job for failed deliveries; connect-time SSRF check; encrypted webhook secrets (ADR 0008)

## Phase 8 — PDF export + tracked links + analytics
- [x] PDF leave-behind built in Phase 7
- [x] Tracked links and funnel analytics (ADR 0014): short `?src=` codes per source, first-touch
  attribution on the prospect session, visits/proofs/leads counted once per session per UTC day,
  lead events and CRM payloads carry the link, Analytics admin tab (totals, daily chart, results by
  link, link management), Pro-gated with events recorded on every plan, 400-day retention.
  Migration `drizzle/0001`.
- [ ] QR code images, per-tenant time zones, UTM parameters, dashboard export (not built)
## Phase 9 — White-label branding + custom domain (flagged)
- [x] Subdomain, `/t/:slug` and custom-domain resolution; host-bound API rule (planRouting)
- [x] Branding as CSS variables with WCAG-chosen button ink; platform defaults below Starter
- [x] Custom domains served only while entitled
- [x] Branding admin UI (name, colours, font; Starter and above)
- [ ] Custom-domain verification (DNS/TLS)
## Tenant admin (ADR 0008)
- [x] Magic-link sign-in: 256-bit single-use tokens in the URL fragment, 15-min expiry, links from
  config (not Host), no account enumeration, per-address cap; `npm run admin:add`, `SEED_ADMIN_EMAIL`
- [x] Sessions: hashed, tenant-scoped, revocable, 12 h; CSRF header on mutations; cross-site refused
- [x] Roles: owner vs admin (only owners change where leads go)
- [x] Lead inbox: keyset paging, search, source filter, "needs attention", detail timeline,
  manual retry, CSV export with formula defusing
- [x] Settings: storefront look, email gate, where leads go (secret shown once, "Send a test")
- [x] Audit log for sign-ins, exports, retries and settings; last ten shown with who did them
- [x] Delivery outbox: one row per capture, backoff 1 m → 12 h, dead-lettering, leased claims
  (`SKIP LOCKED`), stable `deliveryId`; in-process worker or `npm run jobs:deliveries`
- [x] Bug fixes: webhook entitlement never checked; untrusted `X-Real-IP` used for rate limits
- [x] Sweep of expired tokens/sessions (ADR 0010)
- [x] Team tab (ADR 0011): owners invite by email (3-day single-use link; Enterprise, per §7
  "Multi-user admin"), change roles, resend, remove (every plan); everyone sees the list. Never the last owner, enforced with row locks (10 concurrent
  rounds each of demotion and removal, passing on Postgres 18); removal ends sessions at once; audited; rate-limited
- [ ] Resend verified live; per-plan seat limits; one-step ownership transfer
## Hosting on Vercel (ADR 0018)    [~ built, not yet deployed]
- [x] Serverless background work: `after()` for proofs and supplier syncs; secret-protected
  `/api/cron/<job>` endpoints with Hobby-compatible daily schedules in `vercel.json`; env refuses
  local storage / in-process workers on Vercel; guide in `docs/DEPLOY-VERCEL.md`
- [ ] First real deployment (needs Neon, R2/S3 and Resend accounts)

## Phase 10 — Enterprise adapters (PromoStandards / Salesforce / SSO / API)    [~ API + PromoStandards built; others seams only]
- [x] Public REST API v1, read-only (ADR 0016): leads (keyset pages, history), products (selling
  prices only), analytics; API keys shown once, SHA-256 stored, scoped, owner-managed, max 20,
  revocable on any plan, plan checked per request, 600 req/min per key; `api_keys` under RLS
  (migration `drizzle/0003`); base URL correct in path mode (`makeApiUrl`)
- [x] PromoStandards supplier connections (ADR 0017): Product Data 2.0.0 + PPC 1.0.0 over a strict
  XML reader and the SSRF-guarded transport; strict mapping with reasons for everything left out;
  exact cents; sealed passwords; background sync with a lock, daily refresh and plan check per run;
  hide-never-delete; owner Settings section; migration `drizzle/0004` generated by drizzle-kit.
  **Not verified against a real supplier** (tested against the built-in fake supplier only)
- [ ] PromoStandards: template choice in the UI, inventory, media, upsize pricing, directory lookup
- [ ] Salesforce routing, SSO (OIDC/SAML)
- [ ] API: write endpoints, key expiry, IP allowlists, published OpenAPI docs
## Phase 11 — Hardening: coverage, security, a11y, docs + ADRs
- [x] ADRs 0001–0018; mutation checks on isolation, entitlement, lead-capture, delivery and admin tests
- [~] a11y basics (focus rings, labels, reduced motion, 44px targets); no audit yet
- [ ] Shared-store rate limiter for multi-instance deploys

## Verification status (all executed in the authoring sandbox)
- `npm run typecheck:offline`: strict `tsc` over all app code, scripts and UI (real Playwright/esbuild
  types; only the Drizzle/zod modules are stubbed — those are checked by `npm run typecheck` in CI).
  Caught real errors: `Uint8Array` response bodies under TS ≥ 5.7, TS 6 side-effect CSS imports,
  deprecated `baseUrl`.
- `npm run test:offline`: 174 tests across 13 suites, incl. real sharp decoding (the 4 sharp tests
  skip unless sharp is installed or `BC_EXTRA_MODULES` points at it; the RLS isolation suite needs
  Postgres and runs in CI). Mutation-checked: removing the tenant scope from the logo repo or the
  custom-domain entitlement guard fails tests, as do seven security mutations in lead capture, six
  in delivery (entitlement, DNS answers, leases, tenant-bound secrets, dead-lettering, delivery id)
  and ten in admin (CSRF, owner role, plan gate, token reuse/expiry/tenant, Host-header links, CSV
  injection, enumeration, sign-out revocation), and thirteen in pricing (owner-only save, plan gate,
  raw-input storage, fractional cents, tier order, currency, tenant rates, disclaimer, and four ways
  cost or margin could leak to prospects, plus rounded unit labels).
- `npm run smoke:http`: 12 checks over real sockets — upload, catalog, proof cache/ETag,
  subdomain + custom-domain routing, cross-tenant API denial, Free-plan 403.
- `npm run e2e:browser`: 26 checks driving the real React UI in headless Chromium against the real
  API — incl. a JPEG upload, the knockout question, the hard email gate, all 6 proofs, re-pricing,
  filtering, a server-priced quote, the PDF leave-behind downloaded and rendered by pdf.js, mobile
  layout, Free-plan gating, zero console errors. It caught a hidden largest quantity on 390px screens.
- `npm run e2e:admin`: 38 checks with the real admin UI and API in headless Chromium: sign-in via
  the emailed link, inbox, search, detail, settings reaching the storefront, a real webhook receiver
  (signed ping), a failed delivery retried by hand, CSV download, owner vs staff, Free plan, mobile.
  Screenshot review caught inbox-only leads stamped "Sent to CRM" and a clipped mobile list.
  Pricing adds: live preview, margin equivalent, field errors, prospect-safe breakdown, save reaching
  the storefront, staff read-only, Free plan, mobile. Screenshot review caught a 25 px mobile overflow
  the old check had missed (mobile emulation widens the viewport to fit); both suites now measure
  against the device width and name the culprits.
- `npm run demo`: static core-loop page from the real modules.
- Team (ADR 0011), offline: 13 team tests in `admin.test.ts` (34 admin tests in all); seven
  sabotages (owner-only invite, last-owner check, sign-in recording, 3-day link, link cleanup on
  removal, tenant scoping, CSRF on role change) each fail a test. `e2e:admin` adds 12 team checks:
  invite, duplicate refused, invitee accepts the emailed link, promote/demote, removal signs the
  person out, phone layout. The first run caught a test clicking "Resend invite" instead of
  "Send invite" (Playwright's `has-text` is a case-insensitive substring match).
- Safari (ADR 0012), in Chromium phone emulation: every visible text field measured at 16px+ on
  every storefront page and admin tab (caught 14px quote-form, pricing and team fields); nothing past
  the 390px edge even inside scrolling boxes (caught the clipped pricing "Remove" and an off-screen
  "Needs attention" filter). `cookiesSecure()` unit tests (need zod, so they run in real Vitest).

## Verified on real infrastructure (2026-09-24, Node 24 + Postgres 18)
`npm install`, `tsc`, `next build`, `db:setup` (twice: idempotent), the full Vitest suite
including the RLS isolation test (which fails, as it must, with RLS switched off), and
`npm run smoke:pg`: the production build end to end against Postgres, checking the rows after each
step — on local disk and on S3 storage (ADR 0010: shared rate limits, maintenance job as the app
role, 211 tests). Fixed along the way: offline type stubs shadowing real packages, the RLS test passing for the
wrong reason, overlapping queries on one pg connection, `NODE_ENV` in `.env.example`, blank env
values rejected as invalid.

## Verified on real infrastructure: team, plan gate and Safari (2026-09-24, Node 24, Postgres 18, Ubuntu 26.04)
Tarball `3de15a705ad6f3f3`: `npm install`, `tsc` (0 errors), `next build`, `db:setup` (the new
`users.invited_by` / `last_sign_in_at` columns present), Vitest 233/233 across 19 files (incl.
`cookiesSecure`), the Postgres team test 6/6 (concurrent last-owner rounds, FK cascade, RLS),
`smoke:pg` 39/39 (incl. Pro refusing invites with `feature_locked`, a 72 h invite link, removal
killing a live session, team audit rows), and both browser suites in Chromium and WebKit 26.6
(Playwright): storefront 29/29 and admin 55/55 in each engine, zero failures.

## Verified on real infrastructure: owner feature switches (2026-09-24, same stack)
`tsc` 0 errors, `next build`, Vitest 238/238, `smoke:pg` 41/41 (switch off → override row stored,
live quote endpoint 403; switch on → row deleted, endpoint open), browser suites in Chromium and
WebKit: storefront 29/29 and admin 60/60 in each. The real `tsc` caught a duplicate variable in
`scripts/pg-smoke.ts`, which the offline type-check doesn't cover (it excludes the Postgres scripts).

## Migrations committed (2026-09-24)
`drizzle/0000_harsh_stryfe.sql` (+ snapshot and journal) generated from `schema.ts` and committed.
`db:setup` now applies committed migrations instead of regenerating; `npm run db:check` (in CI)
fails when the schema changes without a migration. Verified on Postgres 18: `db:check` passes, a
fresh `db:setup` applies exactly 1 migration and creates no files, Vitest 238/238, `smoke:pg` 41/41;
adding a column without a migration makes `db:check` fail, and passes again once reverted.

## Full release check (2026-09-24, one tarball, Node 24 + Postgres 18)
Every CI step run from a single tarball, including steps no earlier check had run. Passing:
type-check, build, `db:check`, `db:setup` (1 migration), Vitest 238/238, `smoke:pg` 41/41, HTTP
smoke, storefront 29/29 and admin 60/60 in both Chromium and WebKit. It also found:
- `npm run lint` had never worked: ESLint 9 needs `eslint.config.mjs`, and no TypeScript parser was
  installed. Added a flat config (typescript-eslint recommended + Next's plugin) and fixed the 11
  findings (unused names, untyped `any`, one intentional control-character regex).
- No `package-lock.json`, so `npm ci` would fail. CI uses `npm ci` once the lockfile is committed
  and `npm install` until then.
- The offline type-check failed where real packages are installed; it now runs the real one.
- `npm run demo` failed because packaging dropped `scripts/demo/`; the source tree was always fine.

## Known gaps
- Commit `package-lock.json` from the first real checkout (`npm install`, then commit it) so
  installs are reproducible and CI uses `npm ci`.
- WebKit is Playwright's build on Linux, not Safari on a Mac or iPhone. A last look in real Safari
  before a launch is still worthwhile.
- PDF logo decoding untested.
- Resend email adapter checked for request shape only, not against the live service.
- S3 adapter: verified against AWS's published SigV4 example and a real S3-compatible server
  (SeaweedFS 4.47, signature checks on, bucket private), not yet against AWS or R2 themselves.
  Before relying on a provider, run `SMOKE_STORAGE=s3 npm run smoke:pg` against that bucket.
- `rendered_proofs` is unused (ADR 0015): the object store is the proof cache.
- Inline pre-rendering still runs on the web process; with several instances, run
  `npm run jobs:proofs -- --watch` as a separate worker and set `PROOF_WORKER=off`.

## Recommended next phase
Phase 9: white-label branding and custom domains (DNS and TLS verification). Before it: the full
release check of the pre-rendering tarball.
