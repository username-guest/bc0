/** Tracked links and funnel analytics (ADR 0014). */
import { describe, it, expect } from 'vitest';
import { buildFixture, ENT_TENANT_ID, FREE_TENANT_ID } from './testing';
import { handleTenantApi } from './http/router';
import { DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { MockEmailProvider } from '@/shared/providers/mocks';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { runMaintenance } from './jobs/maintenance';
import { MemoryWindowStore } from './rate-limit';
import { CODE_LENGTH, dayRange, newLinkCode, parseSrc, summarize } from '@/features/analytics/funnel';
import type { TrackedLink } from './repos/types';

type Fx = ReturnType<typeof buildFixture>;

function setup() {
  let now = new Date('2026-09-10T12:00:00Z');
  const email = new MockEmailProvider();
  const fx = buildFixture({ email, now: () => now });
  // Bot checks compare the form's start time with the fixture clock, not the real one.
  const human = () => ({ website: '', startedAt: now.getTime() - 4000 });
  return { fx, email, human, setNow: (iso: string) => (now = new Date(iso)) };
}

/** Cookie jar + CSRF, for prospects and admins alike. */
function browser(fx: Fx, ref: string, ua = 'Mozilla/5.0 (Macintosh) Safari/605') {
  const jar = new Map<string, string>();
  let csrf = '';
  async function call(sub: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'user-agent': ua, ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && init.method && init.method !== 'GET') headers['x-csrf-token'] ??= csrf;
    const req = new Request(`http://localhost/api/t/${ref}/${sub}`, { ...init, headers });
    const res = await handleTenantApi(req, ref, sub.split('?')[0]!.split('/'), { api: fx.api, admin: fx.admin, directory: fx.directory });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  }
  const send = (method: string, sub: string, body: unknown) =>
    call(sub, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    call,
    send,
    visit: (src?: string) => send('POST', 'visit', src === undefined ? {} : { src }),
    async signIn(mail: MockEmailProvider, address: string) {
      await send('POST', 'admin/sign-in', { email: address });
      await fx.admin.settled();
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail.sent[mail.sent.length - 1]!.text)![1]!;
      expect((await send('POST', 'admin/verify', { token })).status).toBe(200);
      csrf = (await (await call('admin/me')).json()).csrfToken;
    },
    dropCsrf() {
      csrf = '';
    },
  };
}

type LinkDto = { id: string; code: string; label: string; channel: string; archived: boolean; url: string };
type Summary = {
  totals: { visit: number; proof: number; lead: number };
  byDay: { day: string; visit: number; proof: number; lead: number }[];
  byLink: { linkId: string | null; code: string | null; label: string; archived: boolean; visit: number; proof: number; lead: number }[];
  range: { from: string; to: string; days: number };
};

