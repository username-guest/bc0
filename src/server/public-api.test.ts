/** Public REST API v1 and API keys (ADR 0016). */
import { describe, it, expect } from 'vitest';
import { buildFixture, ENT_TENANT_ID } from './testing';
import { handleTenantApi } from './http/router';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { MockEmailProvider } from '@/shared/providers/mocks';
import { MAX_API_KEYS } from './http/admin-api';
import { makeApiUrl } from './admin/urls';
import { planRouting } from './tenancy/resolve';
import type { TenantContext } from './tenancy/context';

type Fx = ReturnType<typeof buildFixture>;

function setup(opts: Parameters<typeof buildFixture>[0] = {}) {
  let now = new Date('2026-09-10T12:00:00Z');
  const email = new MockEmailProvider();
  const fx = buildFixture({ email, now: () => now, ...opts });
  return { fx, email, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const route = (fx: Fx, req: Request, ref: string, sub: string) =>
  handleTenantApi(req, ref, sub.split('?')[0]!.split('/'), { api: fx.api, admin: fx.admin, directory: fx.directory, publicApi: fx.publicApi });

/** A server-to-server caller: just a bearer token, no cookies. */
function caller(fx: Fx, ref: string, token: string | null) {
  return (sub: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    return route(fx, new Request(`http://localhost/api/t/${ref}/v1/${sub}`, { ...init, headers }), ref, `v1/${sub}`);
  };
}

/** A signed-in admin (cookie jar + CSRF). */
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
  const send = (method: string, sub: string, body: unknown) => call(sub, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await send('POST', 'admin/sign-in', { email: who });
  await fx.admin.settled();
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail.sent[mail.sent.length - 1]!.text)![1]!;
  expect((await send('POST', 'admin/verify', { token })).status).toBe(200);
  csrf = (await (await call('admin/me')).json()).csrfToken;
  return { call, send, cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '), dropCsrf: () => void (csrf = '') };
}

type KeyDto = { id: string; name: string; hint: string; scopes: string[]; lastUsedAt: string | null; revoked: boolean };
async function newKey(a: Awaited<ReturnType<typeof admin>>, scopes = ['leads:read', 'catalog:read', 'analytics:read'], name = 'CRM sync') {
  const r = await a.send('POST', 'admin/api-keys', { name, scopes });
  expect(r.status).toBe(201);
  return (await r.json()) as { key: KeyDto; secret: string };
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { data: unknown; error?: { code: string } };

async function seedLeads(fx: Fx, n: number) {
  for (let i = 0; i < n; i++) {
    const { lead } = await fx.leads.upsertByEmail(ENT_TENANT_ID, { email: `p${i}@acme.test`, source: 'email_gate', marketingOptIn: i % 2 === 0, consentVersion: 'v1', name: `P ${i}` }, new Date(Date.UTC(2026, 8, 1, 12, i)));
    await fx.leads.addEvent({ id: crypto.randomUUID(), tenantId: ENT_TENANT_ID, leadId: lead.id, kind: 'captured', payload: { trackedLink: { code: 'abcdefg', label: 'Booth' } }, createdAt: lead.createdAt });
  }
}

describe('issuing keys', () => {
  it('an owner creates a key and sees its secret once; the list never shows it again', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const { key, secret } = await newKey(o);
    expect(secret).toMatch(/^bck_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(key.hint).toBe(`${secret.slice(0, 17)}…`); // 'bck_' + id + '_', then an ellipsis
    const listed = await (await o.call('admin/api-keys')).text();
    expect(listed).not.toContain(secret.slice(17));
    expect(listed).not.toMatch(/secretHash|secret_hash/);
    expect(JSON.parse(listed)).toMatchObject({ canCreate: true, baseUrl: 'http://localhost:3000/api/t/bigco/v1' });
    const stored = (await fx.apiKeys.list(ENT_TENANT_ID))[0]!;
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(secret.slice(17));
  });

  it('is owner-only, validated, CSRF-protected, capped and audited', async () => {
    const { fx, email } = setup();
    const staff = await admin(fx, email, 'bigco', 'staff@bigco.test');
    expect((await staff.call('admin/api-keys')).status).toBe(403);
    expect((await staff.send('POST', 'admin/api-keys', { name: 'x', scopes: ['leads:read'] })).status).toBe(403);

    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const bad = await o.send('POST', 'admin/api-keys', { name: '', scopes: ['leads:write'] });
    expect(bad.status).toBe(422);
    expect(Object.keys(((await bad.json()) as { error: { fields: object } }).error.fields).sort()).toEqual(['name', 'scopes']);
    expect((await o.send('POST', 'admin/api-keys', { name: 'x', scopes: [] })).status).toBe(422);

    for (let i = 0; i < MAX_API_KEYS; i++) await newKey(o, ['catalog:read'], `k${i}`);
    const full = await o.send('POST', 'admin/api-keys', { name: 'one more', scopes: ['catalog:read'] });
    expect(full.status).toBe(409);
    const first = ((await (await o.call('admin/api-keys')).json()) as { keys: KeyDto[] }).keys.at(-1)!;
    expect((await o.send('POST', `admin/api-keys/${first.id}/revoke`, {})).status).toBe(200);
    expect((await o.send('POST', `admin/api-keys/${first.id}/revoke`, {})).status).toBe(404); // already revoked
    expect((await o.send('POST', 'admin/api-keys', { name: 'one more', scopes: ['catalog:read'] })).status).toBe(201);

    const actions = (await fx.audit.recent(ENT_TENANT_ID, 50)).map((e) => e.action);
    expect(actions.filter((x) => x === 'api_keys.create').length).toBe(MAX_API_KEYS + 1);
    expect(actions).toContain('api_keys.revoke');

    o.dropCsrf();
    expect((await o.send('POST', 'admin/api-keys', { name: 'sneaky', scopes: ['leads:read'] })).status).toBe(403);
  });

  it('plans without API access can\'t create keys, but can always revoke them', async () => {
    const { fx, email } = setup();
    const demo = await admin(fx, email, 'demo', 'owner@demo.test'); // Pro
    const r = await demo.send('POST', 'admin/api-keys', { name: 'x', scopes: ['leads:read'] });
    expect(r.status).toBe(403);
    expect((await json(r)).error?.code).toBe('feature_locked');
    expect(await (await demo.call('admin/api-keys')).json()).toMatchObject({ canCreate: false, upgradeable: true });

    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const { key, secret } = await newKey(o);
    await fx.directory.setFlagOverrides(ENT_TENANT_ID, ['api_access'], { api_access: false });
    const refused = await caller(fx, 'bigco', secret)('leads');
    expect(refused.status).toBe(403);
    expect((await json(refused)).error?.code).toBe('feature_locked');
    expect((await o.send('POST', `admin/api-keys/${key.id}/revoke`, {})).status).toBe(200);
  });
});

describe('authentication', () => {
  it('refuses missing, malformed, wrong, revoked and other-site keys with the same 401', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const { key, secret } = await newKey(o);
    const wrongSecret = secret.slice(0, 18) + (secret[18] === 'A' ? 'B' : 'A') + secret.slice(19);
    for (const token of [null, '', 'nope', `${secret}x`, wrongSecret, secret.replace('bck_', 'bcx_')]) {
      const r = await caller(fx, 'bigco', token)('leads');
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    }
    // Keys belong to one site: the same token on another tenant's host is not a key there.
    expect((await caller(fx, 'demo', secret)('leads')).status).toBe(401);
    // An admin session cookie is not an API credential.
    const r = await route(fx, new Request('http://localhost/api/t/bigco/v1/leads', { headers: { cookie: o.cookie() } }), 'bigco', 'v1/leads');
    expect(r.status).toBe(401);

    expect((await caller(fx, 'bigco', secret)('leads')).status).toBe(200);
    await o.send('POST', `admin/api-keys/${key.id}/revoke`, {});
    expect((await caller(fx, 'bigco', secret)('leads')).status).toBe(401); // revoked: stops at once
  });

  it('scopes limit what a key can read', async () => {
    const { fx, email } = setup();
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const { secret } = await newKey(o, ['catalog:read']);
    const api = caller(fx, 'bigco', secret);
    expect((await api('products')).status).toBe(200);
    for (const path of ['leads', `leads/${crypto.randomUUID()}`, 'analytics']) {
      const r = await api(path);
      expect(r.status).toBe(403);
      expect((await json(r)).error?.code).toBe('insufficient_scope');
    }
  });

  it('rate-limits each key, and records last use without writing on every request', async () => {
    const { fx, email, advance } = setup({ apiLimit: 3 });
    const o = await admin(fx, email, 'bigco', 'owner@bigco.test');
    const { secret } = await newKey(o);
    const api = caller(fx, 'bigco', secret);
    expect((await api('products')).status).toBe(200);
    const first = (await fx.apiKeys.list(ENT_TENANT_ID))[0]!.lastUsedAt;
    expect(first).toBe('2026-09-10T12:00:00.000Z');
    advance(30_000);
    await api('products');
    expect((await fx.apiKeys.list(ENT_TENANT_ID))[0]!.lastUsedAt).toBe(first); // under a minute: untouched
    await api('products');
    expect((await api('products')).status).toBe(429);
    advance(61_000);
    // A second key has its own budget.
    const other = caller(fx, 'bigco', (await newKey(o, ['catalog:read'], 'other')).secret);
    expect((await other('products')).status).toBe(200);
  });

  it('is read-only', async () => {
    const { fx, email } = setup();
    const { secret } = await newKey(await admin(fx, email, 'bigco', 'owner@bigco.test'));
    expect((await caller(fx, 'bigco', secret)('leads', { method: 'POST' })).status).toBe(405);
    expect((await caller(fx, 'bigco', secret)('nope')).status).toBe(404);
  });
});

describe('endpoints', () => {
  it('leads: newest first, paginated, filterable, with each lead\'s history', async () => {
    const { fx, email } = setup();
    await seedLeads(fx, 5);
    const { secret } = await newKey(await admin(fx, email, 'bigco', 'owner@bigco.test'));
    const api = caller(fx, 'bigco', secret);
    const p1 = (await json(await api('leads?limit=2'))) as { data: { id: string; email: string }[]; nextCursor: string };
    expect(p1.data.map((l) => l.email)).toEqual(['p4@acme.test', 'p3@acme.test']);
    const p2 = (await json(await api(`leads?limit=2&cursor=${p1.nextCursor}`))) as { data: { email: string }[] };
    expect(p2.data.map((l) => l.email)).toEqual(['p2@acme.test', 'p1@acme.test']);
    expect(((await json(await api('leads?source=quote_request'))) as { data: unknown[] }).data).toEqual([]);
    const bad = await api('leads?limit=500&source=fax');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { details: string[] } }).error.details.length).toBe(2);

    const one = (await json(await api(`leads/${p1.data[0]!.id}`))) as { data: { email: string; events: { kind: string; details: { trackedLink: unknown } }[] } };
    expect(one.data.email).toBe('p4@acme.test');
    expect(one.data.events[0]).toMatchObject({ kind: 'captured', details: { trackedLink: { code: 'abcdefg', label: 'Booth' } } });
    expect((await api('leads/not-a-uuid')).status).toBe(404);
    expect((await api(`leads/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('leads never cross tenants', async () => {
    const { fx, email } = setup();
    await fx.leads.upsertByEmail(DEMO_TENANT_ID, { email: 'demo-only@acme.test', source: 'email_gate', marketingOptIn: false, consentVersion: 'v1' }, new Date());
    const demoLead = (await fx.leads.list(DEMO_TENANT_ID, { limit: 5 })).items[0]!;
    const { secret } = await newKey(await admin(fx, email, 'bigco', 'owner@bigco.test'));
    const api = caller(fx, 'bigco', secret);
    expect(((await json(await api('leads'))) as { data: unknown[] }).data).toEqual([]);
    expect((await api(`leads/${demoLead.id}`)).status).toBe(404);
  });

  it('products: selling prices at the asked quantity, never costs', async () => {
    const { fx, email } = setup();
    const { secret } = await newKey(await admin(fx, email, 'bigco', 'owner@bigco.test'));
    const api = caller(fx, 'bigco', secret);
    const r = await api('products?qty=576');
    const body = await r.text();
    expect(r.status).toBe(200);
    // No field anywhere in the response carries cost data (the disclaimer's wording may mention costs).
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(JSON.parse(body));
    expect(keys.filter((k) => /blank|margin|markup|cost|base/i.test(k))).toEqual([]);
    const p = JSON.parse(body) as { data: { slug: string; colors: unknown[]; decorations: unknown[]; estimate: { quantity: number; unitCents: number; totalCents: number } }[]; estimated: boolean; disclaimer: string };
    expect(p.estimated).toBe(true);
    expect(p.data.length).toBeGreaterThan(0);
    for (const x of p.data) {
      expect(x.estimate.quantity).toBe(576);
      expect(Number.isInteger(x.estimate.unitCents) && x.estimate.unitCents > 0).toBe(true);
      // The unit price is rounded to the cent; the total is exact: they agree within a cent per item.
      expect(Math.abs(x.estimate.totalCents - x.estimate.unitCents * 576)).toBeLessThanOrEqual(576);
      expect(x.colors.length && x.decorations.length).toBeTruthy();
    }
    // Same numbers the storefront shows for a one-colour logo at that quantity.
    const store = (await (await route(fx, new Request('http://localhost/api/t/bigco/catalog?qty=576'), 'bigco', 'catalog')).json()) as { items: { slug: string; unit: number }[] };
    for (const x of p.data) expect(x.estimate.unitCents).toBe(store.items.find((i) => i.slug === x.slug)!.unit);
    expect((await api('products?qty=0')).status).toBe(400);
    expect((await api('products?qty=abc')).status).toBe(400);
  });

  it('analytics: the dashboard numbers, offered ranges only', async () => {
    const { fx, email } = setup();
    await fx.analytics.record({ tenantId: ENT_TENANT_ID, day: '2026-09-10', sessionId: 's', kind: 'visit', linkId: null });
    const { secret } = await newKey(await admin(fx, email, 'bigco', 'owner@bigco.test'));
    const api = caller(fx, 'bigco', secret);
    const r = (await json(await api('analytics?days=7'))) as { data: { totals: { visit: number }; range: { days: number } }; timezone: string };
    expect(r).toMatchObject({ data: { totals: { visit: 1 }, range: { days: 7 } }, timezone: 'UTC' });
    expect((await api('analytics?days=13')).status).toBe(400);
  });

  it('the advertised base URL reaches the API in both path mode and on tenant hosts', () => {
    const ctx = (customDomain: string | null, entitled: boolean) =>
      ({ tenant: { slug: 'bigco', customDomain }, can: (f: string) => f === 'custom_domain' && entitled }) as unknown as TenantContext;
    // Path mode: /t/<slug>/… is the storefront, so the API must use its internal path.
    // (A path-mode deploy serves from the platform host: PUBLIC_BASE_URL's host is BASE_DOMAIN.)
    expect(makeApiUrl({ publicBaseUrl: 'https://brandcanvas.app/', baseDomain: 'brandcanvas.app' })(ctx(null, false), '/v1')).toBe('https://brandcanvas.app/api/t/bigco/v1');
    expect(planRouting('brandcanvas.app', '/api/t/bigco/v1/leads', 'brandcanvas.app')).toEqual({ action: 'next' });
    expect(planRouting('brandcanvas.app', '/t/bigco/api/v1/leads', 'brandcanvas.app')).toEqual({ action: 'next' }); // → a storefront page, not the API
    // Tenant hosts: /api/v1 is rewritten to the same internal route.
    const hosted = makeApiUrl({ baseDomain: 'brandcanvas.app' });
    expect(hosted(ctx(null, false), '/v1')).toBe('https://bigco.brandcanvas.app/api/v1');
    expect(planRouting('bigco.brandcanvas.app', '/api/v1/leads', 'brandcanvas.app')).toEqual({ action: 'rewrite', to: '/api/t/bigco/v1/leads' });
    expect(hosted(ctx('merch.bigco.com', true), '/v1')).toBe('https://merch.bigco.com/api/v1');
    expect(hosted(ctx('merch.bigco.com', false), '/v1')).toBe('https://bigco.brandcanvas.app/api/v1'); // domain not on the plan
  });
});
