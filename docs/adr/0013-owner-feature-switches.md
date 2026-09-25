# ADR 0013 — Owner feature switches

**Status:** Accepted · **Date:** 2026-09-24 · Builds on ADR 0003 (flags and entitlements)

## Context
ADR 0003 defined tenant overrides as a layer that "only refines within entitled features", but
nothing let a tenant set one. Distributors want to switch off parts of their storefront (no quote
requests, logos kept exactly as uploaded) without asking us.

## Decisions
1. **A short, curated list, not the whole registry.** `src/flags/owner-toggles.ts` lists six
   switches: quote requests, downloadable product sheets, catalog filters, quantity price breaks,
   the sustainable filter, and automatic logo background removal. Each exists, is optional for a
   distributor, and is enforced by the server as well as the storefront. Left out on purpose: core
   features (logo upload, proofs), admin capabilities (pricing, CRM routing, custom domain, team),
   the email gate (its own setting) and 16 placeholder flags that don't do anything yet.
2. **Refine, never unlock.** The precedence is unchanged (kill switch → plan → tenant override →
   default). Switching on a feature the plan doesn't include, or one the platform has killed, is
   refused per field (`400`, e.g. "Available on the Starter plan."). Nothing is half-applied.
3. **Store only "off".** Every listed flag defaults to on, so a switch back on deletes the override
   row rather than storing `true`. The table only ever holds deviations.
4. **Owners change, everyone sees.** `GET admin/features` for any signed-in admin; `PUT` is
   owner-only with the CSRF header, audited as `settings.features` ("quote_requests off").
5. **Operators keep their own overrides.** A save replaces tenant-scope overrides for the six
   listed keys only; overrides an operator set on other flags are untouched.
6. **Prospects are told plainly.** A switched-off endpoint answers `403 feature_locked` with
   "This feature is turned off for this site." and `upgradeable: false`, distinct from the plan
   upsell ("not included in the current plan", `upgradeable: true`).

## Consequences
- Takes effect on the next request on the instance that saved it; other instances within the 5 s
  tenant cache (ADR 0010).
- Global kill switches still have no UI: they are a platform-operator action (SQL or CLI).
- Adding a switch = one entry in `OWNER_TOGGLES`, after confirming the flag is enforced server-side.
