import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTenant, rewritePath, parseInternalRef, isValidSlug, planRouting } from './tenancy/resolve';
import { loadTenantContext, publicTenantConfig } from './tenancy/context';
import { FixedWindowLimiter, MemoryWindowStore, throttledWarn, type RateWindowStore } from './rate-limit';
import { handleTenantApi } from './http/router';
import { buildFixture, fixtureTenants, FREE_TENANT_ID } from './testing';
import { MemoryTenantDirectory } from './repos/memory';
import { LocalFsStorageProvider, assertSafeKey } from '@/shared/providers/local-fs-storage';
import { encodePng, decodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';

const BASE = 'brandcanvas.app';

describe('tenant resolution', () => {
  it('resolves subdomains, ignoring port and case', () => {
    expect(resolveTenant('Acme.BrandCanvas.app:443', '/catalog', BASE)).toEqual({ tenant: { kind: 'subdomain', slug: 'acme', rest: '/catalog' } });
  });
  it('uses the /t/:slug path fallback on the apex and localhost', () => {
    expect(resolveTenant('localhost:3000', '/t/acme/catalog', BASE)).toEqual({ tenant: { kind: 'path', slug: 'acme', rest: '/catalog' } });
    expect(resolveTenant(BASE, '/pricing', BASE)).toEqual({ platform: true, rest: '/pricing' });
  });
  it('never lets reserved or nested subdomains become tenants', () => {
    expect('platform' in resolveTenant(`admin.${BASE}`, '/', BASE)).toBe(true);
    expect('invalid' in resolveTenant(`a.b.${BASE}`, '/', BASE)).toBe(true);
    expect('invalid' in resolveTenant(`-bad.${BASE}`, '/', BASE)).toBe(true);
    expect('invalid' in resolveTenant('localhost', '/t/admin', BASE)).toBe(true);
    expect(isValidSlug('api')).toBe(false);
  });
  it('treats other hosts as custom domains and rejects junk hosts', () => {
    expect(resolveTenant('shop.bigco.com', '/', BASE)).toEqual({ tenant: { kind: 'custom_domain', domain: 'shop.bigco.com', rest: '/' } });
    expect('invalid' in resolveTenant('evil.com/../x', '/', BASE)).toBe(true);
    expect('invalid' in resolveTenant(null, '/', BASE)).toBe(true);
  });
  it('rewrites pages and API calls to internal routes', () => {
    expect(rewritePath({ kind: 'subdomain', slug: 'acme', rest: '/api/catalog' })).toBe('/api/t/acme/catalog');
    expect(rewritePath({ kind: 'custom_domain', domain: 'shop.bigco.com', rest: '/' })).toBe('/t/%40shop.bigco.com');
    expect(parseInternalRef('%40shop.bigco.com')).toEqual({ domain: 'shop.bigco.com' });
    expect(parseInternalRef('ADMIN')).toBeNull();
  });
});

describe('routing decisions (middleware)', () => {
  it('rewrites tenant-host pages and API calls into internal routes', () => {
    expect(planRouting(`acme.${BASE}`, '/', BASE)).toEqual({ action: 'rewrite', to: '/t/acme' });
    expect(planRouting(`acme.${BASE}`, '/catalog', BASE)).toEqual({ action: 'rewrite', to: '/t/acme/catalog' });
    expect(planRouting(`acme.${BASE}`, '/api/config', BASE)).toEqual({ action: 'rewrite', to: '/api/t/acme/config' });
    expect(planRouting('shop.bigco.com', '/', BASE)).toEqual({ action: 'rewrite', to: '/t/%40shop.bigco.com' });
  });
  it("lets a tenant host call its OWN internal API URLs, and nobody else's", () => {
    expect(planRouting(`acme.${BASE}`, '/api/t/acme/proofs', BASE)).toEqual({ action: 'next' });
    expect(planRouting(`acme.${BASE}`, '/api/t/ACME/proofs', BASE)).toEqual({ action: 'next' });
    expect(planRouting(`acme.${BASE}`, '/api/t/rival/catalog', BASE)).toMatchObject({ action: 'reject', status: 404 });
    expect(planRouting('shop.bigco.com', '/api/t/%40shop.bigco.com/config', BASE)).toEqual({ action: 'next' });
    expect(planRouting('shop.bigco.com', '/api/t/bigco/config', BASE)).toMatchObject({ action: 'reject' });
    expect(planRouting(`acme.${BASE}`, '/api/t/%E0%A4%A/x', BASE)).toMatchObject({ action: 'reject' });
  });
  it('blocks path-mode tenant pages on a tenant host', () => {
    expect(planRouting(`acme.${BASE}`, '/t/rival', BASE)).toMatchObject({ action: 'reject', status: 404 });
  });
  it('passes platform and path-mode traffic through untouched', () => {
    expect(planRouting('localhost:3000', '/t/acme', BASE)).toEqual({ action: 'next' });
    expect(planRouting('localhost:3000', '/api/t/acme/catalog', BASE)).toEqual({ action: 'next' });
    expect(planRouting(BASE, '/', BASE)).toEqual({ action: 'next' });
    expect(planRouting('bad host!', '/', BASE)).toMatchObject({ action: 'reject', status: 400 });
  });
});

describe('tenant context', () => {
  const { directory } = buildFixture();
  it('builds a server-side flag snapshot and method entitlements per plan', async () => {
    const free = (await loadTenantContext('basic', directory))!;
    const pro = (await loadTenantContext('demo', directory))!;
    expect(free.methods).toEqual(['screen_print', 'embroidery', 'laser_engraving']);
    expect(pro.methods).toHaveLength(9);
  });
  it('custom domains resolve only while entitled', async () => {
    expect((await loadTenantContext('@shop.bigco.com', directory))?.tenant.slug).toBe('bigco');
    expect(await loadTenantContext('@unknown.example.com', directory)).toBeNull();
    // A tenant downgraded below Enterprise keeps its domain row but must stop being served on it.
    const downgraded = new MemoryTenantDirectory(
      fixtureTenants().map((t) => (t.slug === 'bigco' ? { ...t, plan: 'pro' as const } : t)),
    );
    expect(await loadTenantContext('@shop.bigco.com', downgraded)).toBeNull();
    expect((await loadTenantContext('bigco', downgraded))?.tenant.slug).toBe('bigco'); // slug still works
  });
  it('free tenants get platform branding (white-label is a paid feature)', async () => {
    const free = (await loadTenantContext('basic', directory))!;
    expect(free.tenant.branding.primaryHex).toBe('#1F45C6');
    expect(free.tenant.branding.displayName).toBe('Basic Promo');
  });
  it('public config never leaks pricing config or overrides', async () => {
    const cfg = publicTenantConfig((await loadTenantContext('demo', directory))!);
    const json = JSON.stringify(cfg);
    expect(json).not.toContain('pricingConfig');
    expect(json).not.toContain('flagOverrides');
    expect(json).not.toContain('marginMarkup');
  });
});

describe('rate limiter', () => {
  it('allows max per window, then reports retry-after, then resets', async () => {
    const l = new FixedWindowLimiter(2, 10_000);
    expect((await l.hit('k', 0)).ok).toBe(true);
    expect((await l.hit('k', 1)).ok).toBe(true);
    const d = await l.hit('k', 2);
    expect(d.ok).toBe(false);
    expect(d.retryAfterSec).toBe(10);
    expect((await l.hit('k', 10_001)).ok).toBe(true);
    expect((await l.hit('other', 3)).ok).toBe(true); // keys independent
  });

  it('instances sharing a store share one budget (multi-instance deploys)', async () => {
    const store = new MemoryWindowStore();
    const nodeA = new FixedWindowLimiter(3, 60_000, { store, name: 'lead' });
    const nodeB = new FixedWindowLimiter(3, 60_000, { store, name: 'lead' });
    expect((await nodeA.hit('ip', 0)).ok).toBe(true);
    expect((await nodeB.hit('ip', 1)).ok).toBe(true);
    expect((await nodeA.hit('ip', 2)).remaining).toBe(0);
    expect((await nodeB.hit('ip', 3)).ok).toBe(false); // 4th hit overall, on the other node
  });

  it('limiter names keep separate budgets in one shared store', async () => {
    const store = new MemoryWindowStore();
    const lead = new FixedWindowLimiter(1, 60_000, { store, name: 'lead' });
    const upload = new FixedWindowLimiter(1, 60_000, { store, name: 'upload' });
    expect((await lead.hit('ip', 0)).ok).toBe(true);
    expect((await upload.hit('ip', 0)).ok).toBe(true); // same key, different limiter
    expect((await lead.hit('ip', 1)).ok).toBe(false);
  });

  it('a shared store requires a limiter name', () => {
    expect(() => new FixedWindowLimiter(1, 1000, { store: new MemoryWindowStore() })).toThrow(/name/);
  });

  it('fails open when the store is down, and reports it', async () => {
    const errors: unknown[] = [];
    const broken: RateWindowStore = {
      bump: async () => {
        throw new Error('connection refused');
      },
      sweep: async () => 0,
    };
    const l = new FixedWindowLimiter(1, 1000, { store: broken, name: 'x', onStoreError: (e) => errors.push(e) });
    expect((await l.hit('k', 0)).ok).toBe(true);
    expect((await l.hit('k', 1)).ok).toBe(true);
    expect(errors).toHaveLength(2);
  });

  it('never tells a client to retry in 0 seconds', async () => {
    const l = new FixedWindowLimiter(1, 10_000);
    await l.hit('k', 0);
    expect((await l.hit('k', 9_999)).retryAfterSec).toBe(1);
  });

  it('sweep removes only windows that started before the cutoff', async () => {
    const store = new MemoryWindowStore();
    await store.bump('old', 1000, 0);
    await store.bump('new', 1000, 5000);
    expect(await store.sweep(1000)).toBe(1);
    expect((await store.bump('new', 1000, 5001)).count).toBe(2);
    expect((await store.bump('old', 1000, 5001)).count).toBe(1);
  });

  it('warning throttle logs at most once per interval', () => {
    const lines: string[] = [];
    const warn = throttledWarn('[x]', 60_000, (m) => lines.push(m));
    warn(new Error('a'));
    warn(new Error('b'));
    expect(lines).toEqual(['[x]: a']);
  });
});

describe('local filesystem storage', () => {
  it('round-trips, scopes by tenant, and rejects traversal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bc-'));
    const s = new LocalFsStorageProvider(dir);
    await s.put('logos/a/clean.png', Uint8Array.from([1, 2, 3]), 'image/png', DEMO_TENANT_ID);
    expect(Array.from((await s.get('logos/a/clean.png', DEMO_TENANT_ID))!.data)).toEqual([1, 2, 3]);
    expect(await s.get('logos/a/clean.png', FREE_TENANT_ID)).toBeNull();
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', '', 'a//b', '.hidden', 'a/./b']) {
      expect(() => assertSafeKey(bad)).toThrow();
    }
    await expect(s.get('x', '../../etc')).rejects.toThrow();
  });
});

