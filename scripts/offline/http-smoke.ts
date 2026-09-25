/**
 * Real-socket smoke test of the tenant API: upload → catalog → proof (+ cache), plus Host-header
 * tenant routing (subdomain, custom domain) and a server-side entitlement denial.
 */
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startDevServer } from '../dev-server';
import { encodePng, decodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';

const dir = await mkdtemp(path.join(tmpdir(), 'bc-smoke-'));
const server = await startDevServer({ port: 0, storageDir: dir });
const port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}`;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** node:http so we can set Host (fetch forbids overriding it). */
function viaHost(host: string, p: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const r = request({ host: 'localhost', port, path: p, headers: { host } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', no);
    r.end();
  });
}

try {
  const form = new FormData();
  form.set('file', new Blob([encodePng(sampleLogo())], { type: 'image/png' }), 'logo.png');
  form.set('knockout', 'true');
  let t = Date.now();
  const up = await fetch(`${base}/api/t/demo/logos`, { method: 'POST', body: form });
  const upBody = (await up.json()) as { logo: { id: string; colorCount: number; cleanUrl: string } };
  check('upload over HTTP (multipart)', up.status === 201 && upBody.logo.colorCount === 3, `${up.status}, ${Date.now() - t} ms`);

  const clean = await fetch(base + upBody.logo.cleanUrl);
  check('cleaned logo served from local-FS storage', clean.status === 200 && decodePng(new Uint8Array(await clean.arrayBuffer())).width > 100);

  t = Date.now();
  const cat = await fetch(`${base}/api/t/demo/catalog?logo=${upBody.logo.id}&qty=72`);
  const catBody = (await cat.json()) as { items: Array<{ name: string; method: string; unit: number; proofUrl: string }> };
  check('catalog priced for qty 72', cat.status === 200 && catBody.items.length === 6, `${Date.now() - t} ms`);
  for (const i of catBody.items) console.log(`      ${i.name.padEnd(24)} ${i.method.padEnd(18)} $${(i.unit / 100).toFixed(2)}`);

  t = Date.now();
  const p1 = await fetch(base + catBody.items[0]!.proofUrl);
  const miss = Date.now() - t;
  await p1.arrayBuffer();
  t = Date.now();
  const p2 = await fetch(base + catBody.items[0]!.proofUrl);
  await p2.arrayBuffer();
  check('proof rendered then cached', p1.headers.get('x-proof-cache') === 'miss' && p2.headers.get('x-proof-cache') === 'hit', `miss ${miss} ms, hit ${Date.now() - t} ms`);
  const p3 = await fetch(base + catBody.items[0]!.proofUrl, { headers: { 'if-none-match': p1.headers.get('etag')! } });
  check('ETag revalidation → 304', p3.status === 304);

  const sub = await viaHost('demo.brandcanvas.app', '/api/config');
  check('subdomain routing (Host: demo.brandcanvas.app)', sub.status === 200 && sub.body.includes('Demo Promo Co.'));
  const cd = await viaHost('shop.bigco.com', '/api/config');
  check('custom-domain routing (Host: shop.bigco.com)', cd.status === 200 && cd.body.includes('BigCo Merch'));
  const unknown = await viaHost('nobody.brandcanvas.app', '/api/config');
  check('unknown tenant → 404', unknown.status === 404);
  const freeDtg = await viaHost('basic.brandcanvas.app', '/api/catalog?method=dtg');
  check('Free plan denied DTG server-side → 403', freeDtg.status === 403 && freeDtg.body.includes('all_decoration_methods'));
  const own = await viaHost('demo.brandcanvas.app', catBody.items[0]!.proofUrl);
  check("tenant host may call its own internal proof URL", own.status === 200);
  const cross = await viaHost('demo.brandcanvas.app', '/api/t/basic/config');
  check("tenant host can't reach another tenant's API", cross.status === 404);
  const bad = await viaHost('evil.com/../x', '/api/config');
  check('malformed Host rejected', bad.status === 400);
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} smoke check(s) FAILED` : '\nHTTP smoke: all checks passed.');
process.exit(failures ? 1 : 0);
