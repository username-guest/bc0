/** Supplier connections and catalog sync (ADR 0017), end to end on the in-memory fixture. */
import { describe, it, expect } from 'vitest';
import { buildFixture, ENT_TENANT_ID } from './testing';
import { handleTenantApi } from './http/router';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { MockEmailProvider } from '@/shared/providers/mocks';
import { loadTenantContext } from './tenancy/context';
import { FAKE_CREDENTIALS, FAKE_ENDPOINTS } from '@/integrations/promostandards/fake-supplier';
import { SYNC_LOCK_MS } from './suppliers/service';
import { importedIdentity } from './suppliers/identity';

type Fx = ReturnType<typeof buildFixture>;

function setup() {
  let now = new Date('2026-09-10T12:00:00Z');
  const email = new MockEmailProvider();
  const fx = buildFixture({ email, now: () => now });
  return { fx, email, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const route = (fx: Fx, req: Request, ref: string, sub: string) =>
  handleTenantApi(req, ref, sub.split('?')[0]!.split('/'), { api: fx.api, admin: fx.admin, directory: fx.directory, publicApi: fx.publicApi });

async function admin(fx: Fx, mail: MockEmailProvider, ref: string, who: string) {
  const jar = new Map<string, string>();
  let csrf = '';
  async function call(sub: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] ??= csrf;
    const res = await route(fx, new Request(`http://localhost/api/t/${ref}/${sub}`, { ...init, headers }), ref, sub);
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  }
  const send = (method: string, sub: string, body?: unknown) =>
    call(sub, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await send('POST', 'admin/sign-in', { email: who });
  await fx.admin.settled();
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail.sent[mail.sent.length - 1]!.text)![1]!;
  expect((await send('POST', 'admin/verify', { token })).status).toBe(200);
  csrf = (await (await call('admin/me')).json()).csrfToken;
  return { call, send };
}

type SupplierDto = { id: string; name: string; status: string; hasPassword: boolean; productIds: string[]; lastSync: null | { created: number; updated: number; hidden: number; skipped: number; failed: number; error?: string; notes: string[] } };

const CONNECTION = {
  name: 'Acme Promo',
  productDataUrl: FAKE_ENDPOINTS.productData,
  pricingUrl: FAKE_ENDPOINTS.pricing,
  accountId: FAKE_CREDENTIALS.id,
  password: FAKE_CREDENTIALS.password,
};

async function connect(o: Awaited<ReturnType<typeof admin>>, body: Record<string, unknown> = CONNECTION) {
  const r = await o.send('POST', 'admin/suppliers', body);
  expect(r.status).toBe(201);
  return ((await r.json()) as { supplier: SupplierDto }).supplier;
}

async function syncNow(fx: Fx, o: Awaited<ReturnType<typeof admin>>, id: string, ref = 'bigco') {
  expect((await o.send('POST', `admin/suppliers/${id}/sync`)).status).toBe(202);
  const ctx = (await loadTenantContext(ref, fx.directory))!;
  await fx.supplierService.runDue(ctx);
  const list = (await (await o.call('admin/suppliers')).json()) as { suppliers: SupplierDto[] };
  return list.suppliers.find((s) => s.id === id)!;
}

describe('connecting a supplier', () => {
  it('an owner connects one; the password is sealed and never returned', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const r = await o.send('POST', 'admin/suppliers', CONNECTION);
    expect(r.status).toBe(201);
    const text = await r.clone().text();
    expect(text).not.toContain(FAKE_CREDENTIALS.password);
    const { supplier } = (await r.json()) as { supplier: SupplierDto & Record<string, unknown> };
    expect(supplier).toMatchObject({ name: 'Acme Promo', status: 'never', hasPassword: true, productIds: [], currency: 'USD', priceType: 'Net' });
    expect('password' in supplier || 'passwordSealed' in supplier).toBe(false);

    const stored = (await fx.suppliers.get(ENT_TENANT_ID, supplier.id))!;
    expect(stored.passwordSealed).not.toContain(FAKE_CREDENTIALS.password);
    expect(fx.secrets.open(stored.passwordSealed, ENT_TENANT_ID)).toBe(FAKE_CREDENTIALS.password);
    // Sealed for this tenant only.
    expect(() => fx.secrets.open(stored.passwordSealed, DEMO_TENANT_ID)).toThrow();

    const list = await (await o.call('admin/suppliers')).text();
    expect(list).not.toContain(FAKE_CREDENTIALS.password);
    expect((await fx.audit.recent(ENT_TENANT_ID, 100)).some((e) => e.action === 'suppliers.create' && e.target === 'Acme Promo')).toBe(true);
  });

  it('validates the form, including addresses that point inside the network', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const r = await o.send('POST', 'admin/suppliers', { name: '', productDataUrl: 'http://ps.acme.com/pd', pricingUrl: 'https://10.0.0.8/ppc', accountId: '', password: '', currency: 'dollars', priceType: 'Cheap', productIds: 'ok-1, bad id!' });
    expect(r.status).toBe(422);
    const { error } = (await r.json()) as { error: { fields: Record<string, string> } };
    expect(Object.keys(error.fields).sort()).toEqual(['accountId', 'currency', 'name', 'password', 'priceType', 'pricingUrl', 'productDataUrl', 'productIds']);
    expect(error.fields.productDataUrl).toMatch(/must use https/);
    expect(error.fields.pricingUrl).toMatch(/private or internal/);

    await connect(o);
    const dup = await o.send('POST', 'admin/suppliers', CONNECTION);
    expect(dup.status).toBe(409);
  });

  it("the webhooks' test-only insecure switch never loosens supplier addresses", async () => {
    const email = new MockEmailProvider();
    const fx = buildFixture({ email, allowInsecureWebhooks: true });
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const r = await o.send('POST', 'admin/suppliers', { ...CONNECTION, productDataUrl: 'http://promostandards.example/pd' });
    expect(r.status).toBe(422);
  });

  it('is owners only, and Enterprise only (but removing works on any plan)', async () => {
    const { fx, email } = setup();
    const staff = await admin(fx, email, 'bigco', 'staff@bigco.test');
    expect((await staff.call('admin/suppliers')).status).toBe(403);
    expect((await staff.send('POST', 'admin/suppliers', CONNECTION)).status).toBe(403);

    const pro = await admin(fx, email, 'demo', 'owner@demo.test');
    const list = (await (await pro.call('admin/suppliers')).json()) as { canUse: boolean; upgradeable: boolean };
    expect(list).toMatchObject({ canUse: false, upgradeable: true });
    const r = await pro.send('POST', 'admin/suppliers', CONNECTION);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('feature_locked');
  });

  it("one tenant can't see, edit, sync or delete another's connection", async () => {
    const { fx, email } = setup();
    const big = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(big);
    const demo = await admin(fx, email, 'demo', 'owner@demo.test');
    const seen = (await (await demo.call('admin/suppliers')).json()) as { suppliers: unknown[] };
    expect(seen.suppliers).toEqual([]);
    // demo is Pro: PUT/sync are refused by the plan gate first; DELETE (any plan) must 404.
    expect((await demo.send('DELETE', `admin/suppliers/${c.id}`)).status).toBe(404);
    expect(await fx.suppliers.get(ENT_TENANT_ID, c.id)).not.toBeNull();
    expect(await fx.suppliers.get(DEMO_TENANT_ID, c.id)).toBeNull();
  });
});