/* ------------------------------ HTTP API ------------------------------ */

const logoBytes = encodePng(sampleLogo());
function upload(ref: string, bytes: Uint8Array<ArrayBuffer> = logoBytes, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), 'logo.png');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://x/api/t/${ref}/logos`, { method: 'POST', body: form, headers });
}
const get = (ref: string, sub: string, headers: Record<string, string> = {}) => new Request(`http://x/api/t/${ref}/${sub}`, { headers });
const pathOf = (r: Request) => new URL(r.url).pathname.split('/').slice(4);

async function call(fx: ReturnType<typeof buildFixture>, ref: string, req: Request) {
  return handleTenantApi(req, ref, pathOf(req), { api: fx.api, directory: fx.directory });
}
async function uploadOk(fx: ReturnType<typeof buildFixture>, ref = 'demo') {
  const r = await call(fx, ref, upload(ref, logoBytes, { knockout: 'true' }));
  expect(r.status).toBe(201);
  return ((await r.json()) as { logo: { id: string } }).logo.id;
}

describe('logo upload API', () => {
  it('processes a logo and dedupes identical re-uploads', async () => {
    const fx = buildFixture();
    const r1 = await call(fx, 'demo', upload('demo', logoBytes, { knockout: 'true' }));
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { logo: { id: string; colorCount: number; needsReview: boolean } };
    expect(b1.logo.colorCount).toBe(3);
    expect(b1.logo.needsReview).toBe(false);
    const r2 = await call(fx, 'demo', upload('demo', logoBytes, { knockout: 'true' }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { logo: { id: string } }).logo.id).toBe(b1.logo.id);
  });

  it('maps intake failures to precise status codes', async () => {
    const fx = buildFixture({ maxUploadBytes: 5_000_000 });
    expect((await call(fx, 'demo', upload('demo', new TextEncoder().encode('not an image')))).status).toBe(415);
    expect((await call(fx, 'demo', upload('demo', new TextEncoder().encode('<svg onload="x()"></svg>')))).status).toBe(422);
    const notMultipart = new Request('http://x/api/t/demo/logos', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    expect((await call(fx, 'demo', notMultipart)).status).toBe(415);
    expect((await call(fx, 'demo', upload('demo', logoBytes, {}, { 'content-length': String(50_000_000) }))).status).toBe(413);
    expect((await call(fx, 'demo', get('demo', 'logos'))).status).toBe(405);
  });

  it('rate-limits uploads per tenant+client with Retry-After', async () => {
    const fx = buildFixture({ uploadLimit: 2 });
    await call(fx, 'demo', upload('demo'));
    await call(fx, 'demo', upload('demo'));
    const r = await call(fx, 'demo', upload('demo'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
  });

  it('serves the cleaned logo only to its own tenant', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx);
    const own = await call(fx, 'demo', get('demo', `logos/${id}/clean.png`));
    expect(own.status).toBe(200);
    expect(decodePng(new Uint8Array(await own.arrayBuffer())).width).toBeGreaterThan(100);
    expect((await call(fx, 'basic', get('basic', `logos/${id}/clean.png`))).status).toBe(404);
  });
});

describe('catalog API', () => {
  it('returns estimated, priced items with proof URLs for the logo', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx);
    const r = await call(fx, 'demo', get('demo', `catalog?logo=${id}&qty=144`));
    expect(r.status).toBe(200);
    const b = (await r.json()) as { estimated: boolean; disclaimer: string; items: Array<{ proofUrl: string | null; unit: number; priceBreaks: unknown[] }>; facets: unknown };
    expect(b.estimated).toBe(true);
    expect(b.disclaimer).toMatch(/not a quote/i);
    expect(b.items.length).toBe(6);
    // demo has a hard lead gate with 3 free products: exactly 3 proof URLs until an email is given
    expect(b.items.filter((i) => i.proofUrl?.startsWith('/api/t/demo/proofs?')).length).toBe(3);
    expect(b.items.filter((i) => i.proofUrl === null).length).toBe(3);
    expect(b.facets).not.toBeNull();
  });

  it('validates every parameter', async () => {
    const fx = buildFixture();
    for (const q of ['qty=0', 'qty=abc', 'family=plaid', 'method=teleport', 'sort=random', 'max=1.5', 'logo=nope']) {
      expect((await call(fx, 'demo', get('demo', `catalog?${q}`))).status).toBe(400);
    }
  });

  it('enforces plan entitlements server-side', async () => {
    const fx = buildFixture();
    const free = (await (await call(fx, 'basic', get('basic', 'catalog?qty=144'))).json()) as { items: Array<{ method: string; alternatives: Array<{ method: string }> }> };
    for (const i of free.items) {
      for (const m of [i.method, ...i.alternatives.map((a) => a.method)]) expect(['screen_print', 'embroidery', 'laser_engraving']).toContain(m);
    }
    const eco = await call(fx, 'basic', get('basic', 'catalog?eco=1'));
    expect(eco.status).toBe(403);
    expect(((await eco.json()) as { error: { feature: string } }).error.feature).toBe('sustainable_filter');
    expect((await call(fx, 'basic', get('basic', 'catalog?method=dtg'))).status).toBe(403);
    expect((await call(fx, 'demo', get('demo', 'catalog?eco=1'))).status).toBe(200);
  });

  it("can't use another tenant's logo", async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx, 'demo');
    expect((await call(fx, 'basic', get('basic', `catalog?logo=${id}`))).status).toBe(404);
  });
});

