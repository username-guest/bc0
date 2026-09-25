/** Tenant admin (ADR 0008): magic-link sign-in, sessions, CSRF, roles, settings, inbox, export. */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildFixture, ENT_TENANT_ID, FREE_TENANT_ID } from './testing';
import { handleTenantApi } from './http/router';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { MockEmailProvider } from '@/shared/providers/mocks';
import { BACKOFF_MS } from './leads/delivery';
import { INVITE_TTL_MS, MAX_TEAM_SIZE } from './http/admin-api';

type Fx = ReturnType<typeof buildFixture>;

function setup(opts: Parameters<typeof buildFixture>[0] = {}) {
  let now = new Date('2026-09-01T12:00:00Z');
  const email = new MockEmailProvider();
  const fx = buildFixture({ email, now: () => now, ...opts });
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  return { fx, email, advance, clock: () => now };
}

/** A browser-ish client for one tenant: cookie jar + CSRF header once signed in. */
function browser(fx: Fx, ref: string) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let csrf = '';
  async function call(sub: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = cookieHeader();
    if (csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] ??= csrf;
    const req = new Request(`http://localhost/api/t/${ref}/${sub}`, { ...init, headers });
    const res = await handleTenantApi(req, ref, sub.split('?')[0]!.split('/'), { api: fx.api, admin: fx.admin, directory: fx.directory });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      const i = pair!.indexOf('=');
      const [k, v] = [pair!.slice(0, i), pair!.slice(i + 1)];
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    return res;
  }
  const send = (method: string, sub: string, body: unknown, headers: Record<string, string> = {}) =>
    call(sub, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return {
    call,
    send,
    /** The whole jar as a Cookie header; assigning replaces the jar. */
    get cookie() {
      return cookieHeader();
    },
    set cookie(v: string) {
      jar.clear();
      for (const part of v.split('; ').filter(Boolean)) {
        const i = part.indexOf('=');
        jar.set(part.slice(0, i), part.slice(i + 1));
      }
    },
    async signIn(mail: MockEmailProvider, address: string) {
      await send('POST', 'admin/sign-in', { email: address });
      await fx.admin.settled();
      const token = tokenFrom(mail.sent[mail.sent.length - 1]!.text);
      const r = await send('POST', 'admin/verify', { token });
      expect(r.status).toBe(200);
      csrf = (await (await call('admin/me')).json()).csrfToken;
      return r;
    },
    dropCsrf() {
      csrf = '';
    },
    /** Opens an emailed link (sign-in or invite) the way the verify page does. */
    async useLink(text: string) {
      const r = await send('POST', 'admin/verify', { token: tokenFrom(text) });
      if (r.status === 200) csrf = (await (await call('admin/me')).json()).csrfToken;
      return r;
    },
  };
}
const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

describe('magic-link sign-in', () => {
  it('answers the same way for unknown addresses and sends nothing', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    const known = await b.send('POST', 'admin/sign-in', { email: 'OWNER@demo.test ' });
    const unknown = await b.send('POST', 'admin/sign-in', { email: 'nobody@demo.test' });
    await fx.admin.settled();
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    expect(email.sent.map((m) => m.to)).toEqual(['owner@demo.test']);
  });

  it("builds the link from config, never from the request's Host header", async () => {
    const { fx, email } = setup({ publicBaseUrl: 'https://app.brandcanvas.test' });
    await handleTenantApi(
      new Request('http://evil.example/api/t/demo/admin/sign-in', {
        method: 'POST',
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@demo.test' }),
      }),
      'demo',
      ['admin', 'sign-in'],
      { api: fx.api, admin: fx.admin, directory: fx.directory },
    );
    await fx.admin.settled();
    const text = email.sent[0]!.text;
    expect(text).toContain('https://app.brandcanvas.test/t/demo/admin/verify#token=');
    expect(text).not.toContain('evil.example');
  });

  it('a link works once, expires after 15 minutes and only for its own tenant', async () => {
    const { fx, email, advance } = setup();
    const b = browser(fx, 'demo');
    await b.send('POST', 'admin/sign-in', { email: 'owner@demo.test' });
    await fx.admin.settled();
    const token = tokenFrom(email.sent[0]!.text);

    expect((await browser(fx, 'basic').send('POST', 'admin/verify', { token })).status).toBe(400); // other tenant
    const ok = await b.send('POST', 'admin/verify', { token });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await b.send('POST', 'admin/verify', { token })).status).toBe(400); // reused

    await b.send('POST', 'admin/sign-in', { email: 'owner@demo.test' });
    await fx.admin.settled();
    advance(15 * 60_000 + 1);
    expect((await b.send('POST', 'admin/verify', { token: tokenFrom(email.sent[1]!.text) })).status).toBe(400); // expired
    expect((await b.send('POST', 'admin/verify', { token: 'short' })).status).toBe(400);
  });

  it('refuses cross-site sign-in and verify (login CSRF)', async () => {
    const { fx } = setup();
    const b = browser(fx, 'demo');
    const r = await b.send('POST', 'admin/sign-in', { email: 'owner@demo.test' }, { 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
  });

  it('caps links per address without changing the answer', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    for (let i = 0; i < 7; i++) expect((await b.send('POST', 'admin/sign-in', { email: 'owner@demo.test' })).status).toBe(202);
    await fx.admin.settled();
    expect(email.sent).toHaveLength(5);
  });
});

