/** Server-only: resolve a tenant for a page render (Next.js layouts/pages). */
import { getRuntime } from '@/server/runtime';
import { loadTenantContext } from './context';

export async function ctxFor(ref: string) {
  const { directory } = await getRuntime();
  return loadTenantContext(ref, directory);
}
