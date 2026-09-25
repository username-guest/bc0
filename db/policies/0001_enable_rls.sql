-- 0001_enable_rls.sql
-- Row-Level Security is the tenant-isolation boundary (§2, §12) — NOT application-layer filtering.
--
-- Model:
--   * The app connects as a dedicated role (APP_DB_ROLE, default `brandcanvas_app`) that is
--     NOT a superuser and does NOT have BYPASSRLS. Superusers/table owners bypass RLS, so the
--     app must never connect as one.
--   * `withTenant()` sets a transaction-local GUC `app.current_tenant_id`; every policy below
--     compares it against the row's `tenant_id`.
--   * FORCE ROW LEVEL SECURITY makes the policy apply even to the table owner, so tests and
--     migrations can't accidentally read across tenants.
--   * If the GUC is unset, `current_setting(..., true)` returns NULL and the `= uuid` comparison
--     is NULL → no rows match → safe closed default (deny).

-- Application role (idempotent). Grants are scoped to the tables the app touches.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brandcanvas_app') THEN
    CREATE ROLE brandcanvas_app NOLOGIN;  -- attach a password/LOGIN in your environment
  END IF;
END$$;

-- Helper: current tenant from the transaction-local GUC, NULL when unset.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;

-- Apply the same enable/force + policy to every tenant-scoped table.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_branding','tenant_settings','feature_overrides','users','logo_assets',
    'products','product_colors','decoration_compatibility','mockup_jobs','rendered_proofs',
    'leads','lead_events','lead_deliveries','prospect_sessions','tracked_links','analytics_events','api_keys','supplier_connections','audit_log',
    'admin_login_tokens','admin_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- SELECT/UPDATE/DELETE visibility: only rows for the current tenant.
    EXECUTE format($f$
      DROP POLICY IF EXISTS tenant_isolation ON %I;
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
    $f$, t, t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO brandcanvas_app', t);
  END LOOP;
END$$;

-- Global reference tables are readable by the app but never written by it.
GRANT SELECT ON plans, feature_flags, color_families, decoration_methods TO brandcanvas_app;
-- tenants table: the app resolves a tenant by slug/domain at request time (read-only here;
-- provisioning happens via a platform-admin path).
GRANT SELECT ON tenants TO brandcanvas_app;

-- Shared rate-limit windows (ADR 0010): global table, keys are SHA-256 hashes. The app role
-- upserts one row per limited request and the maintenance job deletes expired windows.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO brandcanvas_app;
