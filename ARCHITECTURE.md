# Architecture

## Shape
Next.js (App Router) + TypeScript strict, Postgres with row-level security via Drizzle,
S3-compatible object store, a Postgres job queue (`mockup_jobs`, ADR 0015) for proof pre-rendering,
zod-validated env + inputs. Rationale in `docs/adr/0001-tech-stack.md`.

## Module boundaries (§13) — cross-module access only via published interfaces
```
src/
  core/        config, db (schema + RLS + tenant tx wrapper), domain constants              [BUILT]
  flags/       typed registry + server-authoritative evaluator + entitlement map            [BUILT]
  pricing/     rules engine + per-method modules                                           [BUILT]
  imaging/     PNG codec, palette, background removal, Brand-Exact compositor, templates   [BUILT]
  features/    logo-intake, mockup (proofs), catalog, leads (rules), pdf                    [BUILT]
  server/      tenancy, repos (memory + Drizzle), HTTP API (storefront + admin), sessions,
               admin auth, secret box, address guard, delivery outbox + retry job          [BUILT]
  ui/          storefront (Studio, lead forms) and admin (inbox, pricing, settings)                 [BUILT]
  app/         Next.js mounting: middleware, layouts, API catch-all        [written, not built here]
  shared/      providers (the upgrade seam): storage, CRM, email, image, vision, pricing   [BUILT + mocks]
  (pending)    flag-toggle admin, analytics, queue pre-rendering,
               Enterprise adapters (PromoStandards / Salesforce / SSO / API)
```

## The upgrade seam (§11)
Every external capability is an interface in `src/shared/providers` selected by config
(`IMAGE_PROVIDER`, `CRM_PROVIDER`, ...). Callers depend only on the interface; a mock ships for
each so the app is fully functional with zero external services. Swapping to a real provider
(FLUX/Gemini/OpenAI for image edit, HubSpot/Salesforce for CRM, PromoStandards for product data)
is an adapter change, never a business-logic change.

### Key insight: Brand-Exact proofs need NO AI model
Stage C has two modes. **Brand-Exact** (the default proof, and the "wow" in the core loop) is
deterministic image compositing — perspective-warp the real logo onto the detected zone and
apply a per-method material shader. It has *no* dependency on a third-party generative model.
Only **AI Lifestyle** (hero shots) calls `ImageGenerationProvider`. This de-risks the core loop:
it can be fast and impressive even if no image API is wired. See `docs/adr/0004`.

## Tenancy (§2)
Shared Postgres. Every domain row carries `tenant_id`. Isolation is enforced by RLS policies
keyed on `current_setting('app.current_tenant_id')`, not by application-layer `where` clauses.
Truly-global reference data (plans, flag registry, decoration-method + color-family definitions)
is platform-scoped and readable by all; tenant *domain* rows are RLS-protected. The app connects
as a non-superuser, non-BYPASSRLS role so policies actually apply. See `docs/adr/0002`.

## Feature flags (§6)
Central typed registry. Evaluation precedence, highest wins:
`global kill-switch → plan entitlement → tenant override → role/user override → default`.
Evaluation is server-side and authoritative; the client hook only gates presentation.

## Pricing (§8)
`Total = (blank base × qty × margin markup) + decoration + one-time charges + fees`, computed at
the selected quantity break. Decoration cost dispatches to a per-method module (screen,
embroidery, DTG, DTF, sublimation, laser, pad, deboss/emboss, HTV). Money is integer cents
end-to-end to avoid float drift. All defaults are `PLACEHOLDER`; output is always `estimated`.

## Core-loop data flow (target)
upload logo → assets (validate, bg-remove, extract colors) → mockup Stage B vision (detect zone,
confidence) → Stage C render (Brand-Exact composite) → cache by (logoHash, product, zone, method,
mode) → catalog propagation → pricing.quote() per product/qty → facets/search → lead capture → CRM.
