import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import {
  lockedProducts,
  looksAutomated,
  normalizeEmail,
  proofAllowed,
  validateEmailGate,
  validateQuote,
  type GateState,
} from '@/features/leads/rules';
import { signSessionId, verifySessionCookie, MemorySessionStore, loadOrCreateSession } from './session';
import { WebhookCrmProvider, webhookUrlProblem } from '@/shared/providers/webhook-crm';
import { handleTenantApi } from './http/router';
import { buildFixture, fixtureTenants, FREE_TENANT_ID } from './testing';
import { devSecretBox } from './crypto/secret-box';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { searchCatalog } from '@/features/catalog/catalog';
import { DEMO_CATALOG } from '@/core/domain/demo-catalog';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';

/* ------------------------------ rules ------------------------------ */

describe('lead rules', () => {
  it('normalises emails to one canonical lower-case form and rejects junk', () => {
    expect(normalizeEmail('  Pat.Lee@Example.COM ')).toBe('pat.lee@example.com');
    for (const bad of ['', 'no-at', 'a@b', 'a@@b.com', 'a b@c.com', `${'x'.repeat(250)}@a.com`, 42]) expect(normalizeEmail(bad)).toBeNull();
  });

  it('only an explicit boolean true is marketing consent', () => {
    for (const v of ['true', 'on', 1, undefined]) {
      const r = validateEmailGate({ email: 'a@b.co', marketingOptIn: v });
      expect(r.ok && r.value.marketingOptIn).toBe(false);
    }
    const yes = validateEmailGate({ email: 'a@b.co', marketingOptIn: true });
    expect(yes.ok && yes.value.marketingOptIn).toBe(true);
  });

  it('validates quote forms field by field', () => {
    const r = validateQuote({ email: 'x', name: '', phone: 'call me', quantity: 0, product: 'p' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['color', 'email', 'location', 'method', 'name', 'phone', 'quantity']);
  });

  it('screens bots by honeypot and fill time', () => {
    const now = 1_000_000;
    expect(looksAutomated({ honeypot: '', startedAt: now - 5000 }, now)).toBe(false);
    expect(looksAutomated({ honeypot: 'spam.example', startedAt: now - 5000 }, now)).toBe(true);
    expect(looksAutomated({ honeypot: '', startedAt: now - 200 }, now)).toBe(true); // too fast
    expect(looksAutomated({ honeypot: '' }, now)).toBe(true); // no timing
  });

  it('proofAllowed and lockedProducts agree for every prefix of a browsing session', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const g: GateState = { mode: 'hard', freeProducts: 2, hasLead: false, seenProducts: [] };
    const locked = lockedProducts(g, order);
    const seen: string[] = [];
    for (const p of order) {
      const allowed = proofAllowed({ ...g, seenProducts: seen }, p);
      expect(allowed).toBe(!locked.has(p));
      if (allowed) seen.push(p);
    }
    expect([...locked]).toEqual(['c', 'd', 'e']);
    expect(lockedProducts({ ...g, hasLead: true }, order).size).toBe(0);
    expect(lockedProducts({ ...g, mode: 'soft' }, order).size).toBe(0);
  });
});

/* ------------------------------ sessions ------------------------------ */