async function adminFor(fx: Fx, email: MockEmailProvider, ref = 'demo', who = 'owner@demo.test') {
  const b = browser(fx, ref);
  await b.signIn(email, who);
  return b;
}
async function makeLink(b: ReturnType<typeof browser>, label: string, channel = 'event') {
  const r = await b.send('POST', 'admin/links', { label, channel });
  expect(r.status).toBe(201);
  return ((await r.json()) as { link: LinkDto }).link;
}
async function summary(b: ReturnType<typeof browser>, days = 30) {
  const r = await b.call(`admin/analytics?days=${days}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { summary: Summary }).summary;
}

/* ------------------------------ pure parts ------------------------------ */

describe('link codes and ranges', () => {
  it('codes are short, unambiguous and parse back; anything else is ignored', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = newLinkCode();
      expect(c).toMatch(new RegExp(`^[a-km-np-z2-9]{${CODE_LENGTH}}$`));
      expect(parseSrc(c)).toBe(c);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
    expect(parseSrc(' ABCDEFG ')).toBe('abcdefg');
    for (const bad of ['abc', 'abcdefgh', 'abcdef0', 'abcdefl', '<script>', 42, null, undefined]) expect(parseSrc(bad)).toBeNull();
  });

  it('day ranges end today in UTC and cross month ends', () => {
    const r = dayRange(new Date('2026-03-02T23:59:00Z'), 7);
    expect(r.days).toEqual(['2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(dayRange(new Date('2026-03-02T00:00:01Z'), 1)).toEqual({ from: '2026-03-02', to: '2026-03-02', days: ['2026-03-02'] });
  });

  it('summaries fill empty days, total the stages and hide archived links with no activity', () => {
    const link = (id: string, archived = false): TrackedLink => ({ id, tenantId: 't', code: `code${id}xx`.slice(0, 7), label: `L${id}`, channel: 'event', createdBy: null, archivedAt: archived ? '2026-01-01T00:00:00Z' : null, createdAt: '2026-01-01T00:00:00Z' });
    const s = summarize(
      {
        byDay: [
          { day: '2026-09-09', kind: 'visit', count: 3 },
          { day: '2026-09-10', kind: 'visit', count: 2 },
          { day: '2026-09-10', kind: 'lead', count: 1 },
          { day: '2026-08-01', kind: 'visit', count: 99 }, // outside the range: ignored
        ],
        byLink: [
          { linkId: 'a', kind: 'visit', count: 4 },
          { linkId: 'a', kind: 'lead', count: 1 },
          { linkId: null, kind: 'visit', count: 1 },
        ],
      },
      [link('a'), link('b'), link('c', true)],
      dayRange(new Date('2026-09-10T08:00:00Z'), 3),
    );
    expect(s.totals).toEqual({ visit: 5, proof: 0, lead: 1 });
    expect(s.byDay.map((d) => [d.day, d.visit])).toEqual([['2026-09-08', 0], ['2026-09-09', 3], ['2026-09-10', 2]]);
    expect(s.byLink.map((r) => [r.label, r.visit, r.lead])).toEqual([['La', 4, 1], ['Direct / no link', 1, 0], ['Lb', 0, 0]]);
  });
});

/* ------------------------------ storefront ------------------------------ */

describe('visits and attribution', () => {
  it('a tracked link attributes the session, once; visits count once per session per day', async () => {
    const { fx, email, setNow } = setup();
    const admin = await adminFor(fx, email);
    const show = await makeLink(admin, 'Spring trade show');
    const mail = await makeLink(admin, "Dana's emails", 'email');
    expect(show.url).toBe(`http://localhost:3000/t/demo/?src=${show.code}`);

    const p = browser(fx, 'demo');
    const first = await p.visit(show.code.toUpperCase());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ email: null, gate: { mode: 'hard' } });
    await p.visit(show.code); // refresh
    await p.visit(mail.code); // a second link later doesn't steal the credit (first touch)
    setNow('2026-09-11T09:00:00Z');
    await p.visit();

    await admin.signIn(email, 'owner@demo.test'); // yesterday's admin session has expired
    const s = await summary(admin);
    expect(s.totals.visit).toBe(2); // two days, one session
    const row = (code: string | null) => s.byLink.find((r) => r.code === code)!;
    expect(row(show.code).visit).toBe(2);
    expect(row(mail.code).visit).toBe(0);
    expect(s.byDay.at(-2)!.visit).toBe(1);
    expect(s.byDay.at(-1)!.visit).toBe(1);
  });

  it('ignores unknown, archived, malformed and other-tenant codes, but still counts the visit', async () => {
    const { fx, email } = setup();
    const admin = await adminFor(fx, email);
    const old = await makeLink(admin, 'Last year');
    expect((await admin.send('PUT', `admin/links/${old.id}`, { archived: true })).status).toBe(200);
    const big = await makeLink(await adminFor(fx, email, 'bigco', 'owner@bigco.test'), 'BigCo booth');

    for (const src of [old.code, big.code, 'zzzzzzz', '../../etc', 'x'.repeat(5000)]) {
      const p = browser(fx, 'demo');
      expect((await p.visit(src)).status).toBe(200);
    }
    const s = await summary(admin);
    expect(s.totals.visit).toBe(5);
    expect(s.byLink.find((r) => r.linkId === null)!.visit).toBe(5);
    expect(s.byLink.some((r) => r.code === big.code)).toBe(false);
  });

  it('link-preview bots are not visitors', async () => {
    const { fx, email } = setup();
    for (const ua of ['Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'Googlebot/2.1']) await browser(fx, 'demo', ua).visit();
    expect((await summary(await adminFor(fx, email))).totals.visit).toBe(0);
  });

  it('on a plan without tracked links, ?src= is ignored but visits still count (history survives an upgrade)', async () => {
    const { fx } = setup();
    // Free plan: no links can exist, so plant one directly to prove the storefront ignores it.
    await fx.analytics.createLink({ id: crypto.randomUUID(), tenantId: FREE_TENANT_ID, code: 'abcdefg', label: 'x', channel: 'other', createdBy: null, archivedAt: null, createdAt: new Date().toISOString() });
    const p = browser(fx, 'basic');
    await p.visit('abcdefg');
    const c = await fx.analytics.counts(FREE_TENANT_ID, '2026-09-01', '2026-09-30');
    expect(c.byLink).toEqual([{ linkId: null, kind: 'visit', count: 1 }]);
  });

  it('proofs and leads count, and the lead carries the link into its history and the CRM payload', async () => {
    const { fx, email, human } = setup();
    const admin = await adminFor(fx, email);
    const link = await makeLink(admin, 'Spring trade show');
    const p = browser(fx, 'demo');
    await p.visit(link.code);

    const form = new FormData();
    form.set('file', new Blob([encodePng(sampleLogo())], { type: 'image/png' }), 'logo.png');
    form.set('knockout', 'true');
    const logo = ((await (await p.call('logos', { method: 'POST', body: form })).json()) as { logo: { id: string } }).logo.id;
    const cat = (await (await p.call(`catalog?logo=${logo}&qty=144`)).json()) as { items: { locked: boolean; proofUrl: string | null }[] };
    const open = cat.items.filter((i) => !i.locked && i.proofUrl);
    for (const i of open.slice(0, 2)) expect((await p.call(i.proofUrl!.split('/api/t/demo/')[1]!)).status).toBe(200);

    expect((await p.send('POST', 'leads/email', { email: 'pat@acme.test', marketingOptIn: false, ...human() })).status).toBe(201);

    const s = await summary(admin);
    expect(s.totals).toEqual({ visit: 1, proof: 1, lead: 1 }); // stages count sessions, not images
    expect(s.byLink.find((r) => r.code === link.code)).toMatchObject({ visit: 1, proof: 1, lead: 1 });

    const lead = (await fx.leads.list(DEMO_TENANT_ID, { limit: 5 })).items[0]!;
    const events = await fx.leads.events(DEMO_TENANT_ID, lead.id);
    expect(events[0]!.payload.trackedLink).toEqual({ code: link.code, label: 'Spring trade show' });
    const [delivery] = await fx.deliveries.forLead(DEMO_TENANT_ID, lead.id);
    expect((delivery!.payload.details as Record<string, unknown>).trackedLink).toEqual({ code: link.code, label: 'Spring trade show' });
  });

  it('a proof or lead also counts as that day\'s visit (page left open overnight), so rates stay at or below 100%', async () => {
    const { fx, email, human, setNow } = setup();
    const p = browser(fx, 'demo');
    await p.visit();
    setNow('2026-09-11T08:00:00Z'); // next morning, same tab: no new page load
    expect((await p.send('POST', 'leads/email', { email: 'late@acme.test', marketingOptIn: false, ...human() })).status).toBe(201);
    const s = await summary(await adminFor(fx, email));
    expect(s.totals).toEqual({ visit: 2, proof: 0, lead: 1 });
    expect(s.byDay.at(-1)).toMatchObject({ visit: 1, lead: 1 });
  });

  it('a lead without a link has no trackedLink field at all', async () => {
    const { fx, human } = setup();
    const p = browser(fx, 'demo');
    await p.visit();
    await p.send('POST', 'leads/email', { email: 'sam@acme.test', marketingOptIn: false, ...human() });
    const lead = (await fx.leads.list(DEMO_TENANT_ID, { limit: 5 })).items[0]!;
    expect('trackedLink' in (await fx.leads.events(DEMO_TENANT_ID, lead.id))[0]!.payload).toBe(false);
  });

  it('the visit beacon only accepts POST', async () => {
    const { fx } = setup();
    expect((await browser(fx, 'demo').call('visit')).status).toBe(405);
  });
});

