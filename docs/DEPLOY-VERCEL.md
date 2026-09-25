# Deploying BrandCanvas to Vercel (a permanent prototype)

What you need, how to set it up, and what isn't proven yet. Design notes: ADR 0018.

## Accounts you need (all have free tiers)
| For | Suggested | What you get from it |
|---|---|---|
| Database | **Neon** Postgres, added from the Vercel Marketplace (Storage tab) | Two connection strings: the owner's (for migrations) and an app role's |
| Logo and proof files | **Cloudflare R2** (or AWS S3) | Endpoint URL, bucket name, access key, secret key |
| Sign-in emails | **Resend** | An API key, and a sending domain you verify there |

Not tried live yet: Resend and R2/S3 (tested against a local S3 clone only). Expect the first
deploy to surface a small fix or two.

## One-time setup
1. **Database.** Create the Neon database. Run migrations, policies and seed data once from any
   machine with the project checked out, using the owner connection string:
   ```bash
   export MIGRATION_DATABASE_URL='postgres://owner…'
   export SEED_ADMIN_EMAIL='you@yourcompany.com'   # first owner of the demo storefront
   npm run db:setup        # migrations + row-level-security policies + demo data
   ```
   The policy step creates the app role `brandcanvas_app` without a login. Give it one
   (`ALTER ROLE brandcanvas_app LOGIN PASSWORD '…'`) and use it for `DATABASE_URL`. The app must
   never connect as the owner: row-level security doesn't apply to table owners.
2. **Storage.** Create a private bucket. Note endpoint, bucket, region, access key, secret key.
3. **Email.** Verify a domain in Resend; create an API key.
4. **Vercel project.** Import the repository, then set these environment variables
   (Production):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (Vercel sets it) |
| `DATA_MODE` | `postgres` |
| `DATABASE_URL` | app-role connection string |
| `RATE_LIMIT_STORE` | `postgres` |
| `AUTH_SECRET` | 32+ random characters |
| `SETTINGS_ENCRYPTION_KEYS` | `k1:<32 random bytes, base64>`, e.g. `k1:$(openssl rand -base64 32)` |
| `CRON_SECRET` | 32+ random characters (Vercel sends it to the cron endpoints) |
| `BASE_DOMAIN` | your domain, e.g. `brandcanvas.app` |
| `PUBLIC_BASE_URL` | `https://<BASE_DOMAIN>` to run in path mode (`/t/<slug>`), the simplest start |
| `STORAGE_DRIVER` | `s3`, plus `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` |
| `EMAIL_PROVIDER` | `resend`, plus `RESEND_API_KEY` and `EMAIL_FROM` |
| `IMAGE_PROVIDER` | `mock` (local logo clean-up) unless you have a provider key |
| `DELIVERY_WORKER` | `off` |
| `PROOF_WORKER` | `after` |
| `SUPPLIER_WORKER` | `after` |
| `TRUST_PROXY` | `true` |

The app refuses to start on Vercel with local-disk storage or in-process workers, and says which
setting to change.

5. **Domain.** Point `BASE_DOMAIN` at the project. In path mode the storefronts are
   `https://<BASE_DOMAIN>/t/<slug>`; per-tenant subdomains need a wildcard domain (Vercel Pro).

## How background work runs there
- **Right after the request that caused it** (Next.js `after()`): pre-rendering proofs after a logo
  upload, a supplier sync after "Sync now". A new lead's CRM delivery is tried during the request.
- **Daily**, from `vercel.json`: supplier refresh 03:00, maintenance 03:30, CRM delivery retries
  06:00, leftover proof renders 06:15 (UTC). The Hobby plan only allows daily schedules; on Pro,
  change deliveries to every 5 minutes (`*/5 * * * *`) so failed CRM deliveries retry promptly.
- **Time limit:** functions stop after 60 s on Hobby. Proof rendering stays within it; a supplier
  sync of hundreds of products may not. A cut-off sync is taken over by the next run after its
  30-minute lock expires, so on Hobby keep supplier syncs small by listing product IDs.

## Checking it
- `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/maintenance` → `200`
  with a JSON summary (without the header: `401`; with no `CRON_SECRET` set: `404`).
- Sign in at `https://<domain>/t/demo/admin` with the `SEED_ADMIN_EMAIL` address; the link arrives by email.
