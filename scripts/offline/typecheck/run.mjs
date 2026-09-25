/**
 * Sandbox type-check: runs `tsc` over ALL project code with loose stubs for third-party packages
 * that aren't installed (next, react types, drizzle, pg, zod, vitest). Where dependencies ARE
 * installed, use the real gate instead: `npm run typecheck`.
 *
 * Finds tsc and @types/node in ./node_modules or $BC_EXTRA_MODULES.
 */
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const dirs = [path.join(root, 'node_modules'), process.env.BC_EXTRA_MODULES].filter(Boolean);

// With the real dependencies installed, the stubs would clash with real types (e.g. React's JSX
// types) and prove less than the real check. Delegate to it instead.
const realTsc = path.join(root, 'node_modules/typescript/bin/tsc');
if (['next', 'drizzle-orm', 'zod'].every((p) => existsSync(path.join(root, 'node_modules', p, 'package.json'))) && existsSync(realTsc)) {
  console.log('Dependencies are installed: running the real type-check (tsc --noEmit) instead of the stubbed one.');
  const r = spawnSync(process.execPath, [realTsc, '--noEmit', '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function findTypesNode() {
  for (const d of dirs) {
    if (existsSync(path.join(d, '@types/node/package.json'))) return path.join(d, '@types');
    for (const pkg of existsSync(d) ? readdirSync(d) : []) {
      const nested = path.join(d, pkg, 'node_modules/@types');
      if (existsSync(path.join(nested, 'node/package.json'))) return nested;
    }
  }
  return null;
}
const tsc = dirs.map((d) => path.join(d, 'typescript/bin/tsc')).find((p) => existsSync(p));
const typeRoot = findTypesNode();
if (!tsc || !typeRoot) {
  console.error('typescript and @types/node are required (install deps or set BC_EXTRA_MODULES).');
  process.exit(2);
}
/** Packages that ship their own .d.ts: use the REAL types when present (never stubs). */
function realTypes(name, candidates) {
  for (const d of dirs) {
    for (const rel of candidates) {
      if (existsSync(path.join(d, rel))) return { [name]: [path.join(d, rel)] };
    }
  }
  return {};
}
const extraPaths = {
  ...realTypes('playwright', ['playwright/index.d.ts']),
  ...realTypes('esbuild', ['esbuild/lib/main.d.ts', 'tsx/node_modules/esbuild/lib/main.d.ts']),
  ...realTypes('pdfjs-dist', ['pdfjs-dist/types/src/pdf.d.ts']),
};

const cfg = path.join(here, 'tsconfig.generated.json');
writeFileSync(
  cfg,
  JSON.stringify(
    {
      extends: '../../../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        incremental: false,
        typeRoots: [typeRoot],
        types: ['node'],
        jsx: 'preserve',
        paths: {
          '@/core/config/env': ['../../../scripts/offline/typecheck/stub-env.ts'],
          '@/server/repos/drizzle': ['../../../scripts/offline/typecheck/stub-drizzle-repos.ts'],
          '@/*': ['../../../src/*'],
          ...extraPaths,
        },
      },
      include: ['../../../src/**/*.ts', '../../../src/**/*.tsx', '../../../scripts/**/*.ts', '../../../scripts/**/*.tsx', './stubs.d.ts'],
      exclude: ['../../../node_modules', '../../../src/core/db/**', '../../../src/server/repos/drizzle.ts', '../../../src/core/config/env.ts', '../../../scripts/admin/**', '../../../scripts/pg-smoke.ts'],
    },
    null,
    2,
  ),
);
const r = spawnSync(process.execPath, [tsc, '-p', cfg], { stdio: 'inherit' });
if (r.status === 0) console.log('Type-check passed (DB + env modules are checked by the real `npm run typecheck`).');
process.exit(r.status ?? 1);
