/**
 * Scheduled jobs over HTTP, for serverless hosting (ADR 0018). Vercel Cron calls
 * GET /api/cron/<job> with `Authorization: Bearer <CRON_SECRET>`.
 *
 * - No CRON_SECRET configured → 404 for everything: the endpoints don't exist until someone
 *   deliberately turns them on.
 * - Wrong or missing secret → 401, compared in constant time.
 * - A job whose run reports errors answers 500, so Vercel's cron logs flag it.
 */
import { timingSafeEqual } from 'node:crypto';

export const CRON_JOBS = ['deliveries', 'proofs', 'suppliers', 'maintenance'] as const;
export type CronJob = (typeof CRON_JOBS)[number];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function authorised(header: string | null, secret: string): boolean {
  const want = Buffer.from(`Bearer ${secret}`, 'utf8');
  const got = Buffer.from(header ?? '', 'utf8');
  // Compare equal-length buffers so the time taken doesn't reveal the length either.
  const same = timingSafeEqual(got.length === want.length ? got : want, want);
  return got.length === want.length && same;
}

export async function handleCron(
  req: Request,
  job: string,
  secret: string | undefined,
  run: (job: CronJob) => Promise<{ errors: unknown[] }>,
): Promise<Response> {
  if (!secret) return json(404, { error: { code: 'not_found', message: 'Not found.' } });
  if (req.method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'Use GET.' } });
  if (!authorised(req.headers.get('authorization'), secret)) return json(401, { error: { code: 'unauthorized', message: 'Unauthorized.' } });
  if (!(CRON_JOBS as readonly string[]).includes(job)) return json(404, { error: { code: 'not_found', message: 'Unknown job.' } });
  const started = Date.now();
  try {
    const result = await run(job as CronJob);
    return json(result.errors.length ? 500 : 200, { job, ms: Date.now() - started, ...result });
  } catch (e) {
    console.error(`cron ${job}: ${(e as Error).message.slice(0, 300)}`);
    return json(500, { job, ms: Date.now() - started, errors: [{ error: (e as Error).message.slice(0, 300) }] });
  }
}
