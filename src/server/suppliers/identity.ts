/**
 * Imported products must not collide with the tenant's other products (ADR 0017). Names and slugs
 * are unique per tenant. When a supplier product clashes with a product it doesn't own, its
 * supplier product id is appended to both; if that is taken too (a third connection to the same
 * supplier), a counter follows. The result is deterministic for a given catalog, and a re-sync
 * keeps the row's existing name because the caller excludes the row itself from `taken`.
 */
import { slugify } from '@/integrations/promostandards/map';

const MAX_TRIES = 100;

export function importedIdentity(
  name: string,
  slug: string,
  supplierProductId: string,
  taken: { names: ReadonlySet<string>; slugs: ReadonlySet<string> },
): { name: string; slug: string } {
  const free = (n: string, s: string) => !taken.names.has(n.toLowerCase()) && !taken.slugs.has(s);
  if (free(name, slug)) return { name, slug };
  const baseName = `${name} · ${supplierProductId}`;
  const baseSlug = `${slug.slice(0, 40)}-${slugify(supplierProductId)}`.slice(0, 72);
  for (let i = 1; i <= MAX_TRIES; i++) {
    const n = i === 1 ? baseName : `${baseName} (${i})`;
    const s = i === 1 ? baseSlug : `${baseSlug}-${i}`;
    if (free(n, s)) return { name: n, slug: s };
  }
  throw new Error(`Too many products named "${name}"`);
}
