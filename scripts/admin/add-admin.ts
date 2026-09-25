/**
 * Grant admin access to a tenant (ADR 0008). Postgres mode only; runs as the app role under RLS.
 *
 *   npm run admin:add -- <tenant-slug> <email> [tenant_owner|tenant_admin]
 *
 * Idempotent: re-running updates the role. The person then signs in at the tenant's /admin with
 * an emailed link; there is no password to set.
 */
import { eq } from 'drizzle-orm';
import { getDb, withTenant } from '@/core/db/tenant';
import * as s from '@/core/db/schema';
import { normalizeEmail } from '@/features/leads/rules';

const [slug, rawEmail, rawRole = 'tenant_admin'] = process.argv.slice(2);
const email = normalizeEmail(rawEmail);
if (!slug || !email || !['tenant_owner', 'tenant_admin'].includes(rawRole)) {
  console.error('Usage: npm run admin:add -- <tenant-slug> <email> [tenant_owner|tenant_admin]');
  process.exit(2);
}
const [tenant] = await getDb().select().from(s.tenants).where(eq(s.tenants.slug, slug)).limit(1);
if (!tenant) {
  console.error(`No tenant with slug "${slug}".`);
  process.exit(1);
}
await withTenant(tenant.id, (tx) =>
  tx
    .insert(s.users)
    .values({ tenantId: tenant.id, email, role: rawRole })
    .onConflictDoUpdate({ target: [s.users.tenantId, s.users.email], set: { role: rawRole } }),
);
console.log(`${email} is now ${rawRole} of ${slug}. They sign in at the tenant's /admin.`);
process.exit(0);
