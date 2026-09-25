/** Runs every pure-logic *.test.ts with no dependencies installed. DB/integration suites excluded. */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './vitest-shim.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Need Postgres + drizzle, or real zod — run under `npm test` (CI), not the dependency-free runner.
const EXCLUDE = [/src[\\/]core[\\/]db[\\/]/, /src[\\/]core[\\/]config[\\/]env\.test\.ts$/];
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.test.ts') && !EXCLUDE.some((r) => r.test(p))) files.push(p);
  }
})(path.join(root, 'src'));

let failures = 0;
for (const f of files.sort()) {
  await import(pathToFileURL(f).href);
  failures += await run(path.relative(root, f));
}
console.log(failures ? `\n${failures} failing test(s)` : '\nAll offline suites passed.');
process.exit(failures ? 1 : 0);
