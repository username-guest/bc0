/**
 * Dependency-free arithmetic check for the pricing engine.
 * Runs with plain `node` (no npm install) so the pricing math can be verified in any
 * environment / in CI before deps are available. Mirrors the constants in
 * src/pricing/placeholder-rates.ts for the two worked examples. The canonical, exhaustive
 * suite is src/pricing/engine.test.ts (Vitest). Any divergence here is a bug in the mirror.
 */
let failures = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}${ok ? '' : `, want ${want}`}`);
};

// ---- Screen print: dark tee, 2 colors, qty 144, 1 location ----
{
  const qty = 144, colorCount = 2, dark = true, loc = 1;
  const eff = colorCount + (dark ? 1 : 0);
  const tier = { base: 40, perColor: 20 }; // break 144
  const runPerUnit = tier.base + tier.perColor * eff;
  const setup = 2000 * eff * loc;
  const blankUnit = 350, markup = 1.4;
  const blanksAtCost = blankUnit * qty;
  const blanksWithMargin = Math.round(blanksAtCost * markup);
  const run = runPerUnit * qty;
  const total = blanksWithMargin + setup + run;
  eq('screen eff colors', eff, 3);
  eq('screen runPerUnit', runPerUnit, 100);
  eq('screen setup', setup, 6000);
  eq('screen margin', blanksWithMargin - blanksAtCost, 20160);
  eq('screen run total', run, 14400);
  eq('screen TOTAL', total, 90960);
  eq('screen unit (rounded)', Math.round(total / qty), 632);
}

// ---- Embroidery: left chest 3x2, qty 48, 1 location, 4 colors ----
{
  const qty = 48, loc = 1, colorCount = 4;
  const stitches = Math.round(3 * 2 * 1800);
  const per1k = Math.ceil(stitches / 1000);
  const runPerUnit = per1k * 90 * loc;
  const extra = Math.max(0, colorCount - 7);
  const setup = 4500 + extra * 1500;
  const blankUnit = 650, markup = 1.4;
  const blanksAtCost = blankUnit * qty;
  const blanksWithMargin = Math.round(blanksAtCost * markup);
  const run = runPerUnit * qty;
  const total = blanksWithMargin + setup + run;
  eq('embroidery stitches', stitches, 10800);
  eq('embroidery runPerUnit', runPerUnit, 990);
  eq('embroidery setup', setup, 4500);
  eq('embroidery run total', run, 47520);
  eq('embroidery TOTAL', total, 95700);
}

console.log(failures === 0 ? '\nAll pricing checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
