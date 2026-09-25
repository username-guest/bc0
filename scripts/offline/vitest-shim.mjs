/** Minimal describe/it/expect subset — enough for the pure-logic suites. Real CI uses vitest. */
import { isDeepStrictEqual } from 'node:util';

/* Asymmetric matchers (expect.stringMatching etc.), as vitest has them. */
const ASYM = Symbol('asym');
const asym = (label, match) => ({ [ASYM]: true, match, toJSON: () => label });
const isAsym = (e) => !!e && typeof e === 'object' && e[ASYM] === true;
const hasAsym = (e) => isAsym(e) || (Array.isArray(e) ? e.some(hasAsym) : !!e && typeof e === 'object' && Object.getPrototypeOf(e) === Object.prototype && Object.values(e).some(hasAsym));
/** toEqual with asymmetric matchers inside; otherwise identical to isDeepStrictEqual. */
function eq(a, e) {
  if (isAsym(e)) return e.match(a);
  if (!hasAsym(e)) return isDeepStrictEqual(a, e);
  if (Array.isArray(e)) return Array.isArray(a) && a.length === e.length && e.every((v, i) => eq(a[i], v));
  const ka = Object.keys(a ?? {}).filter((k) => a[k] !== undefined), ke = Object.keys(e).filter((k) => e[k] !== undefined);
  return !!a && typeof a === 'object' && ka.length === ke.length && ke.every((k) => eq(a[k], e[k]));
}
/** toThrow's argument: a RegExp or substring for the message, or an error class. */
function throwMatches(err, x) {
  if (x === undefined) return true;
  if (typeof x === 'function') return err instanceof x;
  if (typeof x === 'string') return String(err?.message).includes(x);
  return x.test(String(err?.message));
}

/** Vitest's toMatchObject: objects match partially (recursively); arrays match element-wise, same length. */
function subset(a, e) {
  if (isAsym(e)) return e.match(a);
  if (Array.isArray(e)) return Array.isArray(a) && a.length === e.length && e.every((v, i) => subset(a[i], v));
  if (e && typeof e === 'object' && !(e instanceof Date) && !(e instanceof RegExp)) {
    return !!a && typeof a === 'object' && Object.entries(e).every(([k, v]) => subset(a[k], v));
  }
  return isDeepStrictEqual(a, e);
}
const tests = [];
const stack = [];
export const describe = (name, fn) => { stack.push(name); fn(); stack.pop(); };
describe.skip = (name) => { tests.push({ name: `${name} (skipped)`, skip: true }); };
export const it = (name, fn) => tests.push({ name: [...stack, name].join(' › '), fn });
export const test = it;
export const beforeAll = (fn) => tests.push({ name: '(beforeAll)', fn, hook: true });
export const afterAll = () => {};
function fail(msg) { throw new Error(msg); }
const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
export function expect(actual) {
  const m = {
    toBe: (e) => Object.is(actual, e) || fail(`expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e) => eq(actual, e) || fail(`expected ${show(actual)} to equal ${show(e)}`),
    toBeInstanceOf: (c) => actual instanceof c || fail(`expected instance of ${c?.name}, got ${show(actual)}`),
    toStrictEqual: (e) => isDeepStrictEqual(actual, e) || fail(`expected ${show(actual)} to equal ${show(e)}`),
    toBeGreaterThan: (e) => actual > e || fail(`expected ${actual} > ${e}`),
    toBeGreaterThanOrEqual: (e) => actual >= e || fail(`expected ${actual} >= ${e}`),
    toBeLessThan: (e) => actual < e || fail(`expected ${actual} < ${e}`),
    toBeLessThanOrEqual: (e) => actual <= e || fail(`expected ${actual} <= ${e}`),
    toBeCloseTo: (e, d = 2) => Math.abs(actual - e) < 10 ** -d / 2 || fail(`expected ${actual} ≈ ${e}`),
    toContain: (e) => actual.includes(e) || fail(`expected ${show(actual)} to contain ${show(e)}`),
    toHaveLength: (n) => actual.length === n || fail(`expected length ${n}, got ${actual.length}`),
    toBeTruthy: () => !!actual || fail(`expected truthy, got ${show(actual)}`),
    toBeFalsy: () => !actual || fail(`expected falsy, got ${show(actual)}`),
    toBeDefined: () => actual !== undefined || fail('expected defined'),
    toBeUndefined: () => actual === undefined || fail(`expected undefined, got ${show(actual)}`),
    toBeNull: () => actual === null || fail(`expected null, got ${show(actual)}`),
    toMatch: (re) => (typeof re === 'string' ? actual.includes(re) : re.test(actual)) || fail(`expected ${show(actual)} to match ${re}`),
    toMatchObject: (e) => subset(actual, e) || fail(`expected ${show(actual)} to match ${show(e)}`),
    toThrow: (x) => {
      try { actual(); } catch (err) { if (!throwMatches(err, x)) fail(`threw ${err?.message}, expected ${x?.name ?? x}`); return; }
      fail('expected function to throw');
    },
  };
  m.not = Object.fromEntries(Object.entries(m).map(([k, f]) => [k, (...a) => {
    let passed = true; try { f(...a); } catch { passed = false; }
    if (passed) fail(`expected NOT ${k}(${a.map(show).join(', ')}) — actual ${show(actual)}`);
  }]));
  // .rejects.<any matcher>: the matcher applies to the rejection reason (toThrow checks it as the thrown error).
  m.rejects = Object.fromEntries(Object.keys(m).filter((k) => k !== 'not').map((k) => [k, async (...a) => {
    let err, threw = false;
    try { await actual; } catch (e) { err = e; threw = true; }
    if (!threw) fail('expected promise to reject');
    if (k === 'toThrow') { if (!throwMatches(err, a[0])) fail(`rejected with ${err?.message}, expected ${a[0]?.name ?? a[0]}`); return; }
    expect(err)[k](...a);
  }]));
  return m;
}
expect.stringMatching = (re) => asym(`StringMatching ${re}`, (a) => typeof a === 'string' && (typeof re === 'string' ? a.includes(re) : re.test(a)));
expect.arrayContaining = (xs) => asym(`ArrayContaining ${show(xs)}`, (a) => Array.isArray(a) && xs.every((x) => a.some((y) => eq(y, x))));
expect.any = (c) => asym(`Any<${c.name}>`, (a) => a != null && (Object(a) instanceof c || (c === String && typeof a === 'string') || (c === Number && typeof a === 'number')));

export async function run(label) {
  let pass = 0, failN = 0, skip = 0;
  for (const t of tests) {
    if (t.skip) { skip++; continue; }
    try { await t.fn(); if (!t.hook) pass++; }
    catch (e) { failN++; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
  }
  console.log(`${failN ? '✗' : '✓'} ${label}: ${pass} passed${failN ? `, ${failN} FAILED` : ''}${skip ? `, ${skip} skipped` : ''}`);
  tests.length = 0;
  return failN;
}
