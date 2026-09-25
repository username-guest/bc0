/**
 * Idempotent seed (§10). Provisions:
 *   - global reference data: plans, the full flag registry, all 15 color families, all 9 methods
 *   - one demo tenant (`demo`) with branding, PLACEHOLDER pricing config, and lead routing
 *   - a small representative catalog spanning several §3.2 categories, with colors mapped to
 *     families (§3.4), method compatibility (§3.1), and quantity breaks
 *
 * Idempotency: every insert is `onConflictDoNothing`/`onConflictDoUpdate` keyed on natural keys,
 * so re-running never duplicates. Reference data is written on the plain handle (not RLS-scoped);
 * tenant rows are written through `withTenant` so they pass the RLS WITH CHECK.
 *
 * Runs as the OWNER role (`npm run db:seed` maps MIGRATION_DATABASE_URL → DATABASE_URL), because
 * the app role is deliberately denied writes to global reference tables and `tenants`.
 * Safe to run repeatedly.
 */
import { and, eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { getDb, withTenant } from './tenant';
import * as s from './schema';
import { PLANS, PLAN_ORDER, FLAGS } from '@/flags/registry';
import { COLOR_FAMILIES, mapColorToFamily } from '@/core/domain/color-families';
import { DECORATION_METHODS } from '@/core/domain/decoration-methods';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';
import { DEMO_CATALOG, DEMO_TENANT_ID, breaksFor } from '@/core/domain/demo-catalog';


export async function seed(): Promise<void> {
  const db = getDb();

  // --- Global reference data (not RLS-scoped) ---
  for (const key of PLANS) {
    await db
      .insert(s.plans)
      .values({ key, label: key[0]!.toUpperCase() + key.slice(1), rank: PLAN_ORDER[key] })
      .onConflictDoNothing();
  }

  for (const flag of Object.values(FLAGS)) {
    await db
      .insert(s.featureFlags)
      .values({
        key: flag.key,
        description: flag.description,
        category: flag.category,
        default: flag.default,
        killSwitchable: flag.killSwitchable,
        minPlan: flag.minPlan,
        globalKill: false,
      })
      .onConflictDoUpdate({
        target: s.featureFlags.key,
        set: { description: flag.description, category: flag.category, minPlan: flag.minPlan },
      });
  }

  for (const fam of COLOR_FAMILIES) {
    await db
      .insert(s.colorFamilies)
      .values({ key: fam.key, label: fam.label, anchorHex: fam.anchor })
      .onConflictDoNothing();
  }

  for (const m of Object.values(DECORATION_METHODS)) {
    await db
      .insert(s.decorationMethods)
      .values({ key: m.key, label: m.label, defaultMoq: m.defaultMoq, meta: m })
      .onConflictDoUpdate({
        target: s.decorationMethods.key,
        set: { label: m.label, defaultMoq: m.defaultMoq, meta: m },
      });
  }

  // --- Demo tenant (row itself is not RLS-forced on `tenants`, but we keep provisioning explicit) ---
  await db
    .insert(s.tenants)
    .values({ id: DEMO_TENANT_ID, slug: 'demo', name: 'Demo Distributor', planKey: 'pro' })
    .onConflictDoNothing();

  // --- Tenant-scoped rows go through withTenant so they satisfy RLS WITH CHECK ---
  await withTenant(DEMO_TENANT_ID, async (tx) => {
    await tx
      .insert(s.tenantBranding)
      .values({ tenantId: DEMO_TENANT_ID, primaryHex: '#1F45C6', secondaryHex: '#111827' })
      .onConflictDoNothing();

    await tx
      .insert(s.tenantSettings)
      .values({
        tenantId: DEMO_TENANT_ID,
        pricingConfig: PLACEHOLDER_TENANT_CONFIG,
        leadRouting: { gate: { mode: 'hard', freeProducts: 3 }, routing: { provider: 'mock' }, contactName: 'Jordan at Demo Promo Co.' },
      })
      .onConflictDoNothing();

    // Optional first admin for the demo tenant (ADR 0008): SEED_ADMIN_EMAIL=you@company.com
    const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    if (adminEmail) {
      await tx.insert(s.users).values({ tenantId: DEMO_TENANT_ID, email: adminEmail, role: 'tenant_owner' }).onConflictDoNothing();
    }

    for (const p of DEMO_CATALOG) {
      // Idempotent via the (tenant_id, name) unique index; on conflict we look the row up.
      const rows = await tx
        .insert(s.products)
        .values({
          tenantId: DEMO_TENANT_ID,
          slug: p.slug,
          template: p.template,
          name: p.name,
          category: p.category,
          brand: p.brand,
          isApparel: p.traits.isApparel ?? false,
          isHardGood: p.traits.isHardGood ?? false,
          isPolyester: p.traits.isPolyester ?? false,
          isEco: p.traits.isEco ?? false,
          moq: 12,
          breaks: breaksFor(p.blankBase),
        })
        .onConflictDoNothing()
        .returning({ id: s.products.id });

      // If the product already existed, look it up so colors/compat still reconcile.
      const productId =
        rows[0]?.id ??
        (
          await tx
            .select({ id: s.products.id })
            .from(s.products)
            .where(and(eq(s.products.tenantId, DEMO_TENANT_ID), eq(s.products.name, p.name)))
        )[0]?.id;
      if (!productId) continue;

      for (const c of p.colors) {
        await tx
          .insert(s.productColors)
          .values({
            tenantId: DEMO_TENANT_ID,
            productId,
            name: c.name,
            hex: c.hex,
            familyKey: mapColorToFamily(c.hex),
            isDark: c.isDark ?? false,
          })
          .onConflictDoNothing();
      }

      for (const m of p.methods) {
        await tx
          .insert(s.decorationCompatibility)
          .values({
            tenantId: DEMO_TENANT_ID,
            productId,
            methodKey: m.method,
            location: m.location,
            imprintWidthIn: m.w,
            imprintHeightIn: m.h,
          })
          .onConflictDoNothing();
      }
    }
  });

  console.log('[seed] complete: reference data + demo tenant + representative catalog');
}

// Allow `tsx src/core/db/seed.ts` (ESM entrypoint check — package.json is "type": "module").
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