describe('prospect sessions', () => {
  const secret = 's3cret-for-tests';
  it('accepts only correctly signed ids', () => {
    const id = 'AbCdEfGhIjKlMnOpQrStUv';
    const cookie = signSessionId(id, secret);
    expect(verifySessionCookie(cookie, secret)).toBe(id);
    expect(verifySessionCookie(cookie, 'other-secret')).toBeNull();
    expect(verifySessionCookie(`${id}.${'x'.repeat(32)}`, secret)).toBeNull();
    expect(verifySessionCookie(`${id}.sig.extra`, secret)).toBeNull();
    expect(verifySessionCookie('short.sig', secret)).toBeNull();
  });

  it('never reuses a session across tenants', async () => {
    const store = new MemorySessionStore();
    const a = await loadOrCreateSession(new Request('http://x/'), DEMO_TENANT_ID, store, secret);
    await store.save(a.session);
    const cookie = `bc_ps=${encodeURIComponent(signSessionId(a.session.id, secret))}`;
    const again = await loadOrCreateSession(new Request('http://x/', { headers: { cookie } }), DEMO_TENANT_ID, store, secret);
    expect(again.isNew).toBe(false);
    const other = await loadOrCreateSession(new Request('http://x/', { headers: { cookie } }), FREE_TENANT_ID, store, secret);
    expect(other.isNew).toBe(true);
    expect(other.session.id).not.toBe(a.session.id);
  });
});

/* ------------------------------ webhook ------------------------------ */

describe('webhook CRM provider', () => {
  it('refuses URLs that could reach internal services', () => {
    for (const u of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.10/x',
      'https://172.20.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/x',
      'https://[::1]/x',
      'https://user:pw@hooks.example.com/x',
      'not a url',
    ]) {
      expect(webhookUrlProblem(u)).not.toBeNull();
    }
    expect(webhookUrlProblem('https://hooks.zapier.com/hooks/catch/1/abc')).toBeNull();
  });

  it('delivers a signed payload a receiver can verify', async () => {
    let got: { sig: string; body: string } | null = null;
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got = { sig: String(req.headers['x-brandcanvas-signature']), body: b };
        res.end('ok');
      });
    });
    await new Promise<void>((ok) => srv.listen(0, ok));
    const port = (srv.address() as { port: number }).port;
    try {
      const p = new WebhookCrmProvider(`http://127.0.0.1:${port}/hook`, 'whsec', { allowInsecure: true });
      await p.route({ tenantId: DEMO_TENANT_ID, email: 'a@b.co', source: 'email_gate', marketingOptIn: false, leadId: 'L1' });
      const { sig, body } = got!;
      const [t, v1] = sig.split(',').map((x) => x.split('=')[1]!);
      expect(createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex')).toBe(v1);
      expect((JSON.parse(body) as { lead: { email: string } }).lead.email).toBe('a@b.co');
    } finally {
      srv.close();
    }
  });
});

/* ------------------------------ API flows ------------------------------ */

/** Minimal cookie jar so tests behave like a browser across requests. */
function client(fx: ReturnType<typeof buildFixture>, ref: string) {
  let cookie = '';
  async function call(sub: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const req = new Request(`http://x/api/t/${ref}/${sub}`, { ...init, headers });
    const res = await handleTenantApi(req, ref, new URL(req.url).pathname.split('/').slice(4), { api: fx.api, directory: fx.directory });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  }
  const json = (sub: string, bodyObj: Record<string, unknown>) =>
    call(sub, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) });
  return { call, json, cookie: () => cookie };
}

const human = () => ({ website: '', startedAt: Date.now() - 4000 });

async function upload(c: ReturnType<typeof client>) {
  const form = new FormData();
  form.set('file', new Blob([encodePng(sampleLogo())], { type: 'image/png' }), 'logo.png');
  form.set('knockout', 'true');
  const r = await c.call('logos', { method: 'POST', body: form });
  return ((await r.json()) as { logo: { id: string } }).logo.id;
}

type Item = { slug: string; locked: boolean; proofUrl: string | null; color: { hex: string }; method: string; location: string; unit: number; total: number };
async function catalog(c: ReturnType<typeof client>, logo: string, qty = 144) {
  return (await (await c.call(`catalog?logo=${logo}&qty=${qty}`)).json()) as { gate: { remaining: number | null; hasLead: boolean }; items: Item[] };
}
const proofPath = (logo: string, i: Item) =>
  `proofs?${new URLSearchParams({ logo, product: i.slug, color: i.color.hex, method: i.method, location: i.location })}`;

