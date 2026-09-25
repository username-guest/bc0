# ADR 0003 — Feature flags & entitlements

Status: accepted · Date: 2026-09-18

## Context
§6 wants features enable/disable/upgradeable without code changes, gated by plan, server-
authoritative, with a defined precedence and analytics instrumentation.

## Decision
- **Central typed registry** (`src/flags/registry.ts`): each flag is
  `{ key, description, default, category, killSwitchable, minPlan }`. `minPlan` is the
  feature→plan map from §7 expressed as data, not scattered `if` statements.
- **Precedence, highest wins** (`src/flags/evaluate.ts`):
  `global kill-switch → plan entitlement → tenant override → role/user override → default`.
  A killed flag is off regardless. A flag above the tenant's plan is *locked* off even if a
  tenant override tries to enable it (overrides only refine within entitled features).
- **Server-authoritative.** `evaluate()` runs on the server; `buildFlagSnapshot()` produces a
  `Record<key, {enabled, locked, reason}>` sent to the client. The `useFeature()` hook reads the
  snapshot and gates presentation only — it is never the entitlement authority.
- **Instrumented.** Every evaluation returns a `reason`, so flag reads feed conversion analytics
  ("which features drive conversion").

## Consequences
+ Entitlement surface is editable data; adding a flag is a registry entry + a plan mapping.
+ Client can't unlock a feature by lying.
