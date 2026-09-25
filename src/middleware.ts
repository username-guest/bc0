/**
 * Tenant routing at the edge. All decisions come from the unit-tested pure function
 * `planRouting` (src/server/tenancy/resolve.ts); this file only applies them.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { planRouting } from '@/server/tenancy/resolve';

const BASE_DOMAIN = process.env.BASE_DOMAIN ?? 'brandcanvas.app';

export function middleware(req: NextRequest) {
  const decision = planRouting(req.headers.get('host'), req.nextUrl.pathname, BASE_DOMAIN);
  if (decision.action === 'next') return NextResponse.next();
  if (decision.action === 'reject') {
    return NextResponse.json({ error: { code: decision.status === 400 ? 'invalid_request' : 'not_found', message: decision.message } }, { status: decision.status });
  }
  const url = req.nextUrl.clone();
  url.pathname = decision.to;
  return NextResponse.rewrite(url);
}

export const config = {
  // Skip Next internals, static files, and the cron endpoints (ADR 0018): those are platform-level,
  // secret-protected, and must work on any host Vercel Cron calls (e.g. *.vercel.app).
  matcher: ['/((?!_next/|api/cron/|favicon.ico|robots.txt|.*\\.(?:png|jpg|svg|ico|css|js)$).*)'],
};