describe('hard email gate (server-enforced)', () => {
  it('shows N products, refuses the rest until an email is given, then unlocks everything', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const logo = await upload(c);
    const cat = await catalog(c, logo);
    expect(cat.gate.remaining).toBe(3);
    const open = cat.items.filter((i) => !i.locked);
    const shut = cat.items.filter((i) => i.locked);
    expect(open.length).toBe(3);
    expect(shut.length).toBe(3);

    for (const i of open) expect((await c.call(proofPath(logo, i))).status).toBe(200);
    // Crafting the URL for a locked product doesn't bypass the gate.
    const refused = await c.call(proofPath(logo, shut[0]!));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('lead_required');
    // Already-seen products stay visible.
    expect((await c.call(proofPath(logo, open[0]!))).status).toBe(200);

    expect((await c.json('leads/email', { email: 'pat@acme.test', marketingOptIn: false, logoId: logo, ...human() })).status).toBe(201);
    const after = await catalog(c, logo);
    expect(after.gate.hasLead).toBe(true);
    expect(after.items.every((i) => !i.locked && i.proofUrl)).toBe(true);
    expect((await c.call(proofPath(logo, shut[0]!))).status).toBe(200);
    expect(fx.crm.received.map((l) => l.source)).toEqual(['email_gate']);
  });

  it('a new browser (no cookie) starts its own allowance; soft and off tenants never lock', async () => {
    const fx = buildFixture();
    const a = client(fx, 'demo');
    const logo = await upload(a);
    for (const i of (await catalog(a, logo)).items.filter((x) => !x.locked)) await a.call(proofPath(logo, i));
    expect((await catalog(client(fx, 'demo'), logo)).gate.remaining).toBe(3);

    const soft = client(fx, 'basic');
    const softLogo = await upload(soft);
    expect((await catalog(soft, softLogo)).items.every((i) => !i.locked)).toBe(true);
  });

  it('sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const fx = buildFixture();
    const r = await client(fx, 'demo').call('session');
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^bc_ps=/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
  });
});

describe('email capture: consent, bots, validation, isolation', () => {
  it('records explicit consent with its text version; a later unticked form does not revoke it', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    await c.json('leads/email', { email: 'Pat@Acme.TEST', marketingOptIn: 'true', ...human() });
    expect(fx.leads.all(DEMO_TENANT_ID)[0]!.marketingOptIn).toBe(false); // "true" string is not consent
    await c.json('leads/email', { email: 'pat@acme.test', marketingOptIn: true, ...human() });
    await c.json('leads/email', { email: 'pat@acme.test', marketingOptIn: false, ...human() });
    const leads = fx.leads.all(DEMO_TENANT_ID);
    expect(leads).toHaveLength(1); // one lead per email, whatever its casing
    expect(leads[0]!.marketingOptIn).toBe(true);
    expect(leads[0]!.consent?.version).toBe('marketing-optin-v1');
  });

  it('bots get a normal-looking 200 and nothing is stored or routed', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    expect((await c.json('leads/email', { email: 'bot@x.co', website: 'http://spam', startedAt: Date.now() - 4000 })).status).toBe(200);
    expect((await c.json('leads/email', { email: 'bot@x.co', website: '', startedAt: Date.now() })).status).toBe(200);
    expect(fx.leads.all(DEMO_TENANT_ID)).toHaveLength(0);
    expect(fx.crm.received).toHaveLength(0);
  });

  it('rejects bad bodies with field-level errors and non-JSON with 400', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const r = await c.json('leads/email', { email: 'nope', ...human() });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { fields: Record<string, string> } }).error.fields.email).toBeTruthy();
    expect((await c.call('leads/email', { method: 'POST', body: 'email=a@b.co', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(400);
    expect((await c.call('leads/email')).status).toBe(405);
  });

  it('rate-limits submissions per client', async () => {
    const fx = buildFixture({ leadLimit: 2 });
    const c = client(fx, 'demo');
    for (let i = 0; i < 2; i++) await c.json('leads/email', { email: `p${i}@acme.test`, ...human() });
    expect((await c.json('leads/email', { email: 'p9@acme.test', ...human() })).status).toBe(429);
  });

  it('a routing failure never loses the lead', async () => {
    const tenants = fixtureTenants().map((t) =>
      t.slug === 'demo' ? { ...t, leads: { ...t.leads!, routing: { provider: 'webhook' as const, url: 'http://127.0.0.1:9/unreachable', secretSealed: devSecretBox().seal('x', DEMO_TENANT_ID) } } } : t,
    );
    const fx = buildFixture({ tenants, allowInsecureWebhooks: true });
    const c = client(fx, 'demo');
    expect((await c.json('leads/email', { email: 'kept@acme.test', ...human() })).status).toBe(201);
    const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
    expect(lead.email).toBe('kept@acme.test');
    const kinds = (await fx.leads.events(DEMO_TENANT_ID, lead.id)).map((e) => e.kind);
    expect(kinds).toEqual(['captured', 'routing_failed']);
  });

  it("leads stay inside their tenant", async () => {
    const fx = buildFixture();
    await client(fx, 'demo').json('leads/email', { email: 'only-demo@acme.test', ...human() });
    expect(fx.leads.all(FREE_TENANT_ID)).toHaveLength(0);
  });
});

