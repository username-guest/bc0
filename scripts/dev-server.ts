/**
 * Zero-dependency API dev server: the SAME tenant API the Next.js app mounts, over node:http,
 * with host-based tenant resolution, in-memory repos seeded with the demo tenants, and
 * local-filesystem storage (.data/storage).
 *
 *   npm run dev:api        → http://localhost:8787/api/t/demo/config
 *
 * Useful before `npm install`, and it's how the HTTP smoke test exercises real sockets.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRouting } from '@/server/tenancy/resolve';
import { handleTenantApi } from '@/server/http/router';
import { jsonResponse } from '@/server/http/api';
import { buildFixture } from '@/server/testing';
import { warmTemplates } from '@/imaging/templates';
import { LocalFsStorageProvider } from '@/shared/providers/local-fs-storage';
import { createSharpCodec } from '@/features/logo-intake/sharp-codec';
import type { EmailProvider } from '@/shared/providers';
import { LogEmailProvider } from '@/shared/providers/mocks';
import { startSupplierWorker } from '@/server/suppliers/service';
import { httpPost } from '@/integrations/promostandards/soap';
import { withFakeSupplier } from '@/integrations/promostandards/fake-supplier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function toWebRequest(req: IncomingMessage, base: string): Request {
  const url = new URL(req.url ?? '/', base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

export interface StaticAsset {
  type: string;
  body: string | Uint8Array;
}

export async function startDevServer(
  opts: {
    port?: number;
    baseDomain?: string;
    storageDir?: string;
    staticAssets?: Record<string, StaticAsset>;
    /** Where admin sign-in emails go (tests pass a MockEmailProvider and read the link). */
    email?: EmailProvider;
    publicBaseUrl?: string;
    allowInsecureWebhooks?: boolean;
  } = {},
): Promise<Server> {
  const baseDomain = opts.baseDomain ?? process.env.BASE_DOMAIN ?? 'brandcanvas.app';
  const codec = (await createSharpCodec()) ?? undefined;
  const supplierNudge = { current: () => {} };
  const fx = buildFixture({
    storage: new LocalFsStorageProvider(opts.storageDir ?? path.join(root, '.data/storage')),
    ...(codec ? { codec } : {}),
    email: opts.email ?? new LogEmailProvider(),
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    allowInsecureWebhooks: opts.allowInsecureWebhooks ?? false,
    // ADR 0017: https://promostandards.example is the built-in fake supplier; real suppliers go
    // through the guarded transport, so a developer can try their own credentials locally.
    supplierPost: withFakeSupplier(httpPost()),
    onSuppliersQueued: () => supplierNudge.current(),
  });
  const supplierWorker = startSupplierWorker({ directory: fx.directory, service: fx.supplierService }, 60_000);
  supplierNudge.current = supplierWorker.nudge;
  warmTemplates(); // same as the Next runtime: no cold template build on the first proof

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? null;
      const url = new URL(req.url ?? '/', 'http://x');
      const asset = opts.staticAssets?.[url.pathname];
      if (asset && req.method === 'GET') {
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        return void res.end(asset.body);
      }
      // Same decision function as src/middleware.ts.
      const decision = planRouting(host, url.pathname, baseDomain);
      if (decision.action === 'reject') {
        return await send(res, jsonResponse(decision.status, { error: { code: decision.status === 400 ? 'invalid_request' : 'not_found', message: decision.message } }));
      }
      const internal = decision.action === 'rewrite' ? decision.to : url.pathname;
      const m = /^\/api\/t\/([^/]+)\/(.*)$/.exec(internal);
      if (!m) {
        return await send(res, jsonResponse(404, { error: { code: 'not_found', message: 'Pages are served by the Next.js app; this server exposes /api only.' } }));
      }
      const webReq = toWebRequest(req, `http://${host ?? 'localhost'}`);
      const ref = decodeURIComponent(m[1]!);
      const sub = m[2]!.split('/').filter(Boolean);
      return await send(res, await handleTenantApi(webReq, ref, sub, { api: fx.api, admin: fx.admin, directory: fx.directory, publicApi: fx.publicApi }));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) await send(res, jsonResponse(500, { error: { code: 'internal', message: 'Internal error' } }));
    }
  });
  return new Promise((ok) => server.listen(opts.port ?? 8787, () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startDevServer({ port: Number(process.env.PORT ?? 8787) });
  const a = s.address();
  console.log(`BrandCanvas API dev server on http://localhost:${typeof a === 'object' && a ? a.port : '?'}  (try /api/t/demo/config)`);
}