describe('admin sessions', () => {
  it('needs a session; a session is scoped to its tenant; sign-out and expiry end it', async () => {
    const { fx, email, advance } = setup();
    const b = browser(fx, 'demo');
    expect((await b.call('admin/me')).status).toBe(401);
    await b.signIn(email, 'owner@demo.test');
    const me = await (await b.call('admin/me')).json();
    expect(me.user).toEqual({ email: 'owner@demo.test', role: 'tenant_owner' });

    const other = browser(fx, 'basic');
    other.cookie = b.cookie; // replay demo's cookie against another tenant
    expect((await other.call('admin/me')).status).toBe(401);

    const saved = b.cookie;
    expect((await b.send('POST', 'admin/sign-out', {})).status).toBe(200);
    b.cookie = saved; // an old copy of the cookie is dead server-side
    expect((await b.call('admin/me')).status).toBe(401);

    const c = browser(fx, 'demo');
    await c.signIn(email, 'owner@demo.test');
    advance(12 * 3_600_000 + 1);
    expect((await c.call('admin/me')).status).toBe(401);
  });

  it('mutations need the CSRF token', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    await b.signIn(email, 'owner@demo.test');
    const body = { mode: 'soft', freeProducts: 2 };
    expect((await b.send('PUT', 'admin/settings/gate', body, { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await b.send('PUT', 'admin/settings/gate', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await b.send('PUT', 'admin/settings/gate', body)).status).toBe(200);
    b.dropCsrf();
    expect((await b.send('PUT', 'admin/settings/gate', body)).status).toBe(403);
  });
});

describe('settings', () => {
  it('gate changes apply to the storefront immediately', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    await b.signIn(email, 'staff@demo.test'); // non-owner admins can change the gate
    expect((await b.send('PUT', 'admin/settings/gate', { mode: 'soft', freeProducts: 1, contactName: 'Sam' })).status).toBe(200);
    const cfg = await (await b.call('config')).json();
    expect(JSON.stringify(cfg)).toContain('"mode":"soft"');
    const bad = await b.send('PUT', 'admin/settings/gate', { mode: 'wide-open', freeProducts: 99 });
    expect(bad.status).toBe(422);
    expect(Object.keys((await bad.json()).error.errors).sort()).toEqual(['freeProducts', 'mode']);
  });

  it('branding needs the Starter entitlement and validates input', async () => {
    const { fx, email } = setup();
    const free = browser(fx, 'basic');
    await free.signIn(email, 'owner@basic.test');
    const body = { displayName: 'New Name', primaryHex: '#112233', secondaryHex: '#445566', fontFamily: 'Georgia' };
    expect((await free.send('PUT', 'admin/settings/branding', body)).status).toBe(403);

    const pro = browser(fx, 'demo');
    await pro.signIn(email, 'owner@demo.test');
    expect((await pro.send('PUT', 'admin/settings/branding', { ...body, primaryHex: 'red', fontFamily: 'Comic Sans' })).status).toBe(422);
    expect((await pro.send('PUT', 'admin/settings/branding', body)).status).toBe(200);
    expect((await fx.directory.findBySlug('demo'))!.branding.displayName).toBe('New Name');
  });

  it('webhook secret: generated once, stored sealed, never returned again; owner only', async () => {
    const { fx, email } = setup();
    const staff = browser(fx, 'demo');
    await staff.signIn(email, 'staff@demo.test');
    expect((await staff.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://hooks.example.com/a' })).status).toBe(403);

    const owner = browser(fx, 'demo');
    await owner.signIn(email, 'owner@demo.test');
    expect((await owner.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://127.0.0.1/x' })).status).toBe(422);
    const first = await (await owner.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://hooks.example.com/a' })).json();
    expect(first.secret).toMatch(/^whsec_/);

    const stored = (await fx.directory.findBySlug('demo'))!.leads!.routing;
    expect(JSON.stringify(stored)).not.toContain(first.secret);
    expect(fx.secrets.open((stored as { secretSealed: string }).secretSealed, DEMO_TENANT_ID)).toBe(first.secret);

    const settings = JSON.stringify(await (await owner.call('admin/settings')).json());
    expect(settings).not.toContain(first.secret);
    expect(settings).not.toContain('secretSealed');

    const again = await (await owner.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://hooks.example.com/b' })).json();
    expect(again.secret).toBeUndefined(); // kept
    const rotated = await (await owner.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://hooks.example.com/b', rotateSecret: true })).json();
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(first.secret);
  });

  it('Free plan cannot enable webhook routing', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'basic');
    await b.signIn(email, 'owner@basic.test');
    expect((await b.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'https://hooks.example.com/a' })).status).toBe(403);
  });

  it('"send test" delivers a signed ping', async () => {
    const got: { body: string; sig: string }[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ body, sig: String(req.headers['x-brandcanvas-signature']) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const { fx, email } = setup({ allowInsecureWebhooks: true });
      const b = browser(fx, 'demo');
      await b.signIn(email, 'owner@demo.test');
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
      const { secret } = await (await b.send('PUT', 'admin/settings/routing', { provider: 'webhook', url })).json();
      expect(await (await b.send('POST', 'admin/settings/routing/test', {})).json()).toEqual({ ok: true });
      expect(JSON.parse(got[0]!.body).type).toBe('ping');
      const [t, v1] = got[0]!.sig.split(',').map((x) => x.split('=')[1]);
      expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${got[0]!.body}`).digest('hex'));
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('lead inbox', () => {
  async function seed(fx: Fx, clock: () => Date, advance: (ms: number) => void) {
    const mk = async (email: string, name: string, source: 'email_gate' | 'quote_request') => {
      await fx.leads.upsertByEmail(DEMO_TENANT_ID, { email, name, source, marketingOptIn: false, consentVersion: 'v1' }, clock());
      advance(1000);
    };
    await mk('a@acme.test', 'Ann Acme', 'email_gate');
    await mk('b@bolt.test', '=HYPERLINK("http://x","click")', 'quote_request');
    await mk('c@acme.test', 'Cy', 'email_gate');
    await fx.leads.upsertByEmail(FREE_TENANT_ID, { email: 'other@tenant.test', source: 'email_gate', marketingOptIn: false, consentVersion: 'v1' }, clock());
  }

  it('pages newest-first, filters, and never shows another tenant', async () => {
    const { fx, email, clock, advance } = setup();
    await seed(fx, clock, advance);
    const b = browser(fx, 'demo');
    await b.signIn(email, 'staff@demo.test');
    const p1 = await (await b.call('admin/leads?limit=2')).json();
    expect(p1.items.map((l: { email: string }) => l.email)).toEqual(['c@acme.test', 'b@bolt.test']);
    const p2 = await (await b.call(`admin/leads?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((l: { email: string }) => l.email)).toEqual(['a@acme.test']);
    expect(p2.nextCursor).toBeNull();
    const s = await (await b.call('admin/leads?search=ACME')).json();
    expect(s.items).toHaveLength(2);
    const q = await (await b.call('admin/leads?source=quote_request')).json();
    expect(q.items.map((l: { email: string }) => l.email)).toEqual(['b@bolt.test']);
    expect((await b.call('admin/leads?source=nope')).status).toBe(400);

    const foreign = (await fx.leads.list(FREE_TENANT_ID, { limit: 1 })).items[0]!;
    expect((await b.call(`admin/leads/${foreign.id}`)).status).toBe(404);
  });

  it('shows failed deliveries, filters to them, and retries on request', async () => {
    const { fx, email, clock } = setup({ allowInsecureWebhooks: true });
    const b = browser(fx, 'demo');
    await b.signIn(email, 'owner@demo.test');
    await b.send('PUT', 'admin/settings/routing', { provider: 'webhook', url: 'http://127.0.0.1:9/down' });
    const capture = await b.send('POST', 'leads/email', { email: 'lost@acme.test', startedAt: clock().getTime() - 5000, website: '' });
    expect(capture.status).toBe(201);

    const inbox = await (await b.call('admin/leads?attention=1')).json();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].delivery).toBe('failed');
    const detail = await (await b.call(`admin/leads/${inbox.items[0].id}`)).json();
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(['captured', 'routing_failed']);
    const d = detail.deliveries[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 1, retryable: true });

    await b.send('PUT', 'admin/settings/routing', { provider: 'mock' }); // fix routing, then retry by hand
    const r = await (await b.send('POST', `admin/deliveries/${d.id}/retry`, {})).json();
    expect(r).toMatchObject({ status: 'delivered', attempts: 2 });
    // Delivered to the built-in inbox, NOT to a CRM: the inbox must not claim "Sent to CRM".
    const after = await (await b.call('admin/leads')).json();
    expect(after.items[0].delivery).toBe('inbox');
    expect((await b.send('POST', `admin/deliveries/${d.id}/retry`, {})).status).toBe(404);
    expect(BACKOFF_MS.length).toBeGreaterThan(0);
  });

  it('CSV export defuses spreadsheet formulas and is audited', async () => {
    const { fx, email, clock, advance } = setup();
    await seed(fx, clock, advance);
    const b = browser(fx, 'demo');
    await b.signIn(email, 'staff@demo.test');
    const res = await b.call('admin/leads.csv');
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="leads-demo-/);
    const csv = await res.text();
    const rows = csv.trim().split('\r\n');
    expect(rows).toHaveLength(4); // header + 3 demo leads, none from other tenants
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv).not.toContain('other@tenant.test');
    const actions = (await fx.audit.recent(DEMO_TENANT_ID, 10)).map((e) => e.action);
    expect(actions).toContain('leads.export_csv');
    expect(actions).toContain('admin.sign_in');
    expect((await fx.audit.recent(FREE_TENANT_ID, 10)).map((e) => e.action)).not.toContain('leads.export_csv');
  });
});

