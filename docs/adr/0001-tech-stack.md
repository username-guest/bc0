# ADR 0001 — Tech stack

Status: accepted · Date: 2026-09-18

## Context
Spec §11 recommends a modern, cohesive baseline and asks us to record the choice. The hard
constraints that actually drive the picks: enforced Postgres RLS with tests (§2), an async
render pipeline with retries/cancellation/idempotency (§4), swappable providers (§11), and
strict typing + validation everywhere (§12).

## Decision
- **Next.js (App Router) + TypeScript strict** — server-authoritative flag/entitlement checks
  live naturally in server components / route handlers; strict mode is non-negotiable per §12.
- **Drizzle ORM + Postgres** (not Prisma). RLS is a hard, *tested* requirement. Drizzle is
  SQL-first, so `SET`/`current_setting` session GUCs, `ENABLE/FORCE ROW LEVEL SECURITY`, and
  policy DDL are first-class and transparent. Prisma is more mainstream (the "boring" pick) but
  its RLS story requires fighting the client; the isolation guarantee is worth the trade.
- **Tailwind + shadcn/ui (Radix primitives)** — accessible-by-default components (§12 WCAG AA).
- **pg-boss** for the render queue — Postgres-backed, so infra stays "Postgres + object store"
  *(Superseded by ADR 0015: a plain RLS-scoped Postgres table with leased claims instead.)*
  with no Redis. It gives retries, `singletonKey` idempotency, and scheduling out of the box.
  Alternative BullMQ+Redis if a Redis is already present; swap is localized to `mockup/queue`.
- **S3-compatible object store** (AWS S3 in prod, MinIO locally) behind `StorageProvider`.
- **zod** for env + all input validation. **Vitest** unit/integration, **Playwright** e2e.
- ~~Auth.js (NextAuth v5)~~ **Superseded by ADR 0008:** first-party magic-link sign-in, because
  Auth.js's email adapter looks users up across tenants, which conflicts with tenant-scoped users
  under RLS. Original text: **Auth.js (NextAuth v5)** for staff auth + the SSO seam (Enterprise); prospects stay
  anonymous (email gate, not accounts).

## Consequences
+ RLS is enforceable and testable; infra footprint is small.
− Drizzle is younger than Prisma; team ramp cost. Mitigated by SQL transparency.
