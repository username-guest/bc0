# ADR 0011 — Teammate invites and team management

Status: accepted (2026-09-24)

## Context
Until now people got admin access only through `npm run admin:add` or `SEED_ADMIN_EMAIL`
(ADR 0008). A distributor's owner needs to add reps, change who can edit pricing and routing,
and remove someone who leaves, without us.

## Decision
**Invites are just accounts plus a longer sign-in link.** Inviting creates the `users` row
straight away (role chosen by the owner, `invited_by` recorded) and emails a normal single-use
magic link whose expiry is 3 days instead of 15 minutes. There is no separate invitation table or
"accept" state: the first time the link is used, `last_sign_in_at` is set and the person shows as
active. If the link lapses, the invitee can simply request a normal sign-in link, or the owner can
resend. This keeps one sign-in path, one token table, and one sweeper (ADR 0010).

**Owners manage; everyone can see.** `GET admin/team` is open to any signed-in admin. Invite,
resend, role change and removal are owner-only, need the CSRF header, and are refused
cross-site, through the same `guard()` as every other admin mutation. Every change is audited
(`team.invite`, `team.invite_resent`, `team.role_changed`, `team.removed`) and shows in Recent
changes.

**A workspace always keeps an owner, even under concurrency.** Demoting or removing an owner is
refused (`409 last_owner`) if they are the last one. The check lives in the store, inside the
same transaction as the write, after locking the tenant's owner rows `FOR UPDATE` in id order.
Two owners demoting each other at the same moment: the second waits, re-reads the rows after the
first commits (READ COMMITTED), sees one owner left, and refuses. Checking in application code
first and then writing would let both through. `src/core/db/team.test.ts` pins this with 10
concurrent rounds each of demotion and removal against Postgres 18 (6 of 6 passing, 2026-09-24).

**Removal ends access at once.** Deleting the `users` row cascades to that person's sign-in links
and sessions, and `authenticate()` already rejects a session whose user is gone, so their very
next request is `401`. Removing yourself (allowed only if another owner exists) also clears your
cookie. Role changes take effect on the next request; no re-sign-in needed.

**Limits.** 20 invites (including resends) per tenant per hour, shared across instances like the
other limits (ADR 0010); at most 25 people per workspace (`team_full`). If the invite email fails,
the person is still added and the owner is told to resend (`emailSent: false`) rather than the
invite silently vanishing.

**Plans.** Adding people (invite, resend) is the registry's `multi_user_admin` feature, which §7
puts on **Enterprise**; it is enforced server-side like every other plan gate (`403
feature_locked`, `upgradeable: true`) and the Team tab explains it. Viewing the team, changing
roles and removing people work on every plan, so an owner can always cut someone's access (after a
downgrade, for instance). A first version shipped invites on every plan; it was caught against
the registry before release. Moving invites to Pro is a one-line change to the registry
(`minPlan`). The 25-person cap is an abuse guard, not a pricing tier; per-plan seat limits are
still undecided.

## Consequences
- Schema: `users.invited_by` (no FK, so history survives the inviter's removal) and
  `users.last_sign_in_at`. Generated migrations must include them (`npm run db:generate`).
- The team list labels only people someone actually invited as "Invited"; seeded or CLI-created
  accounts that haven't signed in say "Hasn't signed in yet" and offer "Email an invite".
- `npm run admin:add` remains for bootstrapping the first owner.
- Not done: ownership transfer as a single action (promote, then demote yourself), per-plan seat
  limits, and an audit view filtered to team changes.
