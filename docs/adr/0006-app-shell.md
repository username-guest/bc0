# ADR 0006 — App shell: framework-agnostic API, tenant routing, runtime modes

**Status:** Accepted · **Date:** 2026-09-23

## Context
Phase 5→9 bridge: turn the headless core loop into a multi-tenant web app (Next.js, ADR 0001)
without making correctness depend on code that is hard to test in isolation (middleware, route
handlers, React).

## Decisions

1. **The tenant API is framework-agnostic.** Handlers in `src/server/http` are standard
   `Request → Response`. Next.js mounts them through one catch-all route
   (`src/app/api/t/[tenant]/[...path]`); the zero-dependency dev server (`scripts/dev-server.ts`)
   mounts the same router over `node:http`. One implementation, tested three ways: direct unit
   tests, real sockets (`smoke:http`), and a real browser (`e2e:browser`).

2. **One URL scheme; routing is a pure function.** The API always lives at `/api/t/<ref>/…`
   (`<ref>` = slug, or `@host` for custom domains); pages at `/t/<ref>/…`. `planRouting()`
   decides every request and is unit-tested; middleware only applies its decision. On a tenant's
   own host, `/api/t/<ref>` passes **only if `<ref>` is that tenant** — a page on acme's host can
   never reach another tenant's API — and path-mode `/t/…` is refused.

3. **Gates are server-side, per request.** `loadTenantContext()` builds the flag snapshot from
   plan + global kill switches + tenant overrides; every handler checks it. The browser receives a
   copy for presentation only. Custom domains resolve only while `custom_domain` is entitled (a
   downgraded tenant stops being served on its domain); white-label branding falls back to
   platform defaults below Starter.

4. **Free-tier decoration methods = screen print, embroidery, laser engraving** (one flagship per
   product family: printed apparel, stitched apparel, hard goods). The original spec's exact list
   was not available when this was built; this is a documented default in one constant
   (`BASE_TIER_METHODS`, `src/flags/entitlements.ts`). Change it there if the spec differs.

5. **Runtime modes.** `DATA_MODE=memory` runs seeded demo tenants with no database (dev/demo;
   refused in production); `DATA_MODE=postgres` uses the Drizzle repositories inside `withTenant`
   (RLS is the boundary). `STORAGE_DRIVER=local` stores files on disk with strict key validation
   (no traversal, tenant-rooted). `STORAGE_DRIVER=s3` uses the S3-compatible adapter (ADR 0010).

6. **Proofs are content-addressed and only for real configurations.** A proof request must name a
   colour, method and location the product actually offers and that are physically compatible;
   the cache key covers logo (incl. knockout choice), product, colour, method, location and
   renderer version. Cache hits don't count against the render rate limit; misses do.

7. **sharp is the production image codec** (JPEG/WebP/SVG/PDF), loaded lazily; the dependency-free
   PNG codec remains the fallback so the core loop runs without native modules. SVGs are screened
   for script/handlers/external refs/XXE before any decoder sees them.

8. **Templates are warmed at server start.** Building the procedural product templates costs
   ~1.5 s once per process; warming removes it from the first prospect's first proof.

## Consequences
+ Security-relevant logic (routing, isolation, entitlement) is pure or framework-agnostic and is
  covered by unit, socket and browser tests, including mutation checks that the tests fail when a
  guard is removed.
+ The app runs end to end with no database or external service.
− The in-memory rate limiter is per instance; multi-instance deployments need a shared store
  behind the same `RateLimiter` interface.
− Next.js-specific wiring (middleware, layouts, route mounting) is thin but only verifiable with
  the real framework installed (CI `unit` job: `typecheck` + `build`).
