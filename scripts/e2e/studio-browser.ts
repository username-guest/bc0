/**
 * Browser end-to-end check of the REAL storefront components (src/ui) against the REAL tenant
 * API (dev server), in headless Chromium. Next.js routing is the only piece not exercised here.
 *
 *   BC_EXTRA_MODULES=<dir with react, react-dom, playwright, sharp> npm run e2e:browser
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer, type StaticAsset } from '../dev-server';
import { loadTenantContext, publicTenantConfig } from '@/server/tenancy/context';
import { MemoryTenantDirectory } from '@/server/repos/memory';
import { fixtureTenants } from '@/server/testing';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extra = process.env.BC_EXTRA_MODULES ?? path.join(root, 'node_modules');
const req = createRequire(path.join(extra, 'noop.js'));
const outDir = process.env.E2E_OUT ?? path.join(root, '.data/e2e');
await rm(path.join(outDir, 'storage'), { recursive: true, force: true }); // cold cache: timings are real renders
await mkdir(outDir, { recursive: true });

// esbuild ships with tsx; prefer a direct install if present.
let esbuild: typeof import('esbuild');
try {
  esbuild = req('esbuild');
} catch {
  esbuild = createRequire(req.resolve('tsx/package.json'))('esbuild');
}

// 1. Bundle the real UI for the browser. platform=browser makes any server-only import fail loudly.
const built = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/e2e/client-entry.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  minify: true,
  tsconfig: path.join(root, 'tsconfig.json'),
  nodePaths: [extra],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const js = built.outputFiles[0]!.text;
const css = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');

// 2. Pages for two tenants on different plans, configured exactly as the Next layout would.
const dir = new MemoryTenantDirectory(fixtureTenants());
const page = async (ref: string): Promise<StaticAsset> => {
  const cfg = publicTenantConfig((await loadTenantContext(ref, dir))!);
  return {
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${cfg.branding.displayName}</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.__BC_CONFIG__=${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script><script type="module" src="/app.js"></script></body></html>`,
  };
};
// pdf.js (when available) renders the downloaded leave-behind inside Chromium for a visual check.
const pdfjsDir = (() => {
  try {
    return path.dirname(req.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch {
    return null;
  }
})();
const assets: Record<string, StaticAsset> = {
  '/t/demo': await page('demo'),
  '/t/basic': await page('basic'),
  '/app.js': { type: 'text/javascript', body: js },
  '/app.css': { type: 'text/css', body: css },
  ...(pdfjsDir
    ? {
        '/pdfjs/pdf.mjs': { type: 'text/javascript', body: await readFile(path.join(pdfjsDir, 'pdf.mjs')) },
        '/pdfjs/pdf.worker.mjs': { type: 'text/javascript', body: await readFile(path.join(pdfjsDir, 'pdf.worker.mjs')) },
        '/pdf-view': {
          type: 'text/html; charset=utf-8',
          body: `<!doctype html><body style="margin:0;background:#888"><canvas id="c"></canvas><script type="module">
            import * as pdfjs from '/pdfjs/pdf.mjs';
            pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
            const doc = await pdfjs.getDocument('/sheet.pdf').promise;
            const pg = await doc.getPage(1);
            const vp = pg.getViewport({ scale: 1.5 });
            const c = document.getElementById('c');
            c.width = vp.width; c.height = vp.height;
            await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            const text = (await pg.getTextContent()).items.map((i) => i.str).join(' ');
            const ops = await pg.getOperatorList();
            window.__pdf = { pages: doc.numPages, text, images: ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length };
          </script>`,
        },
      }
    : {}),
};
const server = await startDevServer({ port: 0, storageDir: path.join(outDir, 'storage'), staticAssets: assets });
const base = `http://localhost:${(server.address() as { port: number }).port}`;

// 3. Drive it.
const pw = req('playwright') as typeof import('playwright');
/** E2E_BROWSER=webkit runs the same suite in Safari's engine (WebKit); firefox also works. */
const engineName = (process.env.E2E_BROWSER ?? 'chromium') as 'chromium' | 'webkit' | 'firefox';
if (!['chromium', 'webkit', 'firefox'].includes(engineName)) throw new Error(`E2E_BROWSER must be chromium, webkit or firefox (got ${engineName})`);
console.log(`Engine: ${engineName}`);
const { default: sharp } = (await import('sharp')) as { default: (b: Uint8Array) => { jpeg(o: object): { toBuffer(): Promise<Buffer> } } };
const jpeg = await sharp(encodePng(sampleLogo())).jpeg({ quality: 82 }).toBuffer();

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
/** Same, measured at 390px wide, then the viewport is put back. */
async function smallControlsOnPhone(pg: import('playwright').Page) {
  const vp = pg.viewportSize();
  await pg.setViewportSize({ width: 390, height: 844 });
  const found = await smallControls(pg);
  if (vp) await pg.setViewportSize(vp);
  return found;
}

