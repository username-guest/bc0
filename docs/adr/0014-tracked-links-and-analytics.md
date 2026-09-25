# ADR 0014 — Tracked links and funnel analytics

**Status:** Accepted · **Date:** 2026-09-24 · Builds on ADR 0003 (flags), 0007 (leads), 0008 (admin)

## Context
Distributors share their storefront in many places: a salesperson's emails, a QR code on a
trade-show card, a social post. They want to know which of those bring visitors, proofs and leads.
The registry already had two Pro flags for this (`shareable_tracked_links`, `analytics_dashboard`)
with nothing behind them.

## Decisions
1. **A tracked link is a short code on the storefront URL.** `https://<storefront>/?src=<code>`.
   Codes are 7 characters from an alphabet without look-alikes (no 0/o, 1/l/i), because they get
   printed on cards and typed by hand. Unique per tenant, not globally. Each link has a name and a
   channel (email, print/QR, social, event, other). URLs are built from configuration like sign-in
   links (ADR 0008), never from the Host header.
2. **First touch, on the session we already have.** The anonymous prospect session behind the lead
   gate (signed `bc_ps` cookie, ADR 0007) records the first link it arrived through
   (`prospect_sessions.link_id`) and keeps it for the session's 30-day life. A later link does not
   take the credit. Unknown, archived, malformed and other-tenant codes are ignored, never an error.
3. **Count sessions, not requests.** `analytics_events` has one row per (tenant, UTC day, session,
   stage), inserted with `ON CONFLICT DO NOTHING`. Refreshing, re-rendering proofs or a flood of
   requests from one session cannot inflate a number, and the table's size is bounded by visitors,
   not traffic. Stages: `visit`, `proof`, `lead`.
4. **A proof or lead implies that day's visit.** Someone can open the storefront one evening and
   submit the form the next morning without reloading. Recording a proof or lead also records the
   day's visit, so no rate exceeds 100%. (Found by the admin browser suite: it showed "300%".)
5. **One beacon per page load.** The storefront's single load-time call became `POST /visit`
   (`{ src? }`), which answers exactly like `GET /session` did. Its own rate limit: 120 per minute
   per IP. Link-preview fetchers that run scripts (Slack, Facebook, Google and similar user agents)
   are not counted.
6. **Privacy by construction.** No IP address, user agent, referrer or contact detail is stored
   with an event, only the random session id the gate cookie already uses. Nobody can reconstruct
   an individual's path from the dashboard; it only ever shows counts.
7. **Leads carry their source.** When a prospect becomes a lead, the link's code and name go into
   the lead event and the CRM payload (`details.trackedLink`), so a salesperson sees "came from:
   Spring trade show" where they work. Leads with no link have no such field.
8. **Plan gating.** Creating, renaming and restoring links need `shareable_tracked_links`; the
   dashboard needs `analytics_dashboard` (both Pro). Events are recorded on every plan, so an
   upgrade shows history. Links on a plan without the feature are ignored by the storefront.
   Archiving always works, so a downgraded tenant can still switch old links off.
9. **Both roles manage links.** Owners and admins: links are low-risk and salespeople need them.
   Every change is audited (`links.create`, `links.update`). At most 200 active links per tenant.
10. **UTC days, fixed ranges.** 7, 30, 90 or 365 days ending today (UTC). The dashboard says UTC.
    Per-tenant time zones can come later without changing stored data (events keep `created_at`).
11. **Retention.** The maintenance job deletes events older than 400 days (the longest report is a
    year). Links are kept.

## Consequences
- Two new tenant-scoped tables (`tracked_links`, `analytics_events`) under RLS, plus
  `prospect_sessions.link_id`: migration `drizzle/0001`. A new database test asserts every table in
  `TENANT_SCOPED_TABLES` has RLS enabled and forced, so a future table can't be forgotten.
- A visitor who clears cookies, or changes device, starts a new session: counts are visitors per
  browser, not people: the same limit every cookie-based tool has.
- Analytics failures are logged and swallowed; they never fail a storefront request.
- Not built: QR code images (any QR generator works with the copied link), per-tenant time zones,
  UTM parameters, and exporting the dashboard.
