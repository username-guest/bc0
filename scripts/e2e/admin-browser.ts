/**
 * Browser end-to-end check of the REAL admin components (src/ui/admin) against the REAL API
 * (dev server) in headless Chromium: sign-in by emailed link, inbox, settings, webhook test,
 * failed delivery + manual retry, CSV, roles, plan limits, mobile.
 *
 *   BC_EXTRA_MODULES=<dir with react, react-dom, playwright> npm run e2e:admin
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { startDevServer, type StaticAsset } from '../dev-server';
import { loadTenantContext, publicTenantConfig } from '@/server/tenancy/context';
import { MemoryTenantDirectory } from '@/server/repos/memory';
import { fixtureTenants } from '@/server/testing';
import { MockEmailProvider } from '@/shared/providers/mocks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extra = process.env.BC_EXTRA_MODULES ?? path.join(root, 'node_modules');
const req = createRequire(path.join(extra, 'noop.js'));
const outDir = path.join(process.env.E2E_OUT ?? path.join(root, '.data/e2e'), 'admin');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let esbuild: typeof import('esbuild');
try {
  esbuild = req('esbuild');
} catch {
  esbuild = createRequire(req.resolve('tsx/package.json'))('esbuild');
}
const built = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/e2e/admin-entry.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser', // any server-only import fails the build
  jsx: 'automatic',
  minify: true,
  tsconfig: path.join(root, 'tsconfig.json'),
  nodePaths: [extra],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const js = built.outputFiles[0]!.text;
const css = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');

const dir = new MemoryTenantDirectory(fixtureTenants());
const page = async (ref: string): Promise<StaticAsset> => {
  const cfg = publicTenantConfig((await loadTenantContext(ref, dir))!);
  return {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.__BC_CONFIG__=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script><script type="module" src="/admin.js"></script></body></html>`,
  };
};

// A webhook receiver the admin can point at.
const received: { type: string; sig: string }[] = [];
const rx = createServer((r, res) => {
  let body = '';
  r.on('data', (c) => (body += c));
  r.on('end', () => {
    received.push({ type: JSON.parse(body).type, sig: String(r.headers['x-brandcanvas-signature']) });
    res.end('ok');
  });
});
await new Promise<void>((r) => rx.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${(rx.address() as AddressInfo).port}/hook`;

const mail = new MockEmailProvider();
const server = await startDevServer({
  port: 0,
  storageDir: path.join(outDir, 'storage'),
  email: mail,
  publicBaseUrl: 'https://links.example', // links are built from config; we swap in the test origin
  allowInsecureWebhooks: true, // http receiver on loopback (tests only)
  staticAssets: {
    '/t/demo/admin': await page('demo'),
    '/t/demo/admin/verify': await page('demo'),
    '/t/basic/admin': await page('basic'),
    '/t/basic/admin/verify': await page('basic'),
    '/t/bigco/admin': await page('bigco'), // Enterprise: team invites (ADR 0011)
    '/t/bigco/admin/verify': await page('bigco'),
    '/admin.js': { type: 'text/javascript', body: js },
    '/app.css': { type: 'text/css', body: css },
  },
});
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

let failures = 0;
/**
 * iOS Safari zooms the page when a text field under 16px gets focus, and doesn't zoom back.
 * Lists visible text-entry controls rendering below 16px at phone width (empty = fine).
 */
const smallControls = (pg: import('playwright').Page) =>
  pg.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('input:not([type=radio]):not([type=checkbox]):not([type=color]):not([type=file]):not([type=hidden]):not([type=range]), select, textarea'))
      .filter((el) => el.getClientRects().length > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''}=${getComputedStyle(el).fontSize}`),
  );

const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Storefront traffic: a prospect giving their email (as the real form would). */
async function capture(email: string) {
  const r = await fetch(`${base}/api/t/demo/leads/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, startedAt: Date.now() - 5000, website: '' }),
  });
  if (r.status !== 201) throw new Error(`capture ${email}: ${r.status}`);
}

