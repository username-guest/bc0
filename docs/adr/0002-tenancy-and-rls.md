# ADR 0002 — Tenancy model & row-level security

Status: accepted · Date: 2026-09-18

## Context
§2 requires multi-tenant isolation enforced by Postgres RLS, *not* application-layer filtering,
with automated tests proving one tenant cannot read another's data.

## Decision
- **Shared database, shared schema, `tenant_id uuid` on every tenant domain row.**
- **RLS is the enforcement boundary.** Each tenant table gets:
  ```sql
  ALTER TABLE t ENABLE ROW LEVEL SECURITY;
  ALTER TABLE t FORCE ROW LEVEL SECURITY;   -- applies even to the table owner
  CREATE POLICY tenant_isolation ON t
    USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
  ```
- **The app connects as a dedicated non-superuser role without BYPASSRLS.** Superuser/owner
  bypasses RLS, so a mis-provisioned role silently defeats isolation. This is asserted in ops.
- **Per-request tenant binding** via `withTenant(tenantId, fn)`, which opens a transaction and
  calls `set_config('app.current_tenant_id', $1, true)` (`is_local = true` → auto-resets at tx
  end; parameterised, so no SQL injection). Business code never hand-writes `where tenant_id`.
- **Global vs tenant scope.** Platform reference data — `plans`, the flag registry,
  `color_families`, `decoration_methods` — is *not* tenant-scoped; it is readable by all and
  writable only by `platform_admin`. Only tenant domain rows are RLS-protected. (§10 says
  "every domain row"; reference tables are platform rows, and we call that out explicitly.)
- **platform_admin cross-tenant access** uses an explicit, audited elevated path — never the
  default request role.
- **Tenant routing**: subdomain (`acme.brandcanvas.app`) → path fallback (`/t/acme`) →
  custom domain (behind a flag).

## Consequences
+ Isolation holds even if application code forgets a filter.
+ `WITH CHECK` also blocks cross-tenant *writes*.
− Every DB access must go through `withTenant`; a bare pool query would see nothing (fail-safe).