const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await pw[engineName].launch();
const errors: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

  // Page-load beacon (ADR 0014): one POST /visit carrying the ?src= code from the address.
  const beacon = p.waitForRequest((r) => r.url().endsWith('/api/t/demo/visit') && r.method() === 'POST');
  await p.goto(`${base}/t/demo?src=abcdefg`);
  const sent = await beacon;
  check('page load sends one visit beacon with the link code', sent.postData() === '{"src":"abcdefg"}', sent.postData() ?? '');
  await p.waitForSelector('.item');
  check('landing renders headline + catalog before any upload',
    (await p.textContent('h1'))!.includes('Demo Promo Co.') && (await p.locator('.item').count()) === 6);
  check('proof slots invite an upload', (await p.locator('.proof-empty').first().textContent())!.includes('Upload a logo'));
  await p.screenshot({ path: path.join(outDir, '1-landing.png') });

  const t0 = Date.now();
  await p.setInputFiles('input[type=file]', { name: 'logo.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await p.waitForSelector('.logo-strip');
  // Before the knockout answer, the enclosed white area is real white ink: 4 colours.
  check('JPEG upload processed (sharp codec) → 4 colours incl. enclosed white', (await p.textContent('.logo-count'))!.trim() === '4 colours', `${Date.now() - t0} ms`);
  check('enclosed-area question shown', await p.locator('.ask').isVisible());
  await p.screenshot({ path: path.join(outDir, '2-uploaded.png') });

  const firstLogo = (await p.getAttribute('.logo-tile img', 'src'))!;
  // Track proof responses so we wait for renders of the NEW logo, not the old images on screen.
  const proofHits = new Map<string, number>();
  p.on('response', (r) => {
    const m = /[?&]logo=([0-9a-f-]{36})/.exec(r.url());
    if (r.url().includes('/proofs?') && m && r.status() === 200) proofHits.set(m[1]!, (proofHits.get(m[1]!) ?? 0) + 1);
  });
  const t1 = Date.now();
  await p.click('text=Show product colour');
  await p.waitForSelector('.ask', { state: 'detached' });
  await p.waitForFunction((old) => document.querySelector('.logo-tile img')?.getAttribute('src') !== old, firstLogo);
  const newLogoId = /\/logos\/([0-9a-f-]{36})\//.exec((await p.getAttribute('.logo-tile img', 'src'))!)![1]!;
  check('knockout answer re-processes the logo → 3 colours', (await p.textContent('.logo-count'))!.trim() === '3 colours');
  // Hard email gate (demo tenant: 3 free products). Server decides; UI mirrors it.
  const loadedProofs = (n: number) =>
    p.waitForFunction((want) => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('img.proof-img')];
      return imgs.length === want && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, n, { timeout: 60_000 });
  await loadedProofs(3);
  const deadline = Date.now() + 60_000;
  while ((proofHits.get(newLogoId) ?? 0) < 3 && Date.now() < deadline) await p.waitForTimeout(100);
  check('gate: 3 proofs shown for the NEW logo, 3 products locked', (proofHits.get(newLogoId) ?? 0) === 3 && (await p.locator('.proof-empty a[href="#gate"]').count()) === 3, `${Date.now() - t1} ms incl. re-upload`);
  check('gate: email form explains what unlocks and who gets the email',
    (await p.textContent('.gate-title'))!.includes('3 more products') && (await p.textContent('.gate-text'))!.includes('Jordan at Demo Promo Co.'));
  check('gate: marketing consent is unticked by default', !(await p.isChecked('#gate-consent')));
  await p.screenshot({ path: path.join(outDir, '3a-gate.png'), fullPage: true });
  const smallGate = await smallControlsOnPhone(p);
  check('iOS: gate fields are 16px+ on a phone (no zoom-on-focus)', smallGate.length === 0, smallGate.join(', '));

  await p.click('.proof-empty a[href="#gate"] >> nth=0');
  await p.fill('#gate-email', 'pat@acme.test');
  await p.waitForTimeout(1600); // humans take >1.5 s to fill a form; faster is screened as a bot
  await p.click('text=Show all products');
  await p.waitForSelector('#gate', { state: 'detached' });
  await loadedProofs(6);
  check('gate: email unlocks all 6 proofs', (proofHits.get(newLogoId) ?? 0) >= 6, `${proofHits.get(newLogoId)} proofs`);
  const teeCard = p.locator('.item', { hasText: 'Classic Cotton Tee' });
  check('renderer note surfaced on the card (navy ink on black tee)', (await teeCard.locator('.note').allTextContents()).some((n) => /hard to see/.test(n)));
  check('note shows the ink as a colour swatch, not just a hex code', (await teeCard.locator('.note .ink-ref i').count()) > 0);
  await p.screenshot({ path: path.join(outDir, '3-proofs.png'), fullPage: true });

  // Quote request (Starter+): email prefilled from the session, estimate computed on the server.
  await teeCard.locator('text=Request a quote').click();
  const q = teeCard.locator('form.quote');
  check('quote: email prefilled from the session', (await q.locator('input[type=email]').inputValue()) === 'pat@acme.test');
  const smallQuote = await smallControlsOnPhone(p);
  check('iOS: quote form fields are 16px+ on a phone', smallQuote.length === 0, smallQuote.join(', '));
  await q.locator('input[autocomplete=name]').fill('Pat Lee');
  await q.locator('input[autocomplete=organization]').fill('Acme');
  await q.locator('textarea').fill('Need these by the 15th.');
  await p.waitForTimeout(1600);
  await q.locator('text=Send quote request').click();
  await teeCard.locator('.quote-sent').waitFor();
  check('quote: confirmation names the contact and reply address',
    (await teeCard.locator('.quote-sent').textContent())!.trim() === "Sent to Jordan at Demo Promo Co. They'll reply to pat@acme.test.");

  // PDF leave-behind (Pro): known email → immediate download.
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Download product sheet (PDF)')]);
  const pdfPath = path.join(outDir, 'product-sheet.pdf');
  await dl.saveAs(pdfPath);
  const pdfBytes = await readFile(pdfPath);
  check('pdf: downloads as demo-product-sheet.pdf', dl.suggestedFilename() === 'demo-product-sheet.pdf' && pdfBytes.subarray(0, 5).toString() === '%PDF-', `${Math.round(pdfBytes.length / 1024)} KB`);
  if (pdfjsDir) {
    assets['/sheet.pdf'] = { type: 'application/pdf', body: pdfBytes };
    const v = await ctx.newPage();
    await v.setViewportSize({ width: 918, height: 1188 });
    await v.goto(`${base}/pdf-view`);
    await v.waitForFunction(() => (window as unknown as { __pdf?: unknown }).__pdf, undefined, { timeout: 30_000 });
    const info = (await v.evaluate(() => (window as unknown as { __pdf: { pages: number; text: string; images: number } }).__pdf));
    check('pdf: renders in pdf.js with branding, prospect, products, disclaimer',
      info.pages === 1 && ['Demo Promo Co.', 'Prepared for pat@acme.test', 'Classic Cotton Tee', 'Not a quote'].every((t) => info.text.includes(t)));
    check('pdf: embeds the logo + 6 proofs', info.images === 7, `${info.images} images`);
    await v.locator('#c').screenshot({ path: path.join(outDir, '6-pdf-page1.png') });
    await v.close();
  }

  await p.click('.qty button:has-text("24")');
  await p.waitForFunction(() => document.querySelector('.qty button[aria-pressed="true"]')?.textContent === '24');
  await p.waitForFunction(() => [...document.querySelectorAll('.item')].some((e) => e.textContent?.includes('Classic Cotton Tee') && e.textContent.includes('$10.70')));
  check('quantity 24 re-prices the tee to $10.70 each', true);

  await p.click('.chip:has-text("Navy")');
  await p.waitForFunction(() => document.querySelectorAll('.item').length === 1);
  check('colour filter narrows the catalog (Navy → 1 product)', (await p.locator('.item .item-meta').first().textContent())!.includes('Navy'));
  await p.click('text=Clear filters');
  await p.waitForFunction(() => document.querySelectorAll('.item').length === 6);
  check('clearing filters restores all products', true);

  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  const overflow = await p.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
  check('mobile: no horizontal page overflow at 390px', overflow <= 0, `overflow ${overflow}px`);
  const qtyEdges = await p.$$eval('.qty button', (els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  check('mobile: all six quantities visible without scrolling', qtyEdges.length === 6 && qtyEdges.every((r) => r <= 390), `right edges ${qtyEdges.join(',')}`);
  await p.screenshot({ path: path.join(outDir, '4-mobile.png'), fullPage: false });
  const smallStudio = await smallControls(p);
  check('iOS: studio controls are 16px+ on a phone', smallStudio.length === 0, smallStudio.join(', '));

  // Free tenant: presentation follows the server snapshot.
  const f = await ctx.newPage();
  f.on('pageerror', (e) => errors.push(`pageerror(basic): ${e.message}`));
  await f.goto(`${base}/t/basic`);
  await f.waitForSelector('.item');
  const methodChips = await f.locator('.chips[aria-label="Decoration"] .chip').allTextContents();
  const allowed = ['Screen Printing', 'Embroidery', 'Laser Engraving'];
  check('Free plan: only base-tier methods offered', methodChips.length > 0 && methodChips.every((t) => allowed.some((a) => t.startsWith(a))), methodChips.map((t) => t.replace(/\s\d+$/, '')).join(', '));
  check('Free plan: no eco filter (Pro feature)', (await f.locator('text=Eco-friendly only').count()) === 0);
  check('Free plan: no quote requests or PDF sheet (Starter/Pro)',
    (await f.locator('text=Request a quote').count()) === 0 && (await f.locator('text=Download product sheet').count()) === 0);
  const brand = await f.evaluate(() => getComputedStyle(document.querySelector('.wordmark')!).color);
  check('Free plan: platform brand colour, not the tenant\'s (white-label is paid)', brand === 'rgb(31, 69, 198)', brand);
  await f.screenshot({ path: path.join(outDir, '5-free-tenant.png') });

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} browser check(s) FAILED` : `\nBrowser e2e: all checks passed. Screenshots in ${path.relative(root, outDir)}/`);
process.exit(failures ? 1 : 0);