describe('proof API', () => {
  const q = (id: string, extra: Record<string, string> = {}) =>
    `proofs?${new URLSearchParams({ logo: id, product: 'classic-cotton-tee', color: '#0A0A0A', method: 'screen_print', location: 'full_front', ...extra })}`;

  it('renders, then serves from cache, honours ETag, and returns renderer notes', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx);
    const r1 = await call(fx, 'demo', get('demo', q(id)));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-proof-cache')).toBe('miss');
    const notes = JSON.parse(decodeURIComponent(r1.headers.get('x-proof-notes')!)) as string[];
    expect(notes.some((n) => /hard to see/.test(n))).toBe(true); // navy ink on black tee
    const r2 = await call(fx, 'demo', get('demo', q(id)));
    expect(r2.headers.get('x-proof-cache')).toBe('hit');
    expect(Array.from(new Uint8Array(await r2.arrayBuffer()))).toEqual(Array.from(new Uint8Array(await r1.arrayBuffer())));
    const r3 = await call(fx, 'demo', get('demo', q(id), { 'if-none-match': r1.headers.get('etag')! }));
    expect(r3.status).toBe(304);
  });

  it('only renders real product configurations', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx);
    expect((await call(fx, 'demo', get('demo', q(id, { color: '#123456' })))).status).toBe(400); // colour not offered
    expect((await call(fx, 'demo', get('demo', q(id, { location: 'sleeve' })))).status).toBe(400);
    const sub = q(id, { product: 'performance-polo', color: '#1F45C6', method: 'sublimation', location: 'full_front' });
    expect((await call(fx, 'demo', get('demo', sub))).status).toBe(422); // sublimation on dark
    expect((await call(fx, 'demo', get('demo', q(id, { product: 'nope' })))).status).toBe(404);
  });

  it('gates methods by plan and obeys global kill switches', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx, 'basic');
    expect((await call(fx, 'basic', get('basic', q(id, { method: 'dtg' })))).status).toBe(403);
    expect((await call(fx, 'basic', get('basic', q(id)))).status).toBe(200);
    fx.directory.setKillSwitches(['brand_exact_proof']);
    const killed = await call(fx, 'basic', get('basic', q(id)));
    expect(killed.status).toBe(403);
    expect(((await killed.json()) as { error: { upgradeable: boolean } }).error.upgradeable).toBe(false);
  });

  it('keeps proof caches tenant-scoped', async () => {
    const fx = buildFixture();
    const id = await uploadOk(fx, 'demo');
    await call(fx, 'demo', get('demo', q(id)));
    expect((await call(fx, 'basic', get('basic', q(id)))).status).toBe(404);
    expect(await fx.storage.get('logos/' + id + '/clean.png', FREE_TENANT_ID)).toBeNull();
  });
});

describe('router', () => {
  it('returns the same 404 for unknown tenants and unknown routes', async () => {
    const fx = buildFixture();
    const a = await call(fx, 'nosuch', get('nosuch', 'config'));
    const b = await call(fx, 'demo', get('demo', 'secret'));
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
  });
  it('serves public config through a custom domain ref', async () => {
    const fx = buildFixture();
    const r = await call(fx, '@shop.bigco.com', get('@shop.bigco.com', 'config'));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { branding: { displayName: string } }).branding.displayName).toBe('BigCo Merch');
  });
});