/* ------------------------------ admin ------------------------------ */

describe('tracked links admin', () => {
  it('both roles can create, rename and archive; every change is audited', async () => {
    const { fx, email } = setup();
    const staff = await adminFor(fx, email, 'demo', 'staff@demo.test');
    const l = await makeLink(staff, '  Booth   42 ', 'print');
    expect(l).toMatchObject({ label: 'Booth 42', channel: 'print', archived: false });
    expect((await staff.send('PUT', `admin/links/${l.id}`, { label: 'Booth 42 (Chicago)', channel: 'event' })).status).toBe(200);
    expect((await staff.send('PUT', `admin/links/${l.id}`, { archived: true })).status).toBe(200);
    expect((await staff.send('PUT', `admin/links/${l.id}`, { archived: false })).status).toBe(200);
    const list = (await (await staff.call('admin/links')).json()) as { links: LinkDto[]; canCreate: boolean };
    expect(list.canCreate).toBe(true);
    expect(list.links[0]).toMatchObject({ code: l.code, label: 'Booth 42 (Chicago)', channel: 'event', archived: false });
    const actions = (await fx.audit.recent(DEMO_TENANT_ID, 10)).filter((e) => e.action.startsWith('links.')).map((e) => [e.action, e.target]);
    expect(actions).toEqual([
      ['links.update', `${l.code} restored`],
      ['links.update', `${l.code} archived`],
      ['links.update', `${l.code} edited`],
      ['links.create', `${l.code} Booth 42`],
    ]);
  });

  it('validates input, refuses cross-site writes and unknown ids', async () => {
    const { fx, email } = setup();
    const b = await adminFor(fx, email);
    const bad = await b.send('POST', 'admin/links', { label: '', channel: 'billboard' });
    expect(bad.status).toBe(422);
    const fields = ((await bad.json()) as { error: { fields: Record<string, string> } }).error.fields;
    expect(typeof fields.label === 'string' && typeof fields.channel === 'string').toBe(true);
    expect((await b.send('POST', 'admin/links', { label: 'x'.repeat(81), channel: 'email' })).status).toBe(422);
    expect((await b.send('PUT', `admin/links/${crypto.randomUUID()}`, { archived: true })).status).toBe(404);
    expect((await b.send('PUT', 'admin/links/not-a-uuid', { archived: true })).status).toBe(404);
    const l = await makeLink(b, 'Mailer');
    expect((await b.send('PUT', `admin/links/${l.id}`, { archived: 'yes' })).status).toBe(422);
    b.dropCsrf();
    expect((await b.send('POST', 'admin/links', { label: 'Sneaky', channel: 'email' })).status).toBe(403);
    expect((await browser(fx, 'demo').call('admin/links')).status).toBe(401);
  });

  it('links belong to one tenant', async () => {
    const { fx, email } = setup();
    const l = await makeLink(await adminFor(fx, email), 'Demo only');
    const big = await adminFor(fx, email, 'bigco', 'owner@bigco.test');
    expect(((await (await big.call('admin/links')).json()) as { links: LinkDto[] }).links).toEqual([]);
    expect((await big.send('PUT', `admin/links/${l.id}`, { archived: true })).status).toBe(404);
  });

  it('plan gating: Free can list but not create; a downgraded tenant can still archive, not edit or restore', async () => {
    const { fx, email } = setup();
    const free = await adminFor(fx, email, 'basic', 'owner@basic.test');
    const list = (await (await free.call('admin/links')).json()) as { canCreate: boolean; upgradeable: boolean };
    expect(list).toMatchObject({ canCreate: false, upgradeable: true });
    const refused = await free.send('POST', 'admin/links', { label: 'Nope', channel: 'email' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('feature_locked');
    expect((await free.call('admin/analytics')).status).toBe(403);

    const b = await adminFor(fx, email, 'bigco', 'owner@bigco.test');
    const l = await makeLink(b, 'Before downgrade');
    await fx.directory.setFlagOverrides(ENT_TENANT_ID, ['shareable_tracked_links'], { shareable_tracked_links: false });
    expect((await b.send('PUT', `admin/links/${l.id}`, { label: 'Renamed' })).status).toBe(403);
    expect((await b.send('PUT', `admin/links/${l.id}`, { archived: true })).status).toBe(200);
    expect((await b.send('PUT', `admin/links/${l.id}`, { archived: false })).status).toBe(403);
  });

  it('caps active links; archiving frees a slot', async () => {
    const { fx, email } = setup();
    const b = await adminFor(fx, email);
    for (let i = 0; i < 200; i++) {
      await fx.analytics.createLink({ id: crypto.randomUUID(), tenantId: DEMO_TENANT_ID, code: newLinkCode(), label: `L${i}`, channel: 'other', createdBy: null, archivedAt: null, createdAt: new Date().toISOString() });
    }
    const full = await b.send('POST', 'admin/links', { label: 'One more', channel: 'email' });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('too_many_links');
    const some = (await fx.analytics.listLinks(DEMO_TENANT_ID))[0]!;
    expect((await b.send('PUT', `admin/links/${some.id}`, { archived: true })).status).toBe(200);
    expect((await b.send('POST', 'admin/links', { label: 'One more', channel: 'email' })).status).toBe(201);
    expect((await b.send('PUT', `admin/links/${some.id}`, { archived: false })).status).toBe(409);
  });

  it('the dashboard accepts only the offered ranges and reports its timezone', async () => {
    const { fx, email } = setup();
    const b = await adminFor(fx, email);
    expect((await summary(b, 7)).range).toEqual({ from: '2026-09-04', to: '2026-09-10', days: 7 });
    expect((await summary(b, 365)).byDay.length).toBe(365);
    const odd = (await (await b.call('admin/analytics?days=13')).json()) as { summary: Summary; timezone: string };
    expect(odd.summary.range.days).toBe(30);
    expect(odd.timezone).toBe('UTC');
  });
});

describe('retention', () => {
  it('maintenance deletes funnel events older than the retention window', async () => {
    const { fx } = setup();
    // 400 days before 2026-09-10 is 2025-08-06: that day stays, the two before it go.
    for (const day of ['2025-08-04', '2025-08-05', '2025-08-06', '2026-09-01']) {
      await fx.analytics.record({ tenantId: DEMO_TENANT_ID, day, sessionId: 's1', kind: 'visit', linkId: null });
    }
    const r = await runMaintenance({ directory: fx.directory, auth: fx.auth, rateStore: new MemoryWindowStore(), analytics: fx.analytics, now: () => new Date('2026-09-10T00:00:00Z') });
    expect(r.analyticsEvents).toBe(2);
    const left = await fx.analytics.counts(DEMO_TENANT_ID, '2000-01-01', '2100-01-01');
    expect(left.byDay.map((x) => x.day).sort()).toEqual(['2025-08-06', '2026-09-01']);
  });
});