describe('syncing', () => {
  it('imports into the storefront catalog, reports what it left out, and re-syncs in place', async () => {
    const { fx, email, advance } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    const before = (await fx.products.list(ENT_TENANT_ID)).length;

    const first = await syncNow(fx, o, c.id);
    expect(first.status).toBe('ok');
    expect(first.lastSync).toMatchObject({ created: 2, updated: 0, hidden: 0, skipped: 1, failed: 0 });
    expect(first.lastSync!.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Not imported: 8 GB Swivel USB Drive/), expect.stringMatching(/Athletic Heather/), expect.stringMatching(/4CP Full Color/)]),
    );

    const products = await fx.products.list(ENT_TENANT_ID);
    expect(products.length).toBe(before + 2);
    const tee = products.find((p) => p.slug === 'supplier-heavy-cotton-tee')!;
    expect(tee.breaks).toEqual([
      { minQty: 24, blankUnitCost: 410 },
      { minQty: 72, blankUnitCost: 346 },
      { minQty: 144, blankUnitCost: 320 },
    ]);

    // The prospect-facing catalog shows it, priced by the tenant's own rules.
    const cat = await route(fx, new Request('http://localhost/api/t/bigco/catalog?qty=144'), 'bigco', 'catalog');
    expect(cat.status).toBe(200);
    const body = (await cat.json()) as { items: Array<{ slug: string; estimate?: { unitPrice?: number } }> };
    expect(body.items.map((i) => i.slug)).toContain('supplier-heavy-cotton-tee');
    expect(JSON.stringify(body)).not.toMatch(/blankUnitCost|"breaks"/); // costs never reach prospects

    advance(60_000);
    const again = await syncNow(fx, o, c.id);
    expect(again.lastSync).toMatchObject({ created: 0, updated: 2, hidden: 0 });
    expect((await fx.products.list(ENT_TENANT_ID)).length).toBe(before + 2);
    expect((await fx.audit.recent(ENT_TENANT_ID, 100)).filter((e) => e.action === 'suppliers.sync').length).toBe(2);
  });

  it('narrowing to picked products hides the rest (never deletes); deleting the connection hides all', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    await syncNow(fx, o, c.id);
    const r = await o.send('PUT', `admin/suppliers/${c.id}`, { productIds: 'PS-TEE-100' });
    expect(r.status).toBe(200);
    const picked = await syncNow(fx, o, c.id);
    expect(picked.lastSync).toMatchObject({ created: 0, updated: 1, hidden: 1 });
    const slugs = (await fx.products.list(ENT_TENANT_ID)).map((p) => p.slug);
    expect(slugs).toContain('supplier-heavy-cotton-tee');
    expect(slugs).not.toContain('20-oz-recycled-steel-tumbler');

    expect((await o.send('DELETE', `admin/suppliers/${c.id}`)).status).toBe(200);
    expect((await fx.products.list(ENT_TENANT_ID)).some((p) => p.slug === 'supplier-heavy-cotton-tee')).toBe(false);
    expect((await fx.audit.recent(ENT_TENANT_ID, 100)).some((e) => e.action === 'suppliers.delete')).toBe(true);
  });

  it('a second connection to the same products never overwrites the first', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const a = await connect(o);
    const b = await connect(o, { ...CONNECTION, name: 'Acme Promo (second account)' });
    await syncNow(fx, o, a.id);
    await syncNow(fx, o, b.id);
    const names = (await fx.products.list(ENT_TENANT_ID)).map((p) => p.name).filter((n) => n.startsWith('Supplier Heavy'));
    expect(names.sort()).toEqual(['Supplier Heavy Cotton Tee', 'Supplier Heavy Cotton Tee · PS-TEE-100']);
    expect(importedIdentity('X', 'x', 'P-1', { names: new Set(['x']), slugs: new Set() })).toEqual({ name: 'X · P-1', slug: 'x-p-1' });
    // A third connection to the same product must not collide with the second.
    expect(importedIdentity('X', 'x', 'P-1', { names: new Set(['x', 'x · p-1']), slugs: new Set(['x', 'x-p-1']) })).toEqual({ name: 'X · P-1 (2)', slug: 'x-p-1-2' });
    const c3 = await connect(o, { ...CONNECTION, name: 'Acme Promo (third account)' });
    const third = await syncNow(fx, o, c3.id);
    expect(third.status).toBe('ok');
    const tees = (await fx.products.list(ENT_TENANT_ID)).filter((p) => p.name.startsWith('Supplier Heavy'));
    expect(tees.map((p) => p.name).sort()).toEqual(['Supplier Heavy Cotton Tee', 'Supplier Heavy Cotton Tee · PS-TEE-100', 'Supplier Heavy Cotton Tee · PS-TEE-100 (2)']);
    expect(new Set(tees.map((p) => p.slug)).size).toBe(3);
    // Re-syncing all three keeps every name and slug where it was.
    for (const id of [a.id, b.id, c3.id]) expect((await syncNow(fx, o, id)).status).toBe('ok');
    const again = (await fx.products.list(ENT_TENANT_ID)).filter((p) => p.name.startsWith('Supplier Heavy'));
    expect(again.map((p) => `${p.name}|${p.slug}`).sort()).toEqual(tees.map((p) => `${p.name}|${p.slug}`).sort());
  });

  it('wrong credentials: a failed run with the supplier’s reason, and the catalog unchanged', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    await syncNow(fx, o, c.id);
    const count = (await fx.products.list(ENT_TENANT_ID)).length;

    // A blank password keeps the saved one; a new one replaces it.
    expect((await o.send('PUT', `admin/suppliers/${c.id}`, { password: '' })).status).toBe(200);
    expect(fx.secrets.open((await fx.suppliers.get(ENT_TENANT_ID, c.id))!.passwordSealed, ENT_TENANT_ID)).toBe(FAKE_CREDENTIALS.password);
    expect((await o.send('PUT', `admin/suppliers/${c.id}`, { password: 'wrong' })).status).toBe(200);

    const failed = await syncNow(fx, o, c.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastSync!.error).toMatch(/refused the request: Authentication Credentials failed \(code 105\)/);
    expect((await fx.products.list(ENT_TENANT_ID)).length).toBe(count);
  });

  it('the plan is checked when the run starts, not only when it was requested', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    expect((await o.send('POST', `admin/suppliers/${c.id}/sync`)).status).toBe(202);
    const ctx = (await loadTenantContext('bigco', fx.directory))!;
    const downgraded = { ...ctx, can: (k: Parameters<typeof ctx.can>[0]) => (k === 'promostandards_live' ? false : ctx.can(k)) };
    await fx.supplierService.runDue(downgraded);
    const got = (await fx.suppliers.get(ENT_TENANT_ID, c.id))!;
    expect(got.status).toBe('failed');
    expect(got.lastSync!.error).toMatch(/not included in your plan/);
    expect((await fx.products.list(ENT_TENANT_ID)).some((p) => p.slug === 'supplier-heavy-cotton-tee')).toBe(false);
    // ...and the daily refresh doesn't run for it either.
    expect(await fx.supplierService.runDue(downgraded)).toBe(0);
  });

  it('one sync at a time per connection; a crashed worker’s lock expires', async () => {
    const { fx, email, advance } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    expect((await o.send('POST', `admin/suppliers/${c.id}/sync`)).status).toBe(202);
    expect((await o.send('POST', `admin/suppliers/${c.id}/sync`)).status).toBe(409);
    // A worker claims it and dies mid-run.
    expect(await fx.suppliers.transition(ENT_TENANT_ID, c.id, ['queued'], 'running', new Date('2026-09-10T12:00:00Z'))).toBe(true);
    const ctx = (await loadTenantContext('bigco', fx.directory))!;
    expect(await fx.supplierService.run(ctx, c.id)).toBeNull(); // still locked
    advance(SYNC_LOCK_MS + 1000);
    expect(await fx.supplierService.runDue(ctx)).toBe(1); // stale lock taken over
    expect((await fx.suppliers.get(ENT_TENANT_ID, c.id))!.status).toBe('ok');
  });

  it('runs the daily refresh for connections synced over a day ago', async () => {
    const { fx, email, advance } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const c = await connect(o);
    // Never-synced connections wait for the owner: no surprise first run.
    const untouched = await connect(o, { ...CONNECTION, name: 'Untouched' });
    await syncNow(fx, o, c.id);
    const ctx = (await loadTenantContext('bigco', fx.directory))!;
    expect(await fx.supplierService.runDue(ctx)).toBe(0); // fresh
    advance(25 * 3_600_000);
    expect(await fx.supplierService.runDue(ctx)).toBe(1);
    expect((await fx.suppliers.get(ENT_TENANT_ID, untouched.id))!.status).toBe('never');
    expect(await fx.supplierService.runDue(ctx)).toBe(0); // refreshed just now
  });
});
