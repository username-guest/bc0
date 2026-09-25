/**
 * Postgres-mode smoke test: drives the PRODUCTION build (`next start`, DATA_MODE=postgres, app role
 * under RLS) over real HTTP, and after each step checks the rows landed in Postgres.
 *
 * Prereqs: `npm run build`, `npm run db:setup`, and the app role able to log in (DATABASE_URL).
 *   DATABASE_URL=… MIGRATION_DATABASE_URL=… npm run smoke:pg
 *
 * Production refuses EMAIL_PROVIDER=log, so sign-in runs with the real `resend` provider and a
 * dummy key: the request must still answer 202 and store a hashed token. The test then plants a
 * token of its own (known secret, hashed as the app does) to exercise verify → session → CSRF.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { S3StorageProvider } from '@/shared/providers/s3-storage';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const PORT = Number(process.env.SMOKE_PORT ?? 3100);
const base = `http://localhost:${PORT}`;
const started = new Date();
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: need('MIGRATION_DATABASE_URL') });
const one = async <T = Record<string, unknown>>(q: string, v: unknown[] = []) => (await db.query(q, v)).rows[0] as T | undefined;

const storage = await mkdtemp(path.join(tmpdir(), 'bc-pg-smoke-'));
const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  // `next start` is production; make the app's env validation agree (a sourced .env may say otherwise).
  NODE_ENV: 'production' as const,
  DATA_MODE: 'postgres',
  DATABASE_URL: need('DATABASE_URL'),
  AUTH_SECRET: randomBytes(32).toString('base64url'),
  SETTINGS_ENCRYPTION_KEYS: `smoke:${randomBytes(32).toString('base64')}`,
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_smoke_not_a_real_key',
  PUBLIC_BASE_URL: base,
  // SMOKE_STORAGE=s3 runs the same journey on the S3 adapter (STORAGE_* from the environment).
  STORAGE_DRIVER: process.env.SMOKE_STORAGE === 's3' ? 's3' : 'local',
  LOCAL_STORAGE_DIR: storage,
  DELIVERY_WORKER: 'off',
  // Pre-rendering runs from the job script below, so the first-render check here stays deterministic.
  PROOF_WORKER: 'off',
  NEXT_TELEMETRY_DISABLED: '1',
};
let serverLog = '';
const server = spawn(path.join('node_modules', '.bin', 'next'), ['start', '-p', String(PORT)], { env: serverEnv });
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));

/** Browser-ish cookie jar + CSRF header. */
const jar = new Map<string, string>();
let csrf = '';
async function call(p: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  if (csrf && init.method && init.method !== 'GET' && !headers.has('x-csrf-token')) headers.set('x-csrf-token', csrf);
  const res = await fetch(base + p, { ...init, headers, redirect: 'manual' });
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const i = pair!.indexOf('=');
    const [k, v] = [pair!.slice(0, i), pair!.slice(i + 1)];
    if (v === '' || /max-age=0/i.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
  return res;
}
const send = (method: string, p: string, body: unknown, headers: Record<string, string> = {}) =>
  call(p, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Set once the smoke test upgrades the demo tenant for the team steps; always undone. */
let restorePlan: (() => Promise<void>) | null = null;
try {
  await db.connect();
  const tenant = await one<{ id: string }>(`select id from tenants where slug = 'demo'`);
  if (!tenant) throw new Error('demo tenant missing — run npm run db:setup');
  const T = tenant.id;
  const api = '/api/t/demo';

  // Wait for the server.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${base}/t/demo`)).status > 0;
    } catch {
      await sleep(500);
    }
  }
  check('production server started (next start, DATA_MODE=postgres)', up);
  if (!up) throw new Error('server did not start');

  // 1. Storefront pages resolve the tenant from the database.
  const page = await fetch(`${base}/t/demo`);
  check('storefront renders for a seeded tenant', page.status === 200, String(page.status));
  const missing = await fetch(`${base}/t/no-such-tenant`);
  check('unknown tenant is a 404', missing.status === 404, String(missing.status));

  // 2. Logo upload → logo_assets.
  const form = new FormData();
  // Unique per run: uploads are de-duplicated by content, and each run uses a fresh storage dir.
  const width = 560 + (Date.now() % 80);
  form.set('file', new Blob([encodePng(sampleLogo(width, 300))], { type: 'image/png' }), 'logo.png');
  form.set('knockout', 'true');
  const upRes = await call(`${api}/logos`, { method: 'POST', body: form });
  const logo = ((await upRes.json()) as { logo?: { id: string; colorCount: number } }).logo;
  check('logo upload', upRes.status === 201 && !!logo, String(upRes.status));
  const logoRow = await one(`select 1 from logo_assets where id = $1 and tenant_id = $2`, [logo?.id, T]);
  check('  → logo_assets row, owned by the tenant', !!logoRow);
  if (process.env.SMOKE_STORAGE === 's3') {
    const bucket = new S3StorageProvider({
      bucket: need('STORAGE_BUCKET'),
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      accessKeyId: need('STORAGE_ACCESS_KEY'),
      secretAccessKey: need('STORAGE_SECRET_KEY'),
      ...(process.env.STORAGE_ENDPOINT ? { endpoint: process.env.STORAGE_ENDPOINT } : {}),
    });
    const keys = await one<{ clean_key: string; storage_key: string }>(`select clean_key, storage_key from logo_assets where id = $1`, [logo?.id]);
    const cleaned = keys ? await bucket.get(keys.clean_key, T) : null;
    check('  → cleaned logo stored in the S3 bucket under the tenant prefix', !!cleaned && cleaned.contentType === 'image/png' && cleaned.data.byteLength > 0);
  }

  // 3. Priced catalog from the tenant's products.
  type Item = { slug: string; unit: number; total: number; proofUrl: string | null; locked: boolean };
  const units = async () => {
    const r = await call(`${api}/catalog?logo=${logo?.id}&qty=144`);
    return { status: r.status, items: ((await r.json()) as { items?: Item[] }).items ?? [] };
  };
  const cat = await units();
  const priced = cat.items.every((i) => Number.isInteger(i.unit) && i.unit > 0 && Number.isInteger(i.total));
  check('catalog prices every product in integer cents', cat.status === 200 && cat.items.length > 0 && priced, `${cat.items.length} items`);

  // 4. A proof render, then the same proof from the storage cache (proofs/<key>.png).
  const open = cat.items.find((i) => i.proofUrl && !i.locked);
  const proof = open ? await call(open.proofUrl!) : null;
  const first = proof ? new Uint8Array(await proof.arrayBuffer()) : new Uint8Array();
  check('proof renders as PNG', proof?.status === 200 && proof.headers.get('content-type') === 'image/png', `${proof?.status}, ${proof?.headers.get('x-proof-cache')}`);
  const again = open ? await call(open.proofUrl!) : null;
  const second = again ? new Uint8Array(await again.arrayBuffer()) : new Uint8Array();
  check('  → second request served from the proof cache, byte-identical',
    proof?.headers.get('x-proof-cache') === 'miss' && again?.headers.get('x-proof-cache') === 'hit' && first.length > 0 && Buffer.from(first).equals(Buffer.from(second)));

  // 4b. Pre-rendering (ADR 0015): the upload queued the catalog's proofs; a job pass renders them.
  const queued = await one<{ n: number }>(`select count(*)::int as n from mockup_jobs where tenant_id = $1 and logo_asset_id = $2 and status = 'queued'`, [T, logo?.id]);
  check('logo upload queued every catalog proof for pre-rendering', (queued?.n ?? 0) === cat.items.length, `${queued?.n} of ${cat.items.length}`);
  // Same environment as the server (database role, storage directory), in its own process.
  const pre = spawnSync(path.join('node_modules', '.bin', 'tsx'), ['scripts/jobs/prerender-proofs.ts'], { env: serverEnv, encoding: 'utf8' });
  const preReport = (() => { try { return JSON.parse(pre.stdout.trim().split('\n').pop() ?? '{}') as { rendered?: number; cached?: number; failed?: number; errors?: unknown[] }; } catch { return {}; } })();
  const doneRows = await one<{ n: number }>(`select count(*)::int as n from mockup_jobs where tenant_id = $1 and logo_asset_id = $2 and status = 'done' and attempts = 1`, [T, logo?.id]);
  check('npm run jobs:proofs renders them as the app role (the one already shown is a cache hit)',
    pre.status === 0 && doneRows?.n === cat.items.length && preReport.cached === 1 && preReport.rendered === cat.items.length - 1 && preReport.failed === 0,
    `${pre.status}, done ${doneRows?.n}, rendered ${preReport.rendered}, cached ${preReport.cached} ${pre.stderr.trim().slice(-160)}`);
  const next = cat.items.find((i) => i.proofUrl && !i.locked && i.slug !== open?.slug);
  const nextRes = next ? await call(next.proofUrl!) : null;
  check('  → the next catalog image is a cache hit on its very first request', nextRes?.status === 200 && nextRes.headers.get('x-proof-cache') === 'hit', `${nextRes?.status} ${nextRes?.headers.get('x-proof-cache')}`);
  await nextRes?.arrayBuffer();
  const dupUp = new FormData();
  dupUp.set('file', new Blob([encodePng(sampleLogo(width, 300))], { type: 'image/png' }), 'logo.png');
  dupUp.set('knockout', 'true');
  await (await call(`${api}/logos`, { method: 'POST', body: dupUp })).arrayBuffer();
  const jobCount = await one<{ n: number }>(`select count(*)::int as n from mockup_jobs where tenant_id = $1 and logo_asset_id = $2`, [T, logo?.id]);
  check('  → uploading the same logo again queues nothing new (unique per proof)', jobCount?.n === cat.items.length, `${jobCount?.n}`);

  // 5. Lead capture → leads + delivery outbox + session link.
  const email = `smoke+${Date.now()}@acme.test`;
  const lead = await send('POST', `${api}/leads/email`, { email, marketingOptIn: false, logoId: logo?.id, website: '', startedAt: Date.now() - 4000 });
  check('email-gate lead capture', lead.status === 201, String(lead.status));
  const leadRow = await one<{ id: string }>(`select id from leads where tenant_id = $1 and email = $2`, [T, email]);
  check('  → leads row', !!leadRow);
  const delivery = await one(`select status from lead_deliveries where tenant_id = $1 and lead_id = $2`, [T, leadRow?.id]);
  check('  → lead_deliveries outbox row', !!delivery, String((delivery as { status?: string } | undefined)?.status));
  const sess = await one<{ id: string }>(`select id from prospect_sessions where tenant_id = $1 and lead_id = $2`, [T, leadRow?.id]);
  check('  → prospect session linked to the lead', !!sess);
  const funnel = await one<{ kinds: string }>(`select string_agg(kind, ',' order by kind) as kinds from analytics_events where tenant_id = $1 and session_id = $2`, [T, sess?.id]);
  check('  → funnel events recorded for the session (lead implies visit; proof seen)', funnel?.kinds === 'lead,proof,visit', funnel?.kinds ?? 'none');
  const windows = await one<{ n: number }>(`select count(*)::int as n from rate_limits`);
  check('  → rate limits counted in the shared Postgres store', (windows?.n ?? 0) > 0, `${windows?.n} windows`);

  // 6. Admin provisioning via the CLI (runs as the app role, under RLS).
  const adminEmail = 'owner@smoke.test';
  const add = spawnSync(path.join('node_modules', '.bin', 'tsx'), ['scripts/admin/add-admin.ts', 'demo', adminEmail, 'tenant_owner'], { env: process.env, encoding: 'utf8' });
  const user = await one<{ id: string }>(`select id from users where tenant_id = $1 and email = $2 and role = 'tenant_owner'`, [T, adminEmail]);
  check('npm run admin:add creates a tenant owner', add.status === 0 && !!user, add.stderr.trim().split('\n').pop() ?? '');

  // 7. Sign-in request → hashed single-use token (email itself fails: dummy Resend key).
  const signIn = await send('POST', `${api}/admin/sign-in`, { email: adminEmail });
  check('sign-in request answers 202 (no account enumeration)', signIn.status === 202, String(signIn.status));
  let token: { token_hash: string } | undefined;
  for (let i = 0; i < 20 && !token; i++) {
    token = await one(`select token_hash from admin_login_tokens where tenant_id = $1 and user_id = $2 and created_at >= $3`, [T, user?.id, started]);
    if (!token) await sleep(250);
  }
  check('  → admin_login_tokens row, stored as a SHA-256 hash', !!token && /^[0-9a-f]{64}$/.test(token.token_hash));

  // 8. Verify with a planted token (known secret) → session.
  const secret = randomBytes(32).toString('base64url');
  await db.query(
    `insert into admin_login_tokens (tenant_id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`,
    [T, user?.id, createHash('sha256').update(secret, 'utf8').digest('hex')],
  );
  const verify = await send('POST', `${api}/admin/verify`, { token: secret });
  check('magic-link verify signs in', verify.status === 200, String(verify.status));
  const session = await one(`select 1 from admin_sessions where tenant_id = $1 and user_id = $2 and revoked_at is null`, [T, user?.id]);
  check('  → admin_sessions row', !!session);
  const replay = await send('POST', `${api}/admin/verify`, { token: secret });
  check('  a used link cannot be replayed', replay.status !== 200, String(replay.status));

  const me = await call(`${api}/admin/me`);
  csrf = ((await me.json()) as { csrfToken?: string }).csrfToken ?? '';
  check('admin/me returns a CSRF token', me.status === 200 && csrf.length > 0);
  const inbox = await call(`${api}/admin/leads`);
  check('lead inbox lists the captured lead', inbox.status === 200 && (await inbox.text()).includes(email));

  // 9. Pricing save → tenant_settings → storefront prices.
  const cfgRes = await call(`${api}/admin/settings/pricing`);
  const { config } = (await cfgRes.json()) as { config: Record<string, unknown> & { marginMarkup: number } };
  const markup = Math.round((config.marginMarkup + 0.5) * 100) / 100;
  const noCsrf = await send('PUT', `${api}/admin/settings/pricing`, { config: { ...config, marginMarkup: markup } }, { 'x-csrf-token': 'wrong' });
  check('pricing save without the CSRF token is refused', noCsrf.status === 403, String(noCsrf.status));
  const save = await send('PUT', `${api}/admin/settings/pricing`, { config: { ...config, marginMarkup: markup } });
  check('owner saves pricing', save.status === 200, String(save.status));

  // Storefront feature switch (ADR 0013): stored as a tenant override under RLS, enforced at once.
  const quoteStatus = async () => (await fetch(`${base}${api}/leads/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  const off = await send('PUT', `${api}/admin/features`, { features: { quote_requests: false } });
  const row = await one<{ enabled: boolean }>(`select enabled from feature_overrides where tenant_id = $1 and flag_key = 'quote_requests' and scope = 'tenant'`, [T]);
  const closed = await quoteStatus();
  check('owner switches quote requests off: override row stored, storefront endpoint closed', off.status === 200 && row?.enabled === false && closed === 403, `${off.status}, row=${row?.enabled}, quote→${closed}`);
  const on = await send('PUT', `${api}/admin/features`, { features: { quote_requests: true } });
  const overrideRows = await one<{ n: number }>(`select count(*)::int as n from feature_overrides where tenant_id = $1 and flag_key = 'quote_requests'`, [T]);
  const reopened = await quoteStatus();
  check('  → switched back on: row removed, endpoint open again', on.status === 200 && overrideRows?.n === 0 && reopened !== 403, `quote→${reopened}`);
  const stored = await one<{ m: string }>(`select pricing_config->>'marginMarkup' as m from tenant_settings where tenant_id = $1`, [T]);
  check('  → tenant_settings.pricing_config updated', Number(stored?.m) === markup, `${stored?.m}`);
  const after = await units();
  const before = new Map(cat.items.map((i) => [i.slug, i.unit]));
  check('  → storefront prices rise for every product', after.items.length === cat.items.length && after.items.every((i) => i.unit > (before.get(i.slug) ?? Infinity)));
  const audit = await one(`select count(*)::int as n from audit_log where tenant_id = $1 and at >= $2`, [T, started]);
  check('  → audit_log records admin activity', ((audit as { n?: number } | undefined)?.n ?? 0) > 0, `${(audit as { n?: number } | undefined)?.n} rows`);

  // 10. Team (ADR 0011): invite, last-owner guard, accept, promote, remove — through the real
  //     Next route (DELETE included), as the app role under RLS.
  type TeamDto = { members: { id: string; email: string; role: string; status: string; isYou: boolean }[] };
  const teamNow = async () => ((await (await call(`${api}/admin/team`)).json()) as TeamDto).members;
  const mateEmail = `teammate+${Date.now()}@acme.test`;
  // The demo tenant is on Pro; inviting is Enterprise ("Multi-user admin", §7).
  const lockedInv = await send('POST', `${api}/admin/team/invite`, { email: mateEmail, role: 'tenant_admin' });
  const lockedCode = ((await lockedInv.json()) as { error?: { code?: string } }).error?.code;
  check('Pro plan: inviting is refused (Enterprise feature)', lockedInv.status === 403 && lockedCode === 'feature_locked', `${lockedInv.status} ${lockedCode}`);
  const planBefore = (await one<{ plan_key: string }>(`select plan_key from tenants where id = $1`, [T]))?.plan_key ?? 'pro';
  await db.query(`update tenants set plan_key = 'enterprise' where id = $1`, [T]);
  restorePlan = async () => void (await db.query(`update tenants set plan_key = $2 where id = $1`, [T, planBefore]));
  await new Promise((r) => setTimeout(r, 5_500)); // the app caches tenant config for 5 s
  const inv = await send('POST', `${api}/admin/team/invite`, { email: mateEmail, role: 'tenant_admin' });
  const invBody = (await inv.json()) as { member?: { id: string; status: string }; emailSent?: boolean };
  check('team invite creates a pending member', inv.status === 201 && invBody.member?.status === 'invited', `${inv.status}, emailSent=${invBody.emailSent}`);
  const mateId = invBody.member?.id ?? '';
  const mateRow = await one<{ invited_by: string; last_sign_in_at: Date | null }>(`select invited_by, last_sign_in_at from users where tenant_id = $1 and id = $2`, [T, mateId]);
  const link = await one<{ hours: number }>(`select extract(epoch from (expires_at - created_at)) / 3600 as hours from admin_login_tokens where tenant_id = $1 and user_id = $2`, [T, mateId]);
  check('  → users row records the inviter; the invite link lasts 3 days', mateRow?.invited_by === user?.id && mateRow?.last_sign_in_at === null && Math.round(Number(link?.hours)) === 72, `${link?.hours} h`);

  const meId = (await teamNow()).find((m) => m.isYou)?.id ?? '';
  const selfDemote = await send('PUT', `${api}/admin/team/${meId}`, { role: 'tenant_admin' });
  check('the only owner cannot demote themselves', selfDemote.status === 409, String(selfDemote.status));

  const mateSecret = randomBytes(32).toString('base64url');
  await db.query(`insert into admin_login_tokens (tenant_id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 hour')`, [T, mateId, createHash('sha256').update(mateSecret, 'utf8').digest('hex')]);
  const mateVerify = await fetch(`${base}${api}/admin/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mateSecret }) });
  const mateCookie = (mateVerify.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  const mateMe = await fetch(`${base}${api}/admin/me`, { headers: { cookie: mateCookie } });
  const signedIn = await one<{ at: Date | null }>(`select last_sign_in_at as at from users where id = $1`, [mateId]);
  check('  → teammate signs in; first sign-in recorded', mateVerify.status === 200 && mateMe.status === 200 && !!signedIn?.at);

  const promote = await send('PUT', `${api}/admin/team/${mateId}`, { role: 'tenant_owner' });
  const promoted = await one<{ role: string }>(`select role from users where id = $1`, [mateId]);
  check('owner promotes the teammate', promote.status === 200 && promoted?.role === 'tenant_owner', String(promote.status));

  const remove = await call(`${api}/admin/team/${mateId}`, { method: 'DELETE' });
  const gone = await one<{ u: number; s: number }>(
    `select (select count(*) from users where id = $1)::int as u, (select count(*) from admin_sessions where user_id = $1)::int as s`,
    [mateId],
  );
  const mateAfter = await fetch(`${base}${api}/admin/me`, { headers: { cookie: mateCookie } });
  check('removal (HTTP DELETE) deletes the member and their sessions; their session dies at once', remove.status === 200 && gone?.u === 0 && gone?.s === 0 && mateAfter.status === 401, `${remove.status}, me→${mateAfter.status}`);
  const teamAudit = await one<{ n: number }>(`select count(*)::int as n from audit_log where tenant_id = $1 and action like 'team.%' and at >= $2`, [T, started]);
  check('  → invite, role change and removal are in the audit log', (teamAudit?.n ?? 0) >= 3, `${teamAudit?.n} entries`);

  // 10b. Tracked links + analytics (ADR 0014), through the production server.
  const mk = await send('POST', `${api}/admin/links`, { label: 'Smoke trade show', channel: 'event' });
  const made = (await mk.json()) as { link?: { id: string; code: string; url: string } };
  check('owner creates a tracked link', mk.status === 201 && /^[a-z2-9]{7}$/.test(made.link?.code ?? '') && made.link!.url === `${base}/t/demo/?src=${made.link!.code}`, `${mk.status} ${made.link?.url}`);
  const linkRow = await one<{ code: string }>(`select code from tracked_links where tenant_id = $1 and id = $2`, [T, made.link?.id]);
  check('  → tracked_links row', linkRow?.code === made.link?.code);
  // A separate prospect (its own cookie), arriving through the link and refreshing once.
  let prospect = '';
  for (let i = 0; i < 2; i++) {
    const v = await fetch(`${base}${api}/visit`, { method: 'POST', headers: { 'content-type': 'application/json', ...(prospect ? { cookie: prospect } : {}) }, body: JSON.stringify({ src: made.link?.code }) });
    if (i === 0) check('storefront visit beacon answers', v.status === 200, String(v.status));
    prospect ||= (v.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  }
  const attributed = await one<{ n: number }>(`select count(*)::int as n from prospect_sessions where tenant_id = $1 and link_id = $2`, [T, made.link?.id]);
  const visits = await one<{ n: number }>(`select count(*)::int as n from analytics_events where tenant_id = $1 and link_id = $2 and kind = 'visit'`, [T, made.link?.id]);
  check('  → session attributed to the link; the refresh adds no second visit', attributed?.n === 1 && visits?.n === 1, `sessions ${attributed?.n}, visits ${visits?.n}`);
  const an = await call(`${api}/admin/analytics?days=7`);
  const anBody = (await an.json()) as { summary?: { totals: { visit: number; lead: number }; byLink: { code: string | null; visit: number }[] } };
  check('analytics dashboard reports the link and the earlier lead', an.status === 200 && anBody.summary!.byLink.find((r) => r.code === made.link?.code)?.visit === 1 && anBody.summary!.totals.lead >= 1, `${an.status}`);
  const arch = await send('PUT', `${api}/admin/links/${made.link?.id}`, { archived: true });
  const archRow = await one<{ archived_at: Date | null }>(`select archived_at from tracked_links where tenant_id = $1 and id = $2`, [T, made.link?.id]);
  check('  → archiving sets archived_at', arch.status === 200 && !!archRow?.archived_at, String(arch.status));

  // 10c. Public REST API (ADR 0016): key lifecycle through the production server, as the app role.
  const mkKey = await send('POST', `${api}/admin/api-keys`, { name: 'Smoke CRM sync', scopes: ['leads:read'] });
  const keyBody = (await mkKey.json()) as { key?: { id: string; hint: string }; secret?: string };
  const apiSecret = keyBody.secret ?? '';
  // bck_<12-char key id>_<secret>; the secret is base64url and may itself contain '_'.
  const keyIdPart = apiSecret.slice(4, 16);
  const secretPart = apiSecret.slice(17);
  const keyRow = await one<{ key_id: string; secret_hash: string }>(`select key_id, secret_hash from api_keys where tenant_id = $1 and id = $2`, [T, keyBody.key?.id]);
  check('owner creates an API key; only a SHA-256 of the secret is stored',
    mkKey.status === 201 && keyRow?.key_id === keyIdPart && keyRow.secret_hash === createHash('sha256').update(secretPart, 'utf8').digest('hex') && !keyRow.secret_hash.includes(secretPart),
    `${mkKey.status} ${keyBody.key?.hint}`);
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const v1Leads = await fetch(`${base}${api}/v1/leads?limit=100`, bearer(apiSecret));
  const v1Body = (await v1Leads.json()) as { data?: { email: string }[] };
  check('  → GET v1/leads with the key returns the lead captured earlier', v1Leads.status === 200 && !!v1Body.data?.some((l) => l.email === email), `${v1Leads.status}, ${v1Body.data?.length} leads`);
  const [unscoped, anon] = await Promise.all([fetch(`${base}${api}/v1/products`, bearer(apiSecret)), fetch(`${base}${api}/v1/leads`)]);
  check('  → a scope the key lacks is 403; no key at all is 401', unscoped.status === 403 && anon.status === 401, `${unscoped.status}/${anon.status}`);
  const used = await one<{ at: Date | null }>(`select last_used_at as at from api_keys where id = $1`, [keyBody.key?.id]);
  check('  → api_keys.last_used_at recorded', !!used?.at);
  const rv = await send('POST', `${api}/admin/api-keys/${keyBody.key?.id}/revoke`, {});
  const rvRow = await one<{ at: Date | null }>(`select revoked_at as at from api_keys where id = $1`, [keyBody.key?.id]);
  const afterRevoke = await fetch(`${base}${api}/v1/leads`, bearer(apiSecret));
  check('  → revoked: revoked_at set and the key is refused at once', rv.status === 200 && !!rvRow?.at && afterRevoke.status === 401, `${rv.status}, then ${afterRevoke.status}`);

  // 10d. Supplier connections (ADR 0017), as the app role against the production build. The fake
  // supplier is refused in production, so the sync goes to an address that can't resolve: this
  // proves the Postgres repos, the inline worker and the failure path; the import itself is
  // covered by src/core/db/suppliers.test.ts.
  const supPassword = `smoke-${Date.now()}-secret`;
  const badSup = await send('POST', `${api}/admin/suppliers`, { name: 'Smoke supplier', productDataUrl: 'http://ps.smoke.example/pd', pricingUrl: 'https://ps.smoke.example/ppc', accountId: 'smoke', password: supPassword });
  const mkSup = await send('POST', `${api}/admin/suppliers`, { name: 'Smoke supplier', productDataUrl: 'https://ps.smoke.example/pd', pricingUrl: 'https://ps.smoke.example/ppc', accountId: 'smoke', password: supPassword });
  const supText = await mkSup.text();
  const supId = (JSON.parse(supText) as { supplier?: { id: string } }).supplier?.id;
  const supRow = await one<{ password_sealed: string; status: string }>(`select password_sealed, status from supplier_connections where tenant_id = $1 and id = $2`, [T, supId]);
  check('owner connects a supplier; only a sealed password is stored, none returned',
    badSup.status === 422 && mkSup.status === 201 && !supText.includes(supPassword) && !!supRow && supRow.password_sealed.startsWith('v1.') && !supRow.password_sealed.includes(supPassword) && supRow.status === 'never',
    `${badSup.status}/${mkSup.status}`);
  const productsBefore = await one<{ n: number }>(`select count(*)::int as n from products where tenant_id = $1 and active`, [T]);
  const syncRes = await send('POST', `${api}/admin/suppliers/${supId}/sync`, {});
  let synced: { status: string; err: string | null } | undefined;
  for (let i = 0; i < 40; i++) {
    synced = await one<{ status: string; err: string | null }>(`select status, last_sync->>'error' as err from supplier_connections where id = $1`, [supId]);
    if (synced && synced.status !== 'queued' && synced.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const productsAfter = await one<{ n: number }>(`select count(*)::int as n from products where tenant_id = $1 and active`, [T]);
  check('  → sync is queued, the inline worker runs it, and an unreachable supplier is a readable failure',
    syncRes.status === 202 && synced?.status === 'failed' && !!synced.err && synced.err.includes('ps.smoke.example') && productsAfter?.n === productsBefore?.n,
    `${syncRes.status}, ${synced?.status}: ${synced?.err?.slice(0, 80)}`);
  const delSup = await send('DELETE', `${api}/admin/suppliers/${supId}`, {});
  const supGone = await one<{ n: number }>(`select count(*)::int as n from supplier_connections where id = $1`, [supId]);
  check('  → removed: the connection and its sealed password are gone', delSup.status === 200 && supGone?.n === 0);

  // 11. Sign-out revokes the session server-side.
  const out = await send('POST', `${api}/admin/sign-out`, {});
  const revoked = await one(`select 1 from admin_sessions where tenant_id = $1 and user_id = $2 and revoked_at is not null`, [T, user?.id]);
  check('sign-out revokes the session in the database', out.status === 200 && !!revoked, String(out.status));

  // 12. Maintenance job (cron path) as the app role, under RLS: stale rows go, live ones stay.
  await db.query(
    `insert into admin_login_tokens (tenant_id, user_id, token_hash, expires_at, created_at) values ($1, $2, $3, now() - interval '3 days', now() - interval '3 days')`,
    [T, user?.id, createHash('sha256').update(`stale-${secret}`, 'utf8').digest('hex')],
  );
  await db.query(`insert into rate_limits (key_hash, window_start, count) values ($1, now() - interval '3 days', 1) on conflict do nothing`, [`stale-${randomBytes(8).toString('hex')}`]);
  await db.query(`insert into analytics_events (tenant_id, day, session_id, kind) values ($1, (now() - interval '401 days')::date, 'ancient-session', 'visit')`, [T]);
  const job = spawnSync(path.join('node_modules', '.bin', 'tsx'), ['scripts/jobs/maintenance.ts'], { env: { ...process.env, DATA_MODE: 'postgres' }, encoding: 'utf8' });
  const report = (() => { try { return JSON.parse(job.stdout.trim().split('\n').pop() ?? '{}') as { tokens?: number; rateWindows?: number; analyticsEvents?: number; errors?: unknown[] }; } catch { return {}; } })();
  check('npm run jobs:maintenance runs clean as the app role', job.status === 0 && Array.isArray(report.errors) && report.errors.length === 0, job.stdout.trim().slice(-160) || job.stderr.trim().slice(-160));
  const staleLeft = await one<{ n: number }>(`select count(*)::int as n from admin_login_tokens where tenant_id = $1 and expires_at < now() - interval '2 days'`, [T]);
  const oldWindows = await one<{ n: number }>(`select count(*)::int as n from rate_limits where window_start < now() - interval '2 days'`);
  check('  → expired tokens and old rate windows deleted', staleLeft?.n === 0 && oldWindows?.n === 0 && (report.tokens ?? 0) >= 1 && (report.rateWindows ?? 0) >= 1, `tokens ${report.tokens}, windows ${report.rateWindows}`);
  const ancient = await one<{ n: number }>(`select count(*)::int as n from analytics_events where tenant_id = $1 and session_id = 'ancient-session'`, [T]);
  check('  → funnel events older than 400 days deleted; recent ones kept', ancient?.n === 0 && (report.analyticsEvents ?? 0) >= 1 && (visits?.n ?? 0) === 1, `removed ${report.analyticsEvents}`);
  const recent = await one(`select 1 from admin_sessions where tenant_id = $1 and user_id = $2`, [T, user?.id]);
  check('  → a session signed out minutes ago is kept (7-day troubleshooting window)', !!recent);
  check('no overlapping queries on a pg connection (pg@9 removes them)', !/already executing a query/.test(serverLog));
} catch (e) {
  failures++;
  console.log(`FAIL  ${(e as Error).message}`);
} finally {
  await restorePlan?.().catch((e) => console.log(`WARN  could not restore the demo tenant's plan: ${(e as Error).message}`));
  server.kill('SIGTERM');
  await db.end().catch(() => {});
  await rm(storage, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed. Server log (last 40 lines):\n${serverLog.split('\n').slice(-40).join('\n')}`);
  process.exit(1);
}
console.log('\nPostgres smoke: all checks passed.');
process.exit(0);
