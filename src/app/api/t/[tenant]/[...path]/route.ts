/**
 * Mounts the framework-agnostic tenant API (src/server/http) under /api/t/:tenant/*.
 * All behaviour lives in handleTenantApi — tested offline and over real HTTP.
 */
import { handleTenantApi } from '@/server/http/router';
import { getRuntime } from '@/server/runtime';

export const runtime = 'nodejs'; // node:crypto + node:zlib (imaging, hashing)
export const dynamic = 'force-dynamic';
// Serverless (ADR 0018): proof renders and supplier syncs run in after() within this budget.
export const maxDuration = 60;

type Ctx = { params: Promise<{ tenant: string; path: string[] }> };

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const { tenant, path } = await params;
  return handleTenantApi(req, tenant, path, await getRuntime());
}

export const GET = handle;
export const POST = handle;
export const PUT = handle; // admin settings (ADR 0008)
export const DELETE = handle; // admin team removal (ADR 0011)
