# ADR 0010 — Production readiness: shared rate limits, maintenance, S3 storage

**Status:** Accepted · **Date:** 2026-09-24 · Amends ADR 0006 (storage) and ADR 0008 (sign-in limits)

## Context
Three things stood between a single-node demo and a scaled-out deployment:

1. Rate limits (uploads, proof renders, leads, admin sign-in) were counted in process memory. With
   N instances behind a load balancer, every limit was effectively N times looser.
2. Nothing removed expired sign-in tokens, old admin sessions or stale limiter state, so those
   tables grew forever.
3. `STORAGE_DRIVER=s3` threw. Local disk doesn't survive redeploys on most hosts and can't be
   shared between instances.

## Decisions

1. **The limiter keeps the policy; a `RateWindowStore` keeps the counters.** `FixedWindowLimiter`
   is now async and takes a store. `MemoryWindowStore` serves development; `DrizzleRateWindowStore`
   is the default whenever `DATA_MODE=postgres` (`RATE_LIMIT_STORE` overrides). Every limiter
   shares one store, namespaced by limiter name, so `lead` and `upload` budgets stay separate.

2. **One atomic upsert per hit.** `INSERT … ON CONFLICT DO UPDATE` with the window-reset test in
   the `SET` clause: Postgres serialises concurrent hits on the same row, so 50 simultaneous hits
   from different instances count as exactly 1…50 (pinned by `src/core/db/rate-limit.test.ts`).
   No Redis: one fewer service to run, and the volume here (a few writes per prospect action) is
   well within what Postgres handles.

3. **`rate_limits` is global, and stores only SHA-256 hashes of keys.** Keys contain client IPs
   and tenant ids; hashing keeps IPs out of the table. The table is not tenant-scoped (a limiter
   key already includes the tenant), so it has no RLS policy; the app role gets explicit
   SELECT/INSERT/UPDATE/DELETE on it and nothing else changes.

4. **Rate limiting fails open.** If the store errors, the request is allowed and a throttled warning
   is logged. Rate limiting is abuse protection, not authorisation: a database blip must not lock
   every prospect out. Authentication does not depend on it — sign-in tokens are 256-bit, single
   use, 15 minutes.

5. **Maintenance sweeps what has served its purpose.** `runMaintenance` deletes, per tenant under
   RLS: login tokens expired or used over 24 h ago, sessions expired or revoked over 7 days ago
   (kept a week to answer "why was I signed out?"), and rate windows older than 24 h. It is
   idempotent and safe to run from several processes. It runs in-process every
   `MAINTENANCE_INTERVAL_MS` with `DELIVERY_WORKER=inline`, or from cron with
   `npm run jobs:maintenance` (exit code 1 on any error, so a scheduler can alert). One tenant's
   failure never stops the others.

6. **S3 storage without an SDK.** `S3StorageProvider` signs requests with AWS Signature V4 using
   `node:crypto` and sends them with `fetch`; it works with AWS S3, Cloudflare R2, MinIO and other
   S3-compatible stores. The signer is pinned to AWS's published example. Rules kept from the local
   adapter: objects live at `<tenantId>/<key>` with the same key validation (rejected, never
   sanitised), and **the bucket stays private** — the app serves every file through its own
   tenant-checked routes, never through public or presigned bucket URLs. Missing objects read as
   null; deletes are idempotent. Every call has a timeout; network errors, 5xx and 429 are retried
   and re-signed. Errors carry the status and S3 error code, never credentials.

   The bucket policy must allow `s3:ListBucket`, because without it AWS answers 403 instead of 404
   for a missing object — which the adapter correctly treats as an error, not "not found".

## Consequences
- Scaling out needs no extra infrastructure beyond Postgres and a bucket.
- Every limited request costs one small write. If that ever matters, a Redis-backed store
  implements the same two-method interface.
- New settings: `RATE_LIMIT_STORE`, `MAINTENANCE_INTERVAL_MS`, `STORAGE_REGION`,
  `STORAGE_FORCE_PATH_STYLE`. `STORAGE_DRIVER=s3` requires `STORAGE_ACCESS_KEY` and
  `STORAGE_SECRET_KEY`.
- `npm run smoke:pg` runs the production build end to end and checks both; with `SMOKE_STORAGE=s3`
  the same journey runs on the S3 adapter.
