/**
 * Offline TS runner hook (dev/CI convenience; NOT used by the app build).
 * Node >= 22.18 strips TypeScript types natively. This resolve hook adds what tsc/vitest
 * normally provide: the `@/` → `src/` alias, extensionless relative imports → `.ts`, and
 * `vitest` → a tiny local shim so pure-logic suites run with zero `npm install`.
 * Modules needing real deps (drizzle, pg, zod) are simply not imported by the pure suites.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shim = pathToFileURL(path.join(root, 'scripts/offline/vitest-shim.mjs')).href;

function tryFile(base) {
  for (const cand of [base, `${base}.ts`, `${base}.mjs`, path.join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === 'vitest') return { url: shim, shortCircuit: true };
  let base = null;
  if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2));
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    const hit = tryFile(base);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (e) {
    // Optional: resolve bare packages from an extra directory (e.g. a global node_modules)
    // when they aren't installed locally. Set BC_EXTRA_MODULES=/path/to/node_modules.
    const extra = process.env.BC_EXTRA_MODULES;
    if (extra && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) {
      return next(specifier, { ...context, parentURL: pathToFileURL(path.join(extra, 'noop.js')).href });
    }
    throw e;
  }
}
