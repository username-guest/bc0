# ADR 0018 — Background work on serverless hosting (Vercel)

**Status:** Accepted · **Date:** 2026-09-24 · Builds on ADR 0008 (deliveries), 0010 (maintenance), 0015 (proofs), 0017 (suppliers)

## Context
Background work so far runs as in-process timers (`*_WORKER=inline`) or as scripts a scheduler
runs (`npm run jobs:*`). On Vercel neither fits: a function lives only while it answers a request,
there's no process to run scripts in, and the team is on the Hobby plan, where scheduled jobs run
at most once a day and a function stops after 60 seconds.

## Decisions
1. **Work runs right after the request that caused it,** with Next.js `after()`, which Vercel keeps
   alive once the response is sent: proof pre-rendering after a logo upload, a supplier sync after
   "Sync now" (`PROOF_WORKER=after`, `SUPPLIER_WORKER=after`). A lead's first CRM delivery was
   already attempted during the request (ADR 0008) and stays that way.
2. **Scheduled jobs become HTTP endpoints**: `GET /api/cron/{deliveries,proofs,suppliers,maintenance}`,
   called by Vercel Cron (`vercel.json`) with `Authorization: Bearer $CRON_SECRET`. No secret
   configured → 404; wrong secret → 401 (constant-time compare); a run that reports errors → 500,
   so Vercel's cron log flags it. They run the same functions as the `jobs:*` scripts.
3. **The endpoints skip tenant routing** (excluded in the middleware matcher), so they answer on any
   host, including `*.vercel.app`, which routing would otherwise treat as an unknown custom domain.
4. **Daily schedules** (Hobby-compatible): supplier refresh, maintenance, CRM delivery retries,
   leftover proof renders. On Pro, deliveries should run every few minutes.
5. **Wrong settings fail loudly.** On Vercel in production the app refuses to start with
   `STORAGE_DRIVER` other than `s3` (local disk isn't kept) or with in-process workers
   (timers don't run), naming the setting to change.

## Consequences
- `docs/DEPLOY-VERCEL.md` lists the accounts (Neon, R2/S3, Resend), the settings and checks.
- On Hobby, a failed CRM delivery waits up to a day to be retried, and a supplier sync longer than
  60 s is cut off and resumed by a later run after its 30-minute lock expires (keep picks small).
- Not proven live: the whole setup still needs its first real deployment.