async function linkFor(address: string): Promise<string> {
  const before = mail.sent.length;
  for (let i = 0; i < 50 && mail.sent.filter((m) => m.to === address).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const m = [...mail.sent].reverse().find((x) => x.to === address);
  if (!m) throw new Error(`no email for ${address} (had ${before})`);
  return /https:\/\/links\.example(\S+)/.exec(m.text)![1]!;
}

/** The innermost elements whose right edge passes the 390 px device width (overflow diagnostics). */
const culprits = (pg: import('playwright').Page) =>
  pg.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.right <= 391 || r.width === 0) continue;
      if (Array.from(el.children).some((c) => c.getBoundingClientRect().right > 391)) continue; // report the leaf
      out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}→${Math.round(r.right)}`);
    }
    return out.slice(0, 6).join(', ');
  });

const pw = req('playwright') as typeof import('playwright');
/** E2E_BROWSER=webkit runs the same suite in Safari's engine (WebKit); firefox also works. */
const engineName = (process.env.E2E_BROWSER ?? 'chromium') as 'chromium' | 'webkit' | 'firefox';
if (!['chromium', 'webkit', 'firefox'].includes(engineName)) throw new Error(`E2E_BROWSER must be chromium, webkit or firefox (got ${engineName})`);
console.log(`Engine: ${engineName}`);
const browser = await pw[engineName].launch();
const errors: string[] = [];
const watch = (p: import('playwright').Page) => {
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Chromium logs every 4xx. Expected here: 401 (signed-out /admin/me probe), 400 (the deliberate
  // link-reuse check), 422 (the deliberate invalid colour) and 409 (the deliberate duplicate
  // invite). Anything else is a real error.
  p.on('console', (m) => m.type() === 'error' && !/status of (400|401|409|422)\b/.test(m.text()) && errors.push(`console: ${m.text()}`));
};

async function signIn(p: import('playwright').Page, ref: string, address: string) {
  mail.sent.length = 0;
  await p.goto(`${base}/t/${ref}/admin`);
  await p.fill('#admin-email', address);
  await p.click('button:has-text("Email me a sign-in link")');
  await p.waitForSelector('.admin-sent');
  const link = await linkFor(address);
  await p.goto(`${base}${link}`);
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('.admin-tabs');
}

try {
  await capture('ann@acme.test');
  await capture('bo@bolt.test');

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  watch(p);

  // ---- sign-in
  await p.goto(`${base}/t/demo/admin`);
  await p.waitForSelector('#admin-email');
  check('signed-out admin shows the sign-in form', (await p.textContent('h1'))!.includes('Sign in'));
  await p.fill('#admin-email', 'owner@demo.test');
  await p.click('button:has-text("Email me a sign-in link")');
  await p.waitForSelector('.admin-sent');
  const link = await linkFor('owner@demo.test');
  check('emailed link points at the tenant admin, token in the fragment', /^\/t\/demo\/admin\/verify#token=[\w-]{43}$/.test(link), link.slice(0, 40));
  await p.goto(`${base}${link}`);
  await p.waitForSelector('button:has-text("Sign in")');
  check('verify page removes the token from the address bar', !(p.url().includes('token=')));
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('.admin-tabs');
  check('signed in: lands on the admin with the user shown', (await p.textContent('.admin-who'))!.includes('owner@demo.test') && p.url().endsWith('/t/demo/admin'));
  const cookies = await ctx.cookies();
  const adminCookie = cookies.find((c) => c.name.startsWith('bc_admin_'));
  check('admin cookie is HttpOnly + SameSite=Lax', !!adminCookie?.httpOnly && adminCookie?.sameSite === 'Lax');
  const reused = await p.evaluate(async (l) => (await fetch(`/api/t/demo/admin/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: l.split('#token=')[1] }) })).status, link);
  check('the link cannot be used twice', reused === 400, String(reused));

  // ---- inbox
  await p.waitForSelector('.lead-row');
  check('inbox lists both storefront leads, newest first', (await p.locator('.lead-row').allTextContents()).map((t) => t.includes('bo@bolt.test') ? 'bo' : t.includes('ann') ? 'ann' : '?').join() === 'bo,ann');
  await p.fill('#lead-search', 'acme');
  await p.click('button:has-text("Search")');
  await p.waitForFunction(() => document.querySelectorAll('.lead-row').length === 1);
  check('search narrows the list', (await p.textContent('.lead-row'))!.includes('ann@acme.test'));
  await p.click('.lead-row');
  await p.waitForSelector('.lead-pane .timeline');
  check('lead detail shows what they did', (await p.textContent('.timeline'))!.includes('Gave their email'));
  await p.screenshot({ path: path.join(outDir, 'inbox-desktop.png'), fullPage: true });

  // ---- settings: gate + look
  await p.click('.admin-tabs button:has-text("Settings")');
  await p.waitForSelector('#g-free');
  await p.check('input[name="gate-mode"][value="soft"]');
  await p.fill('#g-free', '2');
  await p.click('button:has-text("Save gate")');
  await p.waitForSelector('text=The gate change is live');
  const cfg1 = await (await fetch(`${base}/api/t/demo/config`)).json();
  check('gate change reaches the storefront', JSON.stringify(cfg1).includes('"mode":"soft"') && JSON.stringify(cfg1).includes('"freeProducts":2'));
  await p.fill('#b-name', 'Demo Promo & Co');
  await p.fill('#b-primaryHex', '#7A1F5C');
  await p.click('button:has-text("Save look")');
  await p.waitForSelector('text=Your storefront now uses this look');
  const cfg2 = await (await fetch(`${base}/api/t/demo/config`)).json();
  check('look change reaches the storefront', cfg2.branding.displayName === 'Demo Promo & Co' && cfg2.branding.primaryHex === '#7A1F5C');
  await p.fill('#b-primaryHex', 'purple');
  await p.click('button:has-text("Save look")');
  await p.waitForSelector('#b-primaryHex[aria-invalid="true"]');
  check('invalid colour is flagged on the field', (await p.textContent('.settings-section >> nth=0'))!.includes('hex colour'));

  // ---- settings: webhook
  await p.check('input[name="routing"] >> nth=1');
  await p.fill('#r-url', hookUrl);
  await p.click('button:has-text("Save destination")');
  await p.waitForSelector('.secret-once input');
  const secret = await p.inputValue('.secret-once input');
  check('signing secret is shown once after saving a webhook', /^whsec_[\w-]{43}$/.test(secret));
  await p.click('button:has-text("Send a test")');
  await p.waitForSelector('text=Test delivered');
  check('"Send a test" reaches the receiver as a signed ping', received.some((r) => r.type === 'ping' && r.sig.startsWith('t=')));
  await p.reload();
  await p.click('.admin-tabs button:has-text("Settings")');
  await p.waitForSelector('#r-url');
  check('secret is not shown again after reload', (await p.locator('.secret-once').count()) === 0 && !(await p.content()).includes(secret));
  // ---- storefront feature switches (ADR 0013)
  const quoteStatus = async () => (await fetch(`${base}/api/t/demo/leads/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  check('features: quote requests start on (storefront endpoint open)', (await quoteStatus()) !== 403);
  await p.uncheck('input[name="feature-quote_requests"]');
  await p.click('button:text-is("Save features")');
  await p.waitForSelector('.saved:has-text("Your storefront is updated")');
  check('features: switching quote requests off closes the storefront endpoint', (await quoteStatus()) === 403);
  await p.check('input[name="feature-quote_requests"]');
  await p.click('button:text-is("Save features")');
  await p.waitForSelector('.saved:has-text("Your storefront is updated")');
  check('features: switching it back on reopens it', (await quoteStatus()) !== 403);
  await p.screenshot({ path: path.join(outDir, 'settings-desktop.png'), fullPage: true });

  // ---- failed delivery → retry
  await p.fill('#r-url', 'http://127.0.0.1:9/down');
  await p.click('button:has-text("Save destination")');
  await p.waitForSelector('text=Saved.');
  await capture('lost@acme.test');
  await p.click('.admin-tabs button:has-text("Leads")');
  await p.click('.chip-attention');
  await p.waitForFunction(() => document.querySelectorAll('.lead-row').length === 1);
  check('"Needs attention" shows the failed delivery with a Retrying stamp', (await p.textContent('.lead-row'))!.includes('lost@acme.test') && (await p.textContent('.lead-row .stamp')) === 'Retrying');
  await p.click('.lead-row');
  await p.waitForSelector('button:has-text("Retry now")');
  // Fix the destination through the API (same session), then retry by hand from the pane.
  await p.evaluate(async (url) => {
    const me = await (await fetch('/api/t/demo/admin/me')).json();
    await fetch('/api/t/demo/admin/settings/routing', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }, body: JSON.stringify({ provider: 'webhook', url }) });
  }, hookUrl);
  await p.click('button:has-text("Retry now")');
  await p.waitForSelector('.deliveries .stamp.is-sent');
  check('manual retry delivers it: stamp turns to Sent to CRM', received.filter((r) => r.type === 'lead.created').length === 1);
  await p.click('.chip-attention'); // back to all leads
  await p.waitForFunction(() => document.querySelectorAll('.lead-row').length === 3);
  const stamps = await p.$$eval('.lead-row', (rows) => rows.map((r) => [r.textContent!.match(/\S+@\S+?\.test/)![0], r.querySelector('.stamp')?.textContent ?? '']));
  check('only the CRM-delivered lead is stamped; inbox-only leads are not', JSON.stringify(stamps) === JSON.stringify([['lost@acme.test', 'Sent to CRM'], ['bo@bolt.test', ''], ['ann@acme.test', '']]), JSON.stringify(stamps));

  // ---- CSV
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('a:has-text("Export CSV")')]);
  const csv = await readFile((await dl.path())!, 'utf8');
  check('CSV export downloads every lead', dl.suggestedFilename().startsWith('leads-demo-') && ['ann@acme.test', 'bo@bolt.test', 'lost@acme.test'].every((e) => csv.includes(e)));

  // ---- pricing
  const units = async () =>
    Object.fromEntries(((await (await fetch(`${base}/api/t/demo/catalog?qty=144`)).json()).items as { slug: string; unit: number }[]).map((i) => [i.slug, i.unit]));
  const before = await units();
  await p.click('.admin-tabs button:has-text("Pricing")');
  await p.waitForSelector('.ticket-rows li');
  check('pricing: preview prices every product and flags placeholder rates',
    (await p.locator('.ticket-rows li').count()) === 6 && (await p.textContent('.pricing-form'))!.includes('placeholder rates'));
  await p.fill('#px-margin', '80');
  await p.waitForSelector('.ticket-delta');
  check('pricing: markup shows its margin equivalent', (await p.textContent('.px-field:has(#px-margin)'))!.includes('= 44.4% gross margin'));
  check('pricing: preview shows the change before saving', (await p.locator('.ticket-delta').count()) === 6 && JSON.stringify(await units()) === JSON.stringify(before));
  await p.fill('#px-ltm', 'lots');
  await p.waitForSelector('#px-ltm[aria-invalid="true"]');
  check('pricing: a bad amount is flagged on its field', (await p.textContent('.ticket'))!.includes('Fix the highlighted fields'));
  await p.fill('#px-ltm', '75');
  await p.waitForSelector('#px-ltm[aria-invalid="false"], #px-ltm:not([aria-invalid="true"])');
  await p.click('.ticket-rows li >> nth=0 >> summary');
  const firstRow = (await p.textContent('.ticket-rows li >> nth=0'))!;
  check('pricing: breakdown shows selling prices only (no cost or margin)', firstRow.includes('Products (144') && !/Margin|Blanks/.test(firstRow));
  await p.click('button:has-text("Save pricing")');
  await p.waitForSelector('text=Your storefront shows these prices now');
  const after = await units();
  check('pricing: saved prices reach the storefront', Object.keys(before).every((k) => after[k]! > before[k]!));
  const disc = (await (await fetch(`${base}/api/t/demo/catalog?qty=144`)).json()).disclaimer as string;
  check("pricing: storefront disclaimer no longer says placeholder", disc.includes("this distributor's rate tables"));
  await p.screenshot({ path: path.join(outDir, 'pricing-desktop.png'), fullPage: true });

  // ---- team (ADR 0011). Demo is on Pro: inviting is Enterprise ("Multi-user admin", §7).
  await p.click('.admin-tabs button:has-text("Team")');
  await p.waitForSelector('.team-row');
  check('Pro: invite explains the Enterprise plan; roles and removal still available',
    (await p.textContent('.team'))!.includes('available on the Enterprise plan') && (await p.locator('#t-email').count()) === 0 &&
      !(await p.locator('.team-row:has-text("staff@demo.test") select').isDisabled()) &&
      (await p.locator('button:text-is("Email an invite")').count()) === 0);

  // Enterprise owner: the full invite flow.
  const b = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(b);
  await signIn(b, 'bigco', 'owner@bigco.test');
  await b.click('.admin-tabs button:has-text("Team")');
  await b.waitForSelector('.team-row');
  const rows = await b.locator('.team-row .team-email').allTextContents();
  check('team lists everyone with access', rows.join(',') === 'owner@bigco.test,staff@bigco.test', rows.join(','));
  check('the only owner cannot demote themselves (control disabled)', await b.locator('.team-row:has-text("owner@bigco.test") select').isDisabled());
  await b.fill('#t-email', 'newbie@bigco.test');
  await b.click('button[type="submit"]:text-is("Send invite")');
  await b.waitForSelector('.saved:has-text("Invite sent to newbie@bigco.test")');
  check('invite: confirmation and an "Invited" row', await b.locator('.team-row:has-text("newbie@bigco.test") .tag-pending').isVisible());
  check('seeded accounts are not labelled "Invited"', (await b.locator('.team-row:has-text("staff@bigco.test") .tag-pending').count()) === 0 && (await b.locator('.team-row:has-text("staff@bigco.test") button:text-is("Email an invite")').count()) === 1);
  await b.fill('#t-email', 'STAFF@bigco.test');
  await b.click('button[type="submit"]:text-is("Send invite")');
  await b.waitForSelector('.error:has-text("already has access")');
  check('duplicate invite explained', true);
  await b.screenshot({ path: path.join(outDir, 'team-desktop.png'), fullPage: true });

  const newbie = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(newbie);
  await newbie.goto(`${base}${await linkFor('newbie@bigco.test')}`);
  await newbie.click('button:has-text("Sign in")');
  await newbie.waitForSelector('.admin-tabs');
  await newbie.click('.admin-tabs button:has-text("Team")');
  await newbie.waitForSelector('.team-row');
  check('invitee signs in from the email and sees a read-only team',
    (await newbie.textContent('.team'))!.includes('Only owners can invite') && (await newbie.locator('#t-email').count()) === 0 && (await newbie.locator('.team-row select').count()) === 0);

  await b.click('.admin-tabs button:has-text("Leads")');
  await b.click('.admin-tabs button:has-text("Team")');
  await b.waitForSelector('.team-row:has-text("newbie@bigco.test") .team-meta:has-text("Last signed in")');
  check('owner sees the invitee became active', true);
  await b.selectOption('.team-row:has-text("staff@bigco.test") select', 'tenant_owner');
  await b.waitForSelector('.saved:has-text("staff@bigco.test is now an owner")');
  check('promotion: with two owners, your own role can change', !(await b.locator('.team-row:has-text("owner@bigco.test") select').isDisabled()));
  await b.selectOption('.team-row:has-text("staff@bigco.test") select', 'tenant_admin');
  await b.waitForSelector('.saved:has-text("staff@bigco.test is now an admin")');

  await b.click('.team-row:has-text("newbie@bigco.test") .team-actions button:text-is("Remove")');
  await b.waitForSelector('.team-confirm');
  await b.click('.team-confirm button:text-is("Remove")');
  await b.waitForSelector('.saved:has-text("newbie@bigco.test no longer has access")');
  await newbie.reload();
  await newbie.waitForSelector('#admin-email');
  check('removed person is signed out on their next page load', (await b.locator('.team-row:has-text("newbie@bigco.test")').count()) === 0);

  // ---- API keys (ADR 0016): Enterprise owners, in Settings.
  await b.click('.admin-tabs button:has-text("Settings")');
  await b.waitForSelector('#k-name');
  const apiBase = (await b.textContent('.api-base'))!;
  check('API keys: the base URL comes from configuration', apiBase === 'https://links.example/api/t/bigco/v1', apiBase);
  await b.fill('#k-name', 'Warehouse sync');
  await b.check('input[name="key-scope"][value="catalog:read"]');
  await b.click('button[type="submit"]:text-is("Create key")');
  await b.waitForSelector('.secret-once');
  const apiKey = await b.inputValue('#fresh-key');
  check('API keys: the new key is shown once, with the warning', /^bck_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/.test(apiKey) && (await b.textContent('.secret-once'))!.includes('won’t be shown again'));
  // Call exactly the URL shown (on this server's origin), so the advertised URL is what's tested.
  const apiGet = (p: string) => fetch(`${apiBase.replace('https://links.example', base)}/${p}`, { headers: { authorization: `Bearer ${apiKey}` } });
  const prods = await apiGet('products?qty=144');
  const leadsRes = await apiGet('leads');
  const analyticsRes = await apiGet('analytics');
  check('API keys: the key reads what it was given, and only that', prods.status === 200 && leadsRes.status === 200 && analyticsRes.status === 403, `${prods.status}/${leadsRes.status}/${analyticsRes.status}`);
  await b.click('button:text-is("I’ve saved it")');
  await b.waitForSelector('.secret-once', { state: 'detached' });
  await b.click('.admin-tabs button:has-text("Leads")');
  await b.click('.admin-tabs button:has-text("Settings")');
  await b.waitForSelector('.api-keys .an-link:has-text("Warehouse sync")');
  const keyRow = (await b.textContent('.api-keys .an-link:has-text("Warehouse sync")'))!;
  check('API keys: afterwards the list shows only a hint, never the secret', keyRow.includes(`${apiKey.slice(0, 17)}…`) && !(await b.content()).includes(apiKey.slice(17)) && keyRow.includes('Last used'), keyRow.slice(0, 120));
  await b.click('.api-keys .an-link:has-text("Warehouse sync") button:text-is("Revoke")');
  await b.waitForSelector('.api-keys .team-confirm');
  await b.click('.api-keys .team-confirm button:text-is("Revoke")');
  await b.waitForSelector('.api-keys .an-link:has-text("Warehouse sync") .tag:text-is("Revoked")');
  check('API keys: a revoked key stops working at once', (await apiGet('products')).status === 401);
  await b.screenshot({ path: path.join(outDir, 'api-keys-desktop.png'), fullPage: true });

  // ---- Suppliers (ADR 0017): an Enterprise owner connects the built-in fake supplier and syncs.
  const catalogSlugs = async () =>
    ((await (await fetch(`${base}/api/t/bigco/catalog?qty=144`)).json()) as { items: Array<{ slug: string }> }).items.map((i) => i.slug);
  check('Suppliers: nothing imported yet', !(await catalogSlugs()).includes('supplier-heavy-cotton-tee'));
  await b.click('button:text-is("Connect a supplier")');
  await b.fill('#sup-name', 'Acme Promo');
  await b.fill('#sup-productDataUrl', 'http://promostandards.example/ProductData/v2');
  await b.fill('#sup-pricingUrl', 'https://promostandards.example/PricingAndConfiguration/v1');
  await b.fill('#sup-accountId', 'acme-dist');
  await b.fill('#sup-password', 'correct horse');
  await b.click('.sup-form button[type="submit"]');
  await b.waitForSelector('#sup-productDataUrl-err');
  check('Suppliers: an insecure address is refused, next to the field', (await b.textContent('#sup-productDataUrl-err'))!.includes('must use https') && (await b.getAttribute('#sup-productDataUrl', 'aria-invalid')) === 'true');
  await b.fill('#sup-productDataUrl', 'https://promostandards.example/ProductData/v2');
  await b.click('.sup-form button[type="submit"]');
  await b.waitForSelector('.suppliers .an-link:has-text("Acme Promo") .sup-status:text-is("Not synced yet")');
  const supRow = '.suppliers .an-link:has-text("Acme Promo")';
  check('Suppliers: connected; the password is nowhere on the page', !(await b.content()).includes('correct horse') && (await b.textContent(supRow))!.includes('acme-dist'));

  await b.click(`${supRow} button:text-is("Sync now")`);
  await b.waitForSelector(`${supRow} .sup-status:text-is("Up to date")`, { timeout: 20_000 });
  const summary = (await b.textContent(`${supRow} .sup-summary`))!;
  check('Suppliers: sync reports what came in and what was left out', /2 products added, 0 updated/.test(summary) && summary.includes('1 not imported'), summary.trim());
  await b.click(`${supRow} .sup-notes summary`);
  const supNotes = (await b.textContent(`${supRow} .sup-notes ul`))!;
  check('Suppliers: the reasons are readable', supNotes.includes('8 GB Swivel USB Drive') && supNotes.includes('Athletic Heather') && supNotes.includes('4CP Full Color'));
  const slugs = await catalogSlugs();
  check('Suppliers: imported products are in the storefront catalog', slugs.includes('supplier-heavy-cotton-tee') && slugs.includes('20-oz-recycled-steel-tumbler'));
  await b.screenshot({ path: path.join(outDir, 'suppliers-desktop.png'), fullPage: true });

  // Edit without retyping the password: it's kept, and the next sync still authenticates.
  await b.click(`${supRow} button:text-is("Edit")`);
  check('Suppliers: editing never shows the saved password', (await b.inputValue('#sup-password')) === '' && (await b.getAttribute('#sup-password', 'placeholder'))!.includes('keep the saved password'));
  await b.fill('#sup-productIds', 'PS-TEE-100');
  await b.click('.sup-form button[type="submit"]');
  await b.waitForSelector('.saved:has-text("Saved “Acme Promo”")');
  await b.click(`${supRow} button:text-is("Sync now")`);
  await b.waitForSelector(`${supRow} .sup-summary:has-text("1 hidden")`, { timeout: 20_000 });
  const narrowed = await catalogSlugs();
  check('Suppliers: narrowing to picked products hides the others', narrowed.includes('supplier-heavy-cotton-tee') && !narrowed.includes('20-oz-recycled-steel-tumbler'));

  await b.click(`${supRow} button:text-is("Remove")`);
  await b.click('.suppliers .team-confirm button:text-is("Remove")');
  await b.waitForSelector('.saved:has-text("Removed “Acme Promo”")');
  check('Suppliers: removing the connection takes its products off the storefront', !(await catalogSlugs()).includes('supplier-heavy-cotton-tee'));

  // ---- sign out
  await p.click('button:has-text("Sign out")');
  await p.waitForSelector('#admin-email');
  await p.reload();
  await p.waitForSelector('#admin-email');
  check('sign-out ends the session (still signed out after reload)', true);

  // ---- roles and plans
  const staff = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(staff);
  await signIn(staff, 'demo', 'staff@demo.test');
  await staff.click('.admin-tabs button:has-text("Settings")');
  await staff.waitForSelector('text=Only the account owner can change this');
  await staff.click('.admin-tabs button:has-text("Pricing")');
  await staff.waitForSelector('.ticket-rows li');
  check('non-owner admin can explore pricing but not save it',
    (await staff.textContent('.pricing-form'))!.includes('Only the account owner can save') && (await staff.locator('button:has-text("Save pricing")').count()) === 0 && (await staff.locator('#px-margin').isDisabled()));
  await staff.click('.admin-tabs button:has-text("Settings")');
  check('non-owner admin sees feature switches read-only', (await staff.locator('input[name="feature-quote_requests"]').isDisabled()) && (await staff.locator('button:text-is("Save features")').count()) === 0);
  check('non-owner admin cannot edit lead destination', (await staff.locator('input[name="routing"] >> nth=0').isDisabled()) && (await staff.locator('button:has-text("Save destination")').isDisabled()));

  const free = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(free);
  await signIn(free, 'basic', 'owner@basic.test');
  await free.click('.admin-tabs button:has-text("Settings")');
  await free.waitForSelector('text=Upgrade to Starter');
  check('Free plan: look locked, CRM option explains Pro', (await free.locator('#b-name').isDisabled()) && (await free.textContent('.settings'))!.includes('Available on the Pro plan'));
  await free.locator('.settings-section:has-text("Storefront features")').screenshot({ path: path.join(outDir, 'features-free.png') });
  check('Free plan: quote requests switch explains Starter', (await free.locator('input[name="feature-quote_requests"]').isDisabled()) && (await free.textContent('.settings'))!.includes('Available on the Starter plan'));
  await free.click('.admin-tabs button:has-text("Pricing")');
  await free.waitForSelector('text=Upgrade to Starter to set your own markups');
  check('Free plan: pricing explains the upgrade', true);
  check('Free plan inbox is empty with guidance', (await free.click('.admin-tabs button:has-text("Leads")'), await free.waitForSelector('.inbox-empty'), (await free.textContent('.inbox-empty'))!.includes('No leads yet')));

  // ---- analytics + tracked links (ADR 0014). Demo is on Pro: both features included.
  await signIn(p, 'demo', 'owner@demo.test'); // an earlier step signed this page out
  await p.click('.admin-tabs button:has-text("Analytics")');
  await p.waitForSelector('.an-totals');
  await p.fill('#l-label', 'Spring trade show');
  await p.selectOption('#l-channel', 'event');
  await p.click('button[type="submit"]:text-is("Create link")');
  await p.waitForSelector('.saved:has-text("Created “Spring trade show”")');
  const linkUrl = await p.inputValue('.an-link:has-text("Spring trade show") .an-url input');
  const code = new URL(linkUrl).searchParams.get('src') ?? '';
  check('analytics: a new link is a storefront URL with its own code', linkUrl.startsWith('https://links.example/t/demo/?src=') && /^[a-z2-9]{7}$/.test(code), linkUrl);
  // A prospect arrives through it and refreshes: the storefront's page-load beacon, twice.
  let prospectCookie = '';
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/api/t/demo/visit`, { method: 'POST', headers: { 'content-type': 'application/json', ...(prospectCookie ? { cookie: prospectCookie } : {}) }, body: JSON.stringify({ src: code }) });
    prospectCookie ||= (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  await p.click('.admin-tabs button:has-text("Leads")');
  await p.click('.admin-tabs button:has-text("Analytics")');
  await p.waitForSelector('.an-table tr:has-text("Spring trade show")');
  const cells = await p.locator('.an-table tr:has-text("Spring trade show") td').allTextContents();
  check('analytics: the visit is credited to the link, and the refresh is not double-counted', JSON.stringify(cells) === JSON.stringify(['1', '0', '0', '0%']), JSON.stringify(cells));
  // The 3 storefront leads from earlier arrived without the page beacon; becoming a lead counts
  // as that day's visit, so they show as direct visitors and no rate passes 100%.
  const direct = await p.locator('.an-table tr:has-text("Direct / no link") td').allTextContents();
  check('analytics: leads count as visitors too (direct 3 of 3, never over 100%)', JSON.stringify(direct) === JSON.stringify(['3', '0', '3', '100%']), JSON.stringify(direct));
  check('analytics: the totals add up', (await p.textContent('.an-totals div:first-child dd'))!.trim() === '4');
  check('analytics: the chart describes itself for screen readers', /^Visitors per day\. 4 visitors, 0 saw a proof, 3 became leads/.test((await p.getAttribute('.an-chart svg', 'aria-label')) ?? ''));
  await p.click('.an-link:has-text("Spring trade show") button:text-is("Copy")');
  await p.waitForSelector('.an-link:has-text("Spring trade show") :is(.saved, .error)');
  check('analytics: Copy answers either way (copied, or how to copy by hand)', true);
  await p.click('.an-link:has-text("Spring trade show") button:text-is("Archive")');
  await p.waitForSelector('button:text-is("Show 1 archived")');
  check('analytics: archiving hides the link from the list but keeps its results', (await p.locator('.an-link:has-text("Spring trade show")').count()) === 0 && (await p.locator('.an-table tr:has-text("Spring trade show")').count()) === 1);
  await p.click('button:text-is("Show 1 archived")');
  await p.click('.an-link:has-text("Spring trade show") button:text-is("Restore")');
  await p.waitForSelector('.saved:has-text("Its link works again")');
  await p.screenshot({ path: path.join(outDir, 'analytics-desktop.png'), fullPage: true });

  const f = free; // still signed in to the Free-plan tenant from above
  await f.click('.admin-tabs button:has-text("Analytics")');
  await f.waitForSelector('.analytics .note >> nth=1');
  const notes = await f.locator('.analytics .note').allTextContents();
  check('Free plan: analytics and links explain the Pro plan, no create form',
    notes.some((t) => t.includes('dashboard is available on the Pro plan')) && notes.some((t) => t.includes('Tracked links are available on the Pro plan')) && (await f.locator('#l-label').count()) === 0,
    notes.join(' | '));

  // ---- mobile
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: engineName !== 'firefox', hasTouch: true })).newPage();
  watch(m);
  await m.goto(`${base}/t/demo/admin`);
  await m.waitForSelector('#admin-email');
  const phoneSmall: string[] = (await smallControls(m)).map((x) => `sign-in: ${x}`);
  await signIn(m, 'demo', 'owner@demo.test');
  await m.waitForSelector('.lead-row');
  phoneSmall.push(...(await smallControls(m)).map((x) => `inbox: ${x}`));
  const edge_inbox = await culprits(m);
  check('mobile inbox: nothing past the screen edge, even inside scrolling boxes', !edge_inbox, edge_inbox);
  const overflow = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile: no horizontal overflow', overflow <= 0, `${overflow}px`);
  await m.screenshot({ path: path.join(outDir, 'inbox-mobile.png') });
  await m.click('.lead-row');
  await m.waitForSelector('.lead-pane');
  check('mobile: detail replaces the list', !(await m.locator('.inbox-list').isVisible()));
  await m.screenshot({ path: path.join(outDir, 'lead-mobile.png'), fullPage: true });
  await m.click('button:has-text("Back to leads")');
  check('mobile: back returns to the list', await m.locator('.inbox-list').isVisible());
  await m.click('.admin-tabs button:has-text("Settings")');
  await m.waitForSelector('#r-url');
  const o2 = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile settings: no horizontal overflow', o2 <= 0, `${o2}px`);
  phoneSmall.push(...(await smallControls(m)).map((x) => `settings: ${x}`));
  const edge_settings = await culprits(m);
  check('mobile settings: nothing past the screen edge, even inside scrolling boxes', !edge_settings, edge_settings);
  await m.screenshot({ path: path.join(outDir, 'settings-mobile.png'), fullPage: true });
  await m.click('.admin-tabs button:has-text("Pricing")');
  await m.waitForSelector('.ticket-rows li');
  const o3 = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile pricing: no horizontal overflow', o3 <= 0, o3 > 0 ? `${o3}px: ${await culprits(m)}` : `${o3}px`);
  phoneSmall.push(...(await smallControls(m)).map((x) => `pricing: ${x}`));
  const edge_pricing = await culprits(m);
  check('mobile pricing: nothing past the screen edge, even inside scrolling boxes', !edge_pricing, edge_pricing);
  await m.screenshot({ path: path.join(outDir, 'pricing-mobile.png'), fullPage: true });
  await m.click('.admin-tabs button:has-text("Team")');
  await m.waitForSelector('.team-row');
  await m.click('.team-row:has-text("staff@demo.test") .team-actions button:text-is("Remove")');
  await m.waitForSelector('.team-confirm');
  const o4 = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile team (confirm open): no horizontal overflow', o4 <= 0, o4 > 0 ? `${o4}px: ${await culprits(m)}` : `${o4}px`);
  await m.screenshot({ path: path.join(outDir, 'team-mobile.png'), fullPage: true });
  await m.click('.team-confirm button:has-text("Cancel")');
  check('mobile: cancel keeps them', (await m.locator('.team-row:has-text("staff@demo.test")').count()) === 1);
  phoneSmall.push(...(await smallControls(m)).map((x) => `team: ${x}`));
  const edge_team = await culprits(m);
  check('mobile team: nothing past the screen edge, even inside scrolling boxes', !edge_team, edge_team);
  await m.click('.admin-tabs button:has-text("Analytics")');
  await m.waitForSelector('.an-table tr:has-text("Spring trade show")');
  const o5 = await m.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile analytics: no horizontal overflow', o5 <= 0, o5 > 0 ? `${o5}px: ${await culprits(m)}` : `${o5}px`);
  const edge_analytics = await culprits(m);
  check('mobile analytics: nothing past the screen edge, even the results table', !edge_analytics, edge_analytics);
  phoneSmall.push(...(await smallControls(m)).map((x) => `analytics: ${x}`));
  await m.screenshot({ path: path.join(outDir, 'analytics-mobile.png'), fullPage: true });
  check('iOS: every admin form field is 16px+ on a phone (no zoom-on-focus)', phoneSmall.length === 0, phoneSmall.join(', '));

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL  harness: ${(e as Error).message}`);
} finally {
  await browser.close();
  server.close();
  rx.close();
}
console.log(failures ? `\nAdmin e2e: ${failures} failure(s).` : `\nAdmin e2e: all checks passed. Screenshots in ${path.relative(root, outDir)}/`);
process.exit(failures ? 1 : 0);