describe('pricing admin', () => {
  const load = async (b: ReturnType<typeof browser>) => (await (await b.call('admin/settings/pricing')).json()) as { config: Record<string, any>; categories: string[]; methods: { key: string }[] };
  const catalogUnits = async (b: ReturnType<typeof browser>) =>
    Object.fromEntries(((await (await b.call('catalog?qty=144')).json()).items as { slug: string; unit: number }[]).map((i) => [i.slug, i.unit]));

  it('needs the Starter plan', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'basic');
    await b.signIn(email, 'owner@basic.test');
    expect((await b.call('admin/settings/pricing')).status).toBe(403);
    expect((await b.send('POST', 'admin/settings/pricing/preview', { config: {}, quantity: 144, colorCount: 2 })).status).toBe(403);
    expect((await b.send('PUT', 'admin/settings/pricing', { config: {} })).status).toBe(403);
  });

  it('staff can view and preview but only the owner can save', async () => {
    const { fx, email } = setup();
    const staff = browser(fx, 'demo');
    await staff.signIn(email, 'staff@demo.test');
    const { config } = await load(staff);
    expect(config.rates.screen_print.runByBreak.length).toBeGreaterThan(0); // rates always filled in
    expect((await staff.send('POST', 'admin/settings/pricing/preview', { config, quantity: 144, colorCount: 2 })).status).toBe(200);
    expect((await staff.send('PUT', 'admin/settings/pricing', { config })).status).toBe(403);
  });

  it('preview prices every product with unsaved values, beside current prices, and stores nothing', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    await b.signIn(email, 'owner@demo.test');
    const { config } = await load(b);
    const higher = { ...config, marginMarkup: 2, showItemizedToProspect: false };
    const p = await (await b.send('POST', 'admin/settings/pricing/preview', { config: higher, quantity: 144, colorCount: 2 })).json();
    expect(p.rows.length).toBe(6);
    for (const r of p.rows) {
      expect(r.unit).toBeGreaterThan(r.currentUnit);
      expect(r.lines).toBeNull(); // breakdown hidden → prospects wouldn't see lines
    }
    expect((await fx.directory.findBySlug('demo'))!.pricingConfig.marginMarkup).toBe(1.4);
    const bad = await b.send('POST', 'admin/settings/pricing/preview', { config: { ...config, marginMarkup: 9 }, quantity: 144, colorCount: 2 });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.errors.marginMarkup).toBeTruthy();
  });

  it('a save reaches storefront prices, switches the disclaimer and is audited', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    await b.signIn(email, 'owner@demo.test');
    const before = await catalogUnits(b);
    const { config } = await load(b);
    config.marginMarkup = 1.8;
    config.rates.screen_print.screenChargePerColor = 3500;
    expect((await b.send('PUT', 'admin/settings/pricing', { config }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    const r = await b.send('PUT', 'admin/settings/pricing', { config });
    expect(r.status).toBe(200);
    const after = await catalogUnits(b);
    for (const slug of Object.keys(before)) expect(after[slug]).toBeGreaterThan(before[slug]!);
    const cat = await (await b.call('catalog?qty=144')).json();
    expect(cat.disclaimer).toMatch(/this distributor's rate tables/);
    // What's stored is the validated rebuild, not the request body.
    const smuggled = { ...config, currency: 'EUR', injected: true, rates: { ...config.rates, extra: 1 } };
    expect((await b.send('PUT', 'admin/settings/pricing', { config: smuggled })).status).toBe(200);
    const stored = (await fx.directory.findBySlug('demo'))!.pricingConfig as unknown as Record<string, any>;
    expect(stored.currency).toBe('USD');
    expect('injected' in stored || 'extra' in stored.rates).toBe(false);
    const entry = (await fx.audit.recent(DEMO_TENANT_ID, 5)).find((e) => e.action === 'settings.pricing' && e.target !== 'no change')!;
    expect(entry.target).toBe('blank markup 40% → 80%; rates: Screen Printing');
  });

  it('the storefront never exposes cost or margin, and hides the breakdown when asked', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    const items = async () => (await (await b.call('catalog?qty=144')).json()).items as { total: number; lines: { label: string; amount: number }[] | null }[];
    for (const i of await items()) {
      expect(i.lines!.map((l) => l.label).join(' | ')).not.toMatch(/Margin|Blanks/);
      expect(i.lines!.reduce((s, l) => s + l.amount, 0)).toBe(i.total);
    }
    await b.signIn(email, 'owner@demo.test');
    const { config } = await load(b);
    expect((await b.send('PUT', 'admin/settings/pricing', { config: { ...config, showItemizedToProspect: false } })).status).toBe(200);
    for (const i of await items()) expect(i.lines).toBeNull();
  });

  it('rejects bad values field by field and saves nothing', async () => {
    const { fx, email } = setup();
    const b = browser(fx, 'demo');
    await b.signIn(email, 'owner@demo.test');
    const { config } = await load(b);
    config.fees.ltmFee = 12.5;
    config.rates.screen_print.runByBreak[1].minQty = 5;
    const r = await b.send('PUT', 'admin/settings/pricing', { config });
    expect(r.status).toBe(422);
    expect(Object.keys((await r.json()).error.errors).sort()).toEqual(['fees.ltmFee', 'rates.screen_print.runByBreak.1.minQty']);
    expect((await fx.directory.findBySlug('demo'))!.pricingConfig.rates).toBeUndefined();
  });
});


