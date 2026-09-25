/**
 * Webhook hardening + delivery outbox (ADR 0008): address guard, sealed secrets, entitlement-aware
 * routing, retries with backoff, leases, dead-lettering and manual retry.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { isBlockedAddress, guardedLookup } from './net/address-guard';
import { WebhookCrmProvider, webhookUrlProblem } from '@/shared/providers/webhook-crm';
import { createSecretBox, devSecretBox, parseKeyring } from './crypto/secret-box';
import { buildFixture, fixtureTenants, FREE_TENANT_ID } from './testing';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { BACKOFF_MS, MAX_ATTEMPTS } from './leads/delivery';
import { handleTenantApi } from './http/router';
import type { TenantRecord } from './tenancy/context';

const fakeDns = (table: Record<string, string[]>) =>
  ((host: string, _o: unknown, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) => {
    const a = table[host];
    if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(null, a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  }) as Parameters<typeof guardedLookup>[0];

describe('address guard', () => {
  it('blocks private, reserved and mapped addresses; allows public ones', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd12::1', 'fe80::1%eth0', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::', 'nonsense'])
      expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('refuses a host if ANY resolved address is private', async () => {
    const lookup = guardedLookup(fakeDns({ 'mixed.test': ['8.8.8.8', '10.0.0.9'], 'ok.test': ['8.8.4.4'] }));
    const err = await new Promise<Error | null>((r) => lookup('mixed.test', { all: true }, (e) => r(e)));
    expect(err?.message).toMatch(/10\.0\.0\.9/);
    const ok = await new Promise<string>((r) => lookup('ok.test', {}, (_e, a) => r(a as string)));
    expect(ok).toBe('8.8.4.4');
  });

  it('URL check normalises obfuscated IP literals', () => {
    for (const u of ['https://2130706433/', 'https://0x7f.1/', 'https://[::ffff:7f00:1]/', 'https://169.254.169.254/x', 'https://svc.local/'])
      expect(webhookUrlProblem(u), u).toMatch(/private or internal/);
    expect(webhookUrlProblem('https://hooks.zapier.com/a')).toBeNull();
  });

  it('a public-looking name that resolves inward is refused before any connection', async () => {
    const p = new WebhookCrmProvider('https://hooks.evil.test/in', 's', { resolver: fakeDns({ 'hooks.evil.test': ['127.0.0.1'] }) });
    await expect(p.route({ tenantId: 't', email: 'a@b.co', source: 'email_gate', marketingOptIn: false })).rejects.toThrow(/private or reserved/);
  });
});

/** A local receiver whose responses can be scripted. */
async function receiver(script: number[]) {
  const got: { body: string; sig: string; delivery: string }[] = [];
  let i = 0;
  const srv = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const lead = JSON.parse(body).lead;
      got.push({ body, sig: String(req.headers['x-brandcanvas-signature']), delivery: lead.deliveryId });
      const status = script[Math.min(i++, script.length - 1)]!;
      res.writeHead(status, status === 302 ? { location: 'http://127.0.0.1:1/' } : {}).end('ok');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
  return { url, got, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe('webhook provider', () => {
  it('signs the body and never follows redirects', async () => {
    const rx = await receiver([200, 302]);
    try {
      const p = new WebhookCrmProvider(rx.url, 'shh', { allowInsecure: true });
      await p.route({ tenantId: 't', email: 'a@b.co', source: 'email_gate', marketingOptIn: false, deliveryId: 'd1' });
      const [t, v1] = rx.got[0]!.sig.split(',').map((x) => x.split('=')[1]);
      expect(v1).toBe(createHmac('sha256', 'shh').update(`${t}.${rx.got[0]!.body}`).digest('hex'));
      await expect(p.route({ tenantId: 't', email: 'a@b.co', source: 'email_gate', marketingOptIn: false })).rejects.toThrow(/302/);
      expect(rx.got).toHaveLength(2); // the redirect target was never contacted
    } finally {
      await rx.close();
    }
  });
});

describe('secret box', () => {
  it('round-trips, binds to the tenant, detects tampering', () => {
    const box = devSecretBox();
    const sealed = box.seal('whsec_123', 'tenant-a');
    expect(sealed).not.toContain('whsec_123');
    expect(box.open(sealed, 'tenant-a')).toBe('whsec_123');
    expect(() => box.open(sealed, 'tenant-b')).toThrow(/authentication/);
    const parts = sealed.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'), 'tenant-a')).toThrow();
    expect(box.seal('x', 't')).not.toBe(box.seal('x', 't')); // fresh IV each time
  });

  it('rotates keys: old values still open, new values use the current key', () => {
    const k1 = Buffer.alloc(32, 1).toString('base64');
    const k2 = Buffer.alloc(32, 2).toString('base64');
    const oldRing = parseKeyring(`k1:${k1}`);
    const old = createSecretBox(oldRing.keys, oldRing.current).seal('s', 't');
    const ring = parseKeyring(`k2:${k2},k1:${k1}`);
    const box = createSecretBox(ring.keys, ring.current);
    expect(box.open(old, 't')).toBe('s');
    expect(box.seal('s', 't').split('.')[1]).toBe('k2');
    expect(() => createSecretBox(new Map([['k', Buffer.alloc(16)]]), 'k')).toThrow(/32 bytes/);
  });
});

/** Fixture with the demo tenant (Pro) routing to `url`, and a clock the test controls. */
function webhookFixture(url: string, mutate: (t: TenantRecord) => TenantRecord = (t) => t, sealedFor = DEMO_TENANT_ID) {
  let now = new Date('2026-09-01T12:00:00Z');
  const secretSealed = devSecretBox().seal('shh', sealedFor);
  const tenants = fixtureTenants().map((t) =>
    t.slug === 'demo' ? mutate({ ...t, leads: { ...t.leads!, routing: { provider: 'webhook', url, secretSealed } } }) : t,
  );
  const fx = buildFixture({ tenants, allowInsecureWebhooks: true, now: () => now });
  const ctx = { tenant: tenants.find((t) => t.slug === 'demo')!, can: (k: string) => k !== 'nothing' };
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  const capture = (email: string) =>
    handleTenantApi(
      new Request('http://localhost/api/t/demo/leads/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, startedAt: now.getTime() - 5000, website: '' }),
      }),
      'demo',
      ['leads', 'email'],
      { api: fx.api, directory: fx.directory },
    );
  return { fx, ctx, advance, capture };
}

describe('delivery outbox', () => {
  it('retries on the backoff schedule and delivers the identical payload', async () => {
    const rx = await receiver([500, 503, 200]);
    try {
      const { fx, ctx, advance, capture } = webhookFixture(rx.url);
      expect((await capture('retry@acme.test')).status).toBe(201);
      const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
      let [d] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(d).toMatchObject({ status: 'failed', attempts: 1 });

      // Not due yet → nothing attempted.
      advance(BACKOFF_MS[0] - 1);
      expect((await fx.api.delivery.runDue(ctx)).attempted).toBe(0);
      advance(1);
      expect(await fx.api.delivery.runDue(ctx)).toEqual({ attempted: 1, delivered: 0 });
      advance(BACKOFF_MS[1]);
      expect(await fx.api.delivery.runDue(ctx)).toEqual({ attempted: 1, delivered: 1 });

      [d] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(d).toMatchObject({ status: 'delivered', attempts: 3, nextAttemptAt: null });
      const bodies = rx.got.map((g) => JSON.parse(g.body).lead);
      expect(new Set(rx.got.map((g) => g.delivery))).toEqual(new Set([d!.id]));
      expect(bodies[2]).toEqual(bodies[0]); // byte-identical payload on retry
      const kinds = (await fx.leads.events(DEMO_TENANT_ID, lead.id)).map((e) => e.kind);
      expect(kinds).toEqual(['captured', 'routing_failed', 'routing_failed', 'routed']);
    } finally {
      await rx.close();
    }
  });

  it('dead-letters after the last attempt; manual retry can still deliver', async () => {
    const rx = await receiver(Array(MAX_ATTEMPTS).fill(500).concat(200));
    try {
      const { fx, ctx, advance, capture } = webhookFixture(rx.url);
      await capture('dead@acme.test');
      for (const wait of BACKOFF_MS) {
        advance(wait);
        await fx.api.delivery.runDue(ctx);
      }
      const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
      let [d] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(d).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
      advance(30 * 86_400_000);
      expect((await fx.api.delivery.runDue(ctx)).attempted).toBe(0); // dead is never auto-retried

      d = (await fx.api.delivery.retryNow(ctx, d!.id))!;
      expect(d).toMatchObject({ status: 'delivered', attempts: MAX_ATTEMPTS + 1 });
      expect(await fx.api.delivery.retryNow(ctx, d.id)).toBeNull(); // delivered can't be re-sent
    } finally {
      await rx.close();
    }
  });

  it('two workers never claim the same delivery', async () => {
    const rx = await receiver([500, 200]);
    try {
      const { fx, advance, capture } = webhookFixture(rx.url);
      await capture('lease@acme.test');
      advance(BACKOFF_MS[0]);
      const t0 = new Date('2026-09-01T12:01:00Z');
      const lease = new Date(t0.getTime() + 60_000);
      const [a, b] = await Promise.all([
        fx.deliveries.claimDue(DEMO_TENANT_ID, t0, lease, 10),
        fx.deliveries.claimDue(DEMO_TENANT_ID, t0, lease, 10),
      ]);
      expect(a.length + b.length).toBe(1);
    } finally {
      await rx.close();
    }
  });

  it('a later success does not hide an earlier failed capture', async () => {
    const rx = await receiver([500, 200]);
    try {
      const { fx, capture } = webhookFixture(rx.url);
      await capture('two@acme.test');
      await capture('two@acme.test');
      const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
      const ds = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(ds.map((d) => d.status)).toEqual(['failed', 'delivered']);
    } finally {
      await rx.close();
    }
  });

  it('webhook routing needs the Pro entitlement, checked on every attempt', async () => {
    const rx = await receiver([200]);
    try {
      // Same saved webhook settings, but the tenant is on Free.
      const { fx, capture } = webhookFixture(rx.url, (t) => ({ ...t, plan: 'free' }));
      await capture('downgraded@acme.test');
      expect(rx.got).toHaveLength(0);
      const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
      const [d] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(d).toMatchObject({ status: 'delivered', routedTo: 'mock' });
    } finally {
      await rx.close();
    }
  });

  it("a secret sealed for another tenant can't be used", async () => {
    const rx = await receiver([200]);
    try {
      const { fx, capture } = webhookFixture(rx.url, (t) => t, FREE_TENANT_ID);
      expect((await capture('foreign@acme.test')).status).toBe(201); // lead still stored
      const lead = fx.leads.all(DEMO_TENANT_ID)[0]!;
      const [d] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
      expect(d!.status).toBe('failed');
      expect(d!.lastError).toMatch(/authentication/);
      expect(rx.got).toHaveLength(0);
    } finally {
      await rx.close();
    }
  });
});
