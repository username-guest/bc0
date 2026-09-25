/**
 * Tenant-scoped DB access (§2, §12). The application connects as a NON-superuser, NON-BYPASSRLS
 * role (`APP_DB_ROLE`), so RLS is always in force. `withTenant` opens a transaction, binds the
 * tenant id to a transaction-local GUC that the RLS policies read, and runs the callback inside it.
 *
 * RLS policies compare `tenant_id` against `current_setting('app.current_tenant_id', true)::uuid`
 * (see db/policies/0001_enable_rls.sql). Using `set_config(key, val, true)` scopes the setting to the
 * transaction, so it cannot leak across pooled connections.
 *
 * There is deliberately NO "escape hatch" that runs unscoped queries against tenant tables. Global
 * reference tables (plans, feature_flags, color_families, decoration_methods) are not RLS-scoped
 * and are queried via the plain `db` handle.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema';
import { getEnv } from '@/core/config/env';

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) {
    const env = getEnv();
    // NOTE: DATABASE_URL must point at APP_DB_ROLE (non-superuser, non-BYPASSRLS). A separate
    // migration/superuser connection string is used only by the migration runner, never here.
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set (DATA_MODE=postgres requires it)');
    _pool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return _pool;
}

export function getDb() {
  return drizzle(pool(), { schema });
}

export type Db = ReturnType<typeof getDb>;
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction bound to `tenantId`. Every query on a tenant-scoped table inside
 * `fn` is transparently filtered by RLS to that tenant.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error('withTenant: tenantId must be a UUID');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    // Transaction-local (third arg = true) so it never bleeds across the pool.
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