describe('quote requests', () => {
  const quoteBody = (logo: string, extra: Record<string, unknown> = {}) => ({
    email: 'buyer@acme.test',
    name: 'Pat Lee',
    company: 'Acme',
    phone: '+1 (555) 010-2000',
    notes: 'Need by May',
    product: 'classic-cotton-tee',
    color: '#0a0a0a',
    method: 'screen_print',
    location: 'full_front',
    quantity: 144,
    logoId: logo,
    marketingOptIn: false,
    ...human(),
    ...extra,
  });

  it('prices on the server (ignores any client price) and routes the full configuration', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const logo = await upload(c);
    const r = await c.json('leads/quote', quoteBody(logo, { unit: 1, total: 1, estimate: { unit: 1 } }));
    expect(r.status).toBe(201);
    const b = (await r.json()) as { message: string; estimate: { unit: number; total: number; estimated: boolean; lines: { label: string; amount: number }[] } };
    const expected = searchCatalog(DEMO_CATALOG, { quantity: 144, logo: { colorCount: 3, isPhotographic: false } }, PLACEHOLDER_TENANT_CONFIG)
      .items.find((i) => i.slug === 'classic-cotton-tee')!;
    expect(b.estimate.unit).toBe(expected.recommended.unit);
    expect(b.estimate.estimated).toBe(true);
    expect(b.message).toBe("Sent to Jordan at Demo Promo Co. They'll reply to buyer@acme.test."); // no doubled period
    const sent = fx.crm.received.at(-1)!;
    expect(sent.source).toBe('quote_request');
    expect(sent.contact).toEqual({ name: 'Pat Lee', company: 'Acme', phone: '+1 (555) 010-2000' });
    expect((sent.details!.estimate as { unit: number }).unit).toBe(expected.recommended.unit);
    expect(String(sent.details!.proofPath)).toMatch(/^\/api\/t\/demo\/proofs\?/);
    // The prospect's copy shows selling prices only; the distributor's CRM copy keeps cost + margin.
    const shown = b.estimate.lines.map((l) => l.label).join(' | ');
    expect(shown).not.toMatch(/Margin|Blanks/);
    expect(b.estimate.lines.reduce((s, l) => s + l.amount, 0)).toBe(b.estimate.total);
    const internal = (sent.details!.estimate as { lines: { label: string }[] }).lines.map((l) => l.label).join(' | ');
    expect(internal).toMatch(/Margin/);
  });

  it('refuses configurations the product does not offer', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const logo = await upload(c);
    expect((await c.json('leads/quote', quoteBody(logo, { color: '#123456' }))).status).toBe(400);
    expect((await c.json('leads/quote', quoteBody(logo, { product: 'performance-polo', color: '#1F45C6', method: 'sublimation' }))).status).toBe(422);
  });

  it('is a Starter feature: Free tenants get 403', async () => {
    const fx = buildFixture();
    const r = await client(fx, 'basic').json('leads/quote', quoteBody('00000000-0000-4000-8000-000000000000'));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { feature: string } }).error.feature).toBe('quote_requests');
  });
});

