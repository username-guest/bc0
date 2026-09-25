# ADR 0015 — Pre-rendering proofs in the background

**Status:** Accepted · **Date:** 2026-09-24 · Supersedes the queue choice in ADR 0001 (pg-boss)

## Context
A proof takes about 0.1–0.6 s of CPU to render (measured on the demo catalog), and rendering is
synchronous. Until now every catalog image rendered when the prospect's browser first asked for
it: the prospect waited, and while a render ran that server process answered nobody else. A
catalog of dozens of products made both worse.

## Decisions
1. **Queue on upload, render in the background.** When a logo is uploaded (or the same logo is
   uploaded again), the server queues the proofs the catalog is about to show: each product's
   recommended configuration (colour, method, location) in the default view at the storefront's
   default quantity, first 24 products. Other configurations (a filter, another quantity, another
   colour) still render on demand, exactly as before. Pre-rendering is a head start, never a
   requirement: if the queue is behind or a render fails, the image renders when requested.
2. **A Postgres table, not pg-boss.** ADR 0001 named pg-boss. It creates and migrates its own
   schema at startup, which the app's database role deliberately cannot do (ADR 0002), and its
   tables would sit outside row-level security. The CRM outbox (ADR 0008) already showed the
   simpler pattern works: the existing `mockup_jobs` table became the queue, tenant-scoped under
   RLS, claimed with a lease (`FOR UPDATE SKIP LOCKED`), so any number of workers can run. pg-boss
   was removed from the dependencies.
3. **One job per proof.** A unique index on (tenant, cache key) makes queueing idempotent:
   re-uploads and racing uploads never queue a render twice. The cache key is the proof's
   content-addressed key, so a job for an image that's already cached finishes without rendering.
4. **The gate is unchanged.** Locked products are pre-rendered too, but the proof endpoint still
   refuses them until the prospect gives an email. Rendering is not serving.
5. **Failures.** A job that can never succeed (product removed, method no longer on the plan,
   logo deleted, needs manual placement) fails at once. Anything else (storage down, a crash) is
   retried after 30 s and 2 min, then marked failed with the error kept. A worker that dies
   mid-job loses only its small batch, for one 60 s lease.
6. **Limits.** At most 500 pending jobs per tenant (uploads are rate-limited as well). Workers
   claim 4 jobs at a time, yield to the event loop between renders, and stop at a time budget, so
   one busy tenant can't starve the rest or the storefront.
7. **Where it runs.** `PROOF_WORKER=inline` (default): the web process renders, starting right
   after each upload (a nudge) with a 15 s timer as a backstop. `PROOF_WORKER=off`: run
   `npm run jobs:proofs` from a scheduler, or `npm run jobs:proofs -- --watch` as a dedicated
   worker process, which keeps rendering off the web process entirely. That is the recommended
   setup with several instances or real traffic.
8. **Retention.** The maintenance job deletes done and failed jobs a week after they finish. The
   rendered images stay in the cache; jobs are only the to-do list.

## Consequences
- Migration `drizzle/0002` adds the queue columns to `mockup_jobs` (what to render, attempts,
  due time, last error) and replaces its lookup index with the unique one.
- `rendered_proofs` stays unused: the object store is the cache and jobs record the outcome. It is
  kept for the AI lifestyle renders it was designed with, not dropped in this change.
- Inline mode still renders on the web process, just not while a prospect waits for that image.
  Moving rendering off the web process is a deployment choice (`PROOF_WORKER=off` plus a worker),
  not a code change.
- Not built: cancelling a tenant's queue, per-plan render quotas, pre-rendering other quantities or
  filtered views, and a queue view in the admin.