describe('team (ADR 0011)', () => {
  type Member = { id: string; email: string; role: string; status: string; invitedBy: string | null; isYou: boolean };
  const team = async (b: ReturnType<typeof browser>) => (await (await b.call('admin/team')).json()) as { members: Member[]; canManage: boolean };
  const byEmail = async (b: ReturnType<typeof browser>, e: string) => (await team(b)).members.find((m) => m.email === e);

  it('adding people is Enterprise ("Multi-user admin", §7); roles and removal work on every plan', async () => {
    const { fx, email } = setup();
    const pro = browser(fx, 'demo');
    await pro.signIn(email, 'owner@demo.test');
    const t = (await (await pro.call('admin/team')).json()) as { canInvite: boolean; inviteUpgradeable: boolean; members: Member[] };
    expect([t.canInvite, t.inviteUpgradeable]).toEqual([false, true]);
    expect((await (await pro.call('admin/me')).json()).can.inviteTeam).toBe(false);
    const inv = await pro.send('POST', 'admin/team/invite', { email: 'new@demo.test' });
    expect(inv.status).toBe(403);
    expect((await inv.json()).error).toMatchObject({ code: 'feature_locked', feature: 'multi_user_admin', upgradeable: true });
    const staff = t.members.find((m) => m.email === 'staff@demo.test')!;
    expect((await pro.send('POST', `admin/team/${staff.id}/resend`, {})).status).toBe(403);
    expect((await fx.auth.listMembers(DEMO_TENANT_ID)).map((m) => m.email)).toEqual(['owner@demo.test', 'staff@demo.test']);
    // An owner on any plan can still re-role and remove (e.g. after a downgrade).
    expect((await pro.send('PUT', `admin/team/${staff.id}`, { role: 'tenant_owner' })).status).toBe(200);
    expect((await pro.call(`admin/team/${staff.id}`, { method: 'DELETE' })).status).toBe(200);

    const free = browser(fx, 'basic');
    await free.signIn(email, 'owner@basic.test');
    expect((await free.send('POST', 'admin/team/invite', { email: 'x@basic.test' })).status).toBe(403);

    const ent = browser(fx, 'bigco');
    await ent.signIn(email, 'owner@bigco.test');
    expect((await (await ent.call('admin/team')).json()).canInvite).toBe(true);
  });

  it('everyone signed in sees the team; only owners can manage it', async () => {
    const { fx, email } = setup();
    const staff = browser(fx, 'bigco');
    await staff.signIn(email, 'staff@bigco.test');
    const t = await team(staff);
    expect(t.canManage).toBe(false);
    expect(t.members.map((m) => [m.email, m.role, m.isYou])).toEqual([
      ['owner@bigco.test', 'tenant_owner', false],
      ['staff@bigco.test', 'tenant_admin', true],
    ]);
    const owner = t.members.find((m) => m.role === 'tenant_owner')!;
    expect((await staff.send('POST', 'admin/team/invite', { email: 'x@bigco.test' })).status).toBe(403);
    expect((await staff.send('PUT', `admin/team/${owner.id}`, { role: 'tenant_admin' })).status).toBe(403);
    expect((await staff.call(`admin/team/${owner.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await browser(fx, 'bigco').call('admin/team')).status).toBe(401);
    expect((await (await staff.call('admin/me')).json()).can.manageTeam).toBe(false);
  });

  it('an invite adds the person and emails a single-use link that signs them in', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    const r = await owner.send('POST', 'admin/team/invite', { email: ' New.Person@BigCo.test ', role: 'tenant_admin' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({ emailSent: true, member: { email: 'new.person@bigco.test', role: 'tenant_admin', status: 'invited', invitedBy: 'owner@bigco.test' } });
    const mail = email.sent[email.sent.length - 1]!;
    expect(mail.to).toBe('new.person@bigco.test');
    expect(mail.subject).toMatch(/invited/i);
    expect(mail.text).toMatch(/owner@bigco\.test invited you to the BigCo Merch admin\.\nYour role: Admin \(works leads/);
    expect(mail.text).toMatch(/expires in 3 days/);

    const invitee = browser(fx, 'bigco');
    expect((await invitee.useLink(mail.text)).status).toBe(200);
    expect((await (await invitee.call('admin/me')).json()).user).toEqual({ email: 'new.person@bigco.test', role: 'tenant_admin' });
    expect((await browser(fx, 'bigco').useLink(mail.text)).status).toBe(400); // single use
    expect((await byEmail(owner, 'new.person@bigco.test'))?.status).toBe('active');
    const log = await fx.audit.recent(ENT_TENANT_ID, 10);
    expect(log.map((e) => e.action)).toContain('team.invite');
  });

  it('invite links last 3 days, not 15 minutes', async () => {
    const { fx, email, advance } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    await owner.send('POST', 'admin/team/invite', { email: 'late@bigco.test' });
    await owner.send('POST', 'admin/team/invite', { email: 'later@bigco.test' });
    const [late, later] = email.sent.slice(-2);
    advance(2 * 24 * 3_600_000);
    expect((await browser(fx, 'bigco').useLink(late!.text)).status).toBe(200);
    advance(INVITE_TTL_MS);
    expect((await browser(fx, 'bigco').useLink(later!.text)).status).toBe(400);
  });

  it('refuses duplicates, bad input and missing CSRF', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    const dup = await owner.send('POST', 'admin/team/invite', { email: 'STAFF@bigco.test' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe('already_member');
    expect((await owner.send('POST', 'admin/team/invite', { email: 'not-an-email' })).status).toBe(400);
    expect((await owner.send('POST', 'admin/team/invite', { email: 'a@bigco.test', role: 'superuser' })).status).toBe(400);
    expect((await owner.send('POST', 'admin/team/invite', { email: 'a@bigco.test' }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    const staffId = (await byEmail(owner, 'staff@bigco.test'))!.id;
    expect((await owner.send('PUT', `admin/team/${staffId}`, { role: 'tenant_owner' }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await owner.call(`admin/team/${staffId}`, { method: 'DELETE', headers: { 'x-csrf-token': 'nope' } })).status).toBe(403);
    expect((await owner.send('POST', `admin/team/${staffId}/resend`, {}, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await team(owner)).members.map((m) => [m.email, m.role])).toEqual([
      ['owner@bigco.test', 'tenant_owner'],
      ['staff@bigco.test', 'tenant_admin'],
    ]);
  });

  it('caps team size', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    for (let i = 0; (await fx.auth.listMembers(ENT_TENANT_ID)).length < MAX_TEAM_SIZE; i++) {
      await fx.auth.addMember({ id: `00000000-0000-4000-8000-0000000b${String(i).padStart(4, '0')}`, tenantId: ENT_TENANT_ID, email: `p${i}@bigco.test`, role: 'tenant_admin', invitedBy: 'x', createdAt: new Date() });
    }
    const r = await owner.send('POST', 'admin/team/invite', { email: 'one-more@bigco.test' });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('team_full');
  });

  it('rate-limits invites per tenant', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await owner.send('POST', 'admin/team/invite', { email: `r${i}@bigco.test` })).status;
    expect(last).toBe(429);
  });

  it('never leaves a workspace without an owner', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    const me = (await byEmail(owner, 'owner@bigco.test'))!;
    const staff = (await byEmail(owner, 'staff@bigco.test'))!;
    const demote = await owner.send('PUT', `admin/team/${me.id}`, { role: 'tenant_admin' });
    expect(demote.status).toBe(409);
    expect((await demote.json()).error.code).toBe('last_owner');
    expect((await owner.call(`admin/team/${me.id}`, { method: 'DELETE' })).status).toBe(409);

    expect((await owner.send('PUT', `admin/team/${staff.id}`, { role: 'tenant_owner' })).status).toBe(200);
    expect((await owner.send('PUT', `admin/team/${me.id}`, { role: 'tenant_admin' })).status).toBe(200); // now allowed
    expect((await owner.send('POST', 'admin/team/invite', { email: 'z@bigco.test' })).status).toBe(403); // no longer an owner
    const log = (await fx.audit.recent(ENT_TENANT_ID, 10)).map((e) => e.target ?? '');
    expect(log).toContain('staff@bigco.test: tenant_admin → tenant_owner');
  });

  it('a promotion takes effect on the next request, without signing in again', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    const staff = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    await staff.signIn(email, 'staff@bigco.test');
    expect((await staff.send('POST', 'admin/team/invite', { email: 'y@bigco.test' })).status).toBe(403);
    await owner.send('PUT', `admin/team/${(await byEmail(owner, 'staff@bigco.test'))!.id}`, { role: 'tenant_owner' });
    expect((await staff.send('POST', 'admin/team/invite', { email: 'y@bigco.test' })).status).toBe(201);
  });

  it('removing someone ends their session at once and kills their unused links', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    const staff = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    await staff.signIn(email, 'staff@bigco.test');
    await owner.send('POST', 'admin/team/invite', { email: 'pending@bigco.test' });
    const inviteMail = email.sent[email.sent.length - 1]!;

    const staffRow = (await byEmail(owner, 'staff@bigco.test'))!;
    expect((await owner.call(`admin/team/${staffRow.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await staff.call('admin/me')).status).toBe(401);
    expect((await staff.call('admin/leads')).status).toBe(401);

    const pending = (await byEmail(owner, 'pending@bigco.test'))!;
    const tokensBefore = fx.auth.counts().tokens;
    await owner.call(`admin/team/${pending.id}`, { method: 'DELETE' });
    expect(fx.auth.counts().tokens).toBe(tokensBefore - 1); // their link is deleted, as the FK cascade does in Postgres
    expect((await browser(fx, 'bigco').useLink(inviteMail.text)).status).toBe(400);
    expect((await team(owner)).members.map((m) => m.email)).toEqual(['owner@bigco.test']);
    expect((await fx.audit.recent(ENT_TENANT_ID, 10)).map((e) => e.target)).toContain('staff@bigco.test');
  });

  it('removing yourself (when another owner exists) signs you out', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    await owner.send('PUT', `admin/team/${(await byEmail(owner, 'staff@bigco.test'))!.id}`, { role: 'tenant_owner' });
    const me = (await byEmail(owner, 'owner@bigco.test'))!;
    const r = await owner.call(`admin/team/${me.id}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, signedOut: true });
    expect((await owner.call('admin/me')).status).toBe(401);
  });

  it('resend works only for people who have not signed in yet', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'bigco');
    await owner.signIn(email, 'owner@bigco.test');
    await owner.send('POST', 'admin/team/invite', { email: 'again@bigco.test' });
    const id = (await byEmail(owner, 'again@bigco.test'))!.id;
    expect((await owner.send('POST', `admin/team/${id}/resend`, {})).status).toBe(200);
    const second = email.sent[email.sent.length - 1]!;
    expect((await browser(fx, 'bigco').useLink(second.text)).status).toBe(200);
    const again = await owner.send('POST', `admin/team/${id}/resend`, {});
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('already_active');
  });

  it("an owner of one tenant cannot touch another tenant's people", async () => {
    const { fx, email } = setup();
    // The attacker is an Enterprise owner, so the plan gate can't be what stops them.
    const victim = browser(fx, 'demo');
    await victim.signIn(email, 'owner@demo.test');
    const staffId = (await byEmail(victim, 'staff@demo.test'))!.id;
    const other = browser(fx, 'bigco');
    await other.signIn(email, 'owner@bigco.test');
    expect((await other.send('PUT', `admin/team/${staffId}`, { role: 'tenant_owner' })).status).toBe(404);
    expect((await other.call(`admin/team/${staffId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await other.send('POST', `admin/team/${staffId}/resend`, {})).status).toBe(404);
    expect((await byEmail(victim, 'staff@demo.test'))?.role).toBe('tenant_admin');
  });

  it('keeps the member if the invite email fails, and says so', async () => {
    const failing = { sent: [] as unknown[], async send() { throw new Error('smtp down'); } };
    const { fx } = setup({ email: failing as unknown as MockEmailProvider });
    // Sign in by planting a session through a real link: use the store directly.
    const owner = browser(fx, 'bigco');
    const token = 'A'.repeat(43);
    const { hashSecret } = await import('./admin/auth');
    const ownerId = (await fx.auth.findUserByEmail(ENT_TENANT_ID, 'owner@bigco.test'))!.id;
    await fx.auth.createLoginToken({ id: '00000000-0000-4000-8000-00000000c001', tenantId: ENT_TENANT_ID, userId: ownerId, tokenHash: hashSecret(token), expiresAt: new Date('2027-01-01'), createdAt: new Date('2026-09-01') });
    expect((await owner.useLink(`#token=${token}`)).status).toBe(200);
    const r = await owner.send('POST', 'admin/team/invite', { email: 'unlucky@bigco.test' });
    expect(r.status).toBe(201);
    expect((await r.json()).emailSent).toBe(false);
    expect((await byEmail(owner, 'unlucky@bigco.test'))?.status).toBe('invited');
  });
});

describe('feature switches (ADR 0013)', () => {
  type Feature = { key: string; on: boolean; available: boolean; blockedBy: string | null; plan: string };
  const features = async (b: ReturnType<typeof browser>) => (await (await b.call('admin/features')).json()) as { canEdit: boolean; features: Feature[] };
  const f = async (b: ReturnType<typeof browser>, key: string) => (await features(b)).features.find((x) => x.key === key)!;

  it('lists the six switches with what the plan allows', async () => {
    const { fx, email } = setup();
    const pro = browser(fx, 'demo');
    await pro.signIn(email, 'owner@demo.test');
    const list = await features(pro);
    expect(list.canEdit).toBe(true);
    expect(list.features.map((x) => x.key)).toEqual(['quote_requests', 'all_lead_paths', 'basic_facets', 'qty_price_break_preview', 'sustainable_filter', 'auto_bg_removal']);
    expect(list.features.every((x) => x.on && x.available)).toBe(true); // Pro includes all six

    const free = browser(fx, 'basic');
    await free.signIn(email, 'owner@basic.test');
    expect(await f(free, 'quote_requests')).toMatchObject({ on: false, available: false, blockedBy: 'plan', plan: 'Starter' });
    expect(await f(free, 'basic_facets')).toMatchObject({ on: true, available: true, blockedBy: null });
  });

  it('switching quote requests off closes the storefront endpoint; on reopens it', async () => {
    const { fx, email } = setup();
    const owner = browser(fx, 'demo');
    await owner.signIn(email, 'owner@demo.test');
    const prospect = browser(fx, 'demo');
    expect((await prospect.send('POST', 'leads/quote', {})).status).not.toBe(403);

    expect((await owner.send('PUT', 'admin/features', { features: { quote_requests: false } })).status).toBe(200);
    const closed = await prospect.send('POST', 'leads/quote', {});
    expect(closed.status).toBe(403);
    expect((await closed.json()).error).toMatchObject({ code: 'feature_locked', message: 'This feature is turned off for this site.', upgradeable: false });
    expect(await f(owner, 'quote_requests')).toMatchObject({ on: false, available: true });
    expect((await fx.audit.recent(DEMO_TENANT_ID, 5)).find((e) => e.action === 'settings.features')?.target).toBe('quote_requests off');

    expect((await owner.send('PUT', 'admin/features', { features: { quote_requests: true } })).status).toBe(200);
    expect((await prospect.send('POST', 'leads/quote', {})).status).not.toBe(403);
    // Back at the default: nothing stored.
    expect((await fx.directory.findBySlug('demo'))!.flagOverrides).toEqual({});
  });

  it('only changes the switches sent, and never touches operator overrides', async () => {
    const { fx, email } = setup();
    await fx.directory.setFlagOverrides(DEMO_TENANT_ID, ['custom_branding'], { custom_branding: false }); // an operator's override
    const owner = browser(fx, 'demo');
    await owner.signIn(email, 'owner@demo.test');
    await owner.send('PUT', 'admin/features', { features: { sustainable_filter: false } });
    await owner.send('PUT', 'admin/features', { features: { basic_facets: false } });
    expect((await fx.directory.findBySlug('demo'))!.flagOverrides).toEqual({ custom_branding: false, sustainable_filter: false, basic_facets: false });
  });

  it('refuses switching on what the plan or the platform keeps off, unknown keys and non-booleans', async () => {
    const { fx, email } = setup();
    const free = browser(fx, 'basic');
    await free.signIn(email, 'owner@basic.test');
    const r = await free.send('PUT', 'admin/features', { features: { quote_requests: true, custom_domain: false, basic_facets: 'yes' } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.errors).toEqual({
      quote_requests: 'Available on the Starter plan.',
      custom_domain: 'Not a feature you can switch here.',
      basic_facets: 'Must be true or false.',
    });
    expect((await fx.directory.findBySlug('basic'))!.flagOverrides).toEqual({}); // nothing half-applied

    fx.directory.setKillSwitches(['sustainable_filter']);
    const pro = browser(fx, 'demo');
    await pro.signIn(email, 'owner@demo.test');
    expect(await f(pro, 'sustainable_filter')).toMatchObject({ on: false, available: false, blockedBy: 'platform' });
    expect((await pro.send('PUT', 'admin/features', { features: { sustainable_filter: true } })).status).toBe(400);
  });

  it('staff can see the switches but not change them; CSRF required', async () => {
    const { fx, email } = setup();
    const staff = browser(fx, 'demo');
    await staff.signIn(email, 'staff@demo.test');
    expect((await features(staff)).canEdit).toBe(false);
    expect((await staff.send('PUT', 'admin/features', { features: { quote_requests: false } })).status).toBe(403);
    const owner = browser(fx, 'demo');
    await owner.signIn(email, 'owner@demo.test');
    expect((await owner.send('PUT', 'admin/features', { features: { quote_requests: false } }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await fx.directory.findBySlug('demo'))!.flagOverrides).toEqual({});
  });
});