describe('PDF leave-behind', () => {
  async function pdfjs() {
    const extra = process.env.BC_EXTRA_MODULES;
    const candidates = [extra && path.join(extra, 'pdfjs-dist/legacy/build/pdf.mjs'), path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')].filter(Boolean) as string[];
    const hit = candidates.find((p) => existsSync(p));
    return hit ? ((await import(pathToFileURL(hit).href)) as typeof import('pdfjs-dist')) : null;
  }

  it('produces a branded, parseable PDF of the prospect’s proofs and records the lead', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const logo = await upload(c);
    const r = await c.json('leads/leave-behind', { email: 'sheet@acme.test', marketingOptIn: false, logoId: logo, qty: 72, ...human() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="demo-product-sheet\.pdf"/);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(fx.crm.received.at(-1)!.source).toBe('pdf_leavebehind');

    const lib = await pdfjs();
    if (!lib) return; // parser not installed here: structure checked above
    const doc = await lib.getDocument({ data: bytes, verbosity: 0 }).promise;
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((t) => ('str' in t ? t.str : '')).join(' ');
    for (const s of ['Demo Promo Co.', 'Prepared for sheet@acme.test', 'Classic Cotton Tee', 'Softbound Journal', 'Estimated pricing for 72 pieces', 'Not a quote']) {
      expect(text).toContain(s);
    }
    const ops = await page.getOperatorList();
    expect(ops.fnArray.filter((f) => f === lib.OPS.paintImageXObject).length).toBe(7); // logo + 6 proofs
  });

  it('reuses the session email, needs Pro, and needs a logo', async () => {
    const fx = buildFixture();
    const c = client(fx, 'demo');
    const logo = await upload(c);
    await c.json('leads/email', { email: 'known@acme.test', ...human() });
    const r = await c.json('leads/leave-behind', { logoId: logo, qty: 144 });
    expect(r.status).toBe(200);
    expect((await c.json('leads/leave-behind', { email: 'x@acme.test', ...human() })).status).toBe(404);
    expect((await client(fx, 'basic').json('leads/leave-behind', { logoId: logo, ...human(), email: 'a@b.co' })).status).toBe(403);
  });
});

describe('logo confirmation', () => {
  it('clears the review note even for proofs already in the cache', async () => {
    const fx = buildFixture();
    const c = client(fx, 'basic'); // soft gate: no allowance noise
    const form = new FormData();
    form.set('file', new Blob([encodePng(sampleLogo())], { type: 'image/png' }), 'logo.png');
    const logo = ((await (await c.call('logos', { method: 'POST', body: form })).json()) as { logo: { id: string; needsReview: boolean } }).logo;
    expect(logo.needsReview).toBe(true);
    const item = (await catalog(c, logo.id)).items[0]!;
    const notes = async () => JSON.parse(decodeURIComponent((await c.call(proofPath(logo.id, item))).headers.get('x-proof-notes')!)) as string[];
    expect((await notes()).some((n) => /needs confirmation/.test(n))).toBe(true);

    const conf = await c.json(`logos/${logo.id}/confirm`, { keepEnclosed: true });
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as { logo: { needsReview: boolean } }).logo.needsReview).toBe(false);
    // Same cached PNG, but the note is request-time state, so it's gone now.
    expect((await notes()).some((n) => /needs confirmation/.test(n))).toBe(false);
  });
});
