import { z } from 'zod';

/**
 * Schema-validated environment (§12). Import ONLY from server code.
 * Fails fast at boot if anything required is missing or malformed.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BASE_DOMAIN: z.string().default('brandcanvas.app'),
  AUTH_SECRET: z.string().min(16).optional(),

  /** memory = seeded demo tenants, no Postgres (dev/demo); postgres = real, RLS-enforced data. */
  DATA_MODE: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.string().url().optional(),
  APP_DB_ROLE: z.string().default('brandcanvas_app'),

  /** local = filesystem (dev / single node); s3 = S3-compatible (adapter pending, ADR 0006). */
  STORAGE_DRIVER: z.enum(['local', 'memory', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),
  UPLOAD_RATE_MAX: z.coerce.number().int().positive().default(20),
  PROOF_RATE_MAX: z.coerce.number().int().positive().default(240),
  LEAD_RATE_MAX: z.coerce.number().int().positive().default(10),
  /** Where rate-limit counters live (ADR 0010). Default: postgres when DATA_MODE=postgres, else memory. */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).optional(),
  /**
   * Keyring for tenant secrets at rest (ADR 0008): `id:base64(32 bytes)[,id:key…]`, first = current.
   * Generate a key with `openssl rand -base64 32`. Required in production.
   */
  SETTINGS_ENCRYPTION_KEYS: z.string().optional(),
  /**
   * In-process background jobs (single node): CRM delivery retries + maintenance. With `off`, run
   * `npm run jobs:deliveries` and `npm run jobs:maintenance` from cron instead.
   */
  DELIVERY_WORKER: z.enum(['inline', 'off']).default('inline'),
  /** Admin sign-in email (ADR 0008). `log` prints links to the server console (development only). */
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('BrandCanvas <no-reply@brandcanvas.app>'),
  /** Set for path-mode URLs in emails (dev: http://localhost:3000). Unset → tenant hosts. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_SIGNIN_RATE_MAX: z.coerce.number().int().positive().default(10),
  DELIVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  /** In-process maintenance (expired tokens, sessions, rate windows) when DELIVERY_WORKER=inline. */
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  /**
   * Proof pre-rendering (ADR 0015). `inline`: this process renders queued proofs, starting right
   * after each upload. `off`: run `npm run jobs:proofs` from a scheduler or a separate worker
   * process instead (recommended once there are several instances or heavy traffic).
   */
  PROOF_WORKER: z.enum(['inline', 'after', 'off']).default('inline'),
  PROOF_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  /**
   * Supplier catalog syncs (ADR 0017). `inline`: this process runs queued syncs (starting as soon
   * as an owner presses Sync) and the daily refresh. `off`: run `npm run jobs:suppliers` from a
   * scheduler instead (recommended: a large catalog takes minutes).
   */
  SUPPLIER_WORKER: z.enum(['inline', 'after', 'off']).default('inline'),
  SUPPLIER_WORKER_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /**
   * Development and browser tests only: answer requests to https://promostandards.example with the
   * built-in fake supplier (ADR 0017). Refused in production.
   */
  /**
   * Serverless (ADR 0018): the shared secret Vercel Cron sends as `Authorization: Bearer …` to
   * /api/cron/<job>. Unset → those endpoints answer 404.
   */
  CRON_SECRET: z.string().min(32).optional(),
  /** Set to '1' by Vercel itself. Used only to refuse settings that can't work there. */
  VERCEL: z.string().optional(),
  PROMOSTANDARDS_FAKE_SUPPLIER: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  /** S3-compatible endpoint (R2, MinIO…). Omit for AWS S3. */
  STORAGE_ENDPOINT: z.string().url().optional(),
  /** AWS region, or `auto` for Cloudflare R2. */
  STORAGE_REGION: z.string().default('us-east-1'),
  /** `https://host/bucket/key` addressing. Default: true when STORAGE_ENDPOINT is set. */
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  STORAGE_BUCKET: z.string().default('brandcanvas-assets'),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),

  IMAGE_PROVIDER: z.enum(['mock', 'fal', 'replicate', 'openai', 'gemini']).default('mock'),
  IMAGE_PROVIDER_API_KEY: z.string().optional(),
  BG_REMOVAL_PROVIDER: z.enum(['mock', 'local', 'remove_bg']).default('mock'),
  CRM_PROVIDER: z.enum(['mock', 'email', 'webhook', 'hubspot', 'salesforce']).default('mock'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
})
  .refine((e) => e.STORAGE_DRIVER !== 's3' || (!!e.STORAGE_ACCESS_KEY && !!e.STORAGE_SECRET_KEY), {
    message: 'STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY are required when STORAGE_DRIVER=s3',
    path: ['STORAGE_ACCESS_KEY'],
  })
  .refine((e) => e.RATE_LIMIT_STORE !== 'postgres' || e.DATA_MODE === 'postgres', {
    message: 'RATE_LIMIT_STORE=postgres needs DATA_MODE=postgres',
    path: ['RATE_LIMIT_STORE'],
  })
  .refine((e) => e.DATA_MODE !== 'postgres' || !!e.DATABASE_URL, {
    message: 'DATABASE_URL is required when DATA_MODE=postgres',
    path: ['DATABASE_URL'],
  })
  // On Vercel (serverless), local disk isn't kept and timers don't run between requests (ADR 0018).
  .refine((e) => !(e.VERCEL === '1' && e.NODE_ENV === 'production') || e.STORAGE_DRIVER === 's3', {
    message: 'On Vercel, set STORAGE_DRIVER=s3: uploaded logos and proofs are not kept on local disk',
    path: ['STORAGE_DRIVER'],
  })
  .refine(
    (e) => !(e.VERCEL === '1' && e.NODE_ENV === 'production') || (e.DELIVERY_WORKER === 'off' && e.PROOF_WORKER !== 'inline' && e.SUPPLIER_WORKER !== 'inline'),
    {
      message: 'On Vercel, set DELIVERY_WORKER=off, PROOF_WORKER=after and SUPPLIER_WORKER=after (in-process timers do not run there); scheduled work runs through /api/cron',
      path: ['DELIVERY_WORKER'],
    },
  )
  .refine((e) => e.NODE_ENV !== 'production' || !e.PROMOSTANDARDS_FAKE_SUPPLIER, {
    message: 'PROMOSTANDARDS_FAKE_SUPPLIER is for development and tests only',
    path: ['PROMOSTANDARDS_FAKE_SUPPLIER'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.DATA_MODE === 'postgres', {
    message: 'DATA_MODE=memory is for development only',
    path: ['DATA_MODE'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || !!e.AUTH_SECRET, {
    message: 'AUTH_SECRET is required in production',
    path: ['AUTH_SECRET'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || !!e.SETTINGS_ENCRYPTION_KEYS, {
    message: 'SETTINGS_ENCRYPTION_KEYS is required in production',
    path: ['SETTINGS_ENCRYPTION_KEYS'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.EMAIL_PROVIDER !== 'log', {
    message: 'EMAIL_PROVIDER=log prints sign-in links to the console; configure a real provider in production',
    path: ['EMAIL_PROVIDER'],
  })
  .refine((e) => e.EMAIL_PROVIDER !== 'resend' || !!e.RESEND_API_KEY, {
    message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
    path: ['RESEND_API_KEY'],
  })
  .refine((e) => e.IMAGE_PROVIDER === 'mock' || !!e.IMAGE_PROVIDER_API_KEY, {
    message: 'IMAGE_PROVIDER_API_KEY is required unless IMAGE_PROVIDER=mock',
    path: ['IMAGE_PROVIDER_API_KEY'],
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates an environment. A blank value (`STORAGE_ENDPOINT=` in .env) means "not set", so it
 * falls back to the default / optional instead of failing as "set to an invalid value".
 */
/**
 * Whether cookies get the `Secure` attribute. Decided by how the app is actually served, not by
 * NODE_ENV: Safari drops Secure cookies on plain-http origins (including http://localhost, which
 * Chrome exempts), so a production build run over http would silently lose every sign-in there.
 * With PUBLIC_BASE_URL set, its scheme decides. Without it (production on tenant hosts, which are
 * https), production means Secure.
 */
export function cookiesSecure(env: Pick<Env, 'NODE_ENV' | 'PUBLIC_BASE_URL'>): boolean {
  if (env.PUBLIC_BASE_URL) return new URL(env.PUBLIC_BASE_URL).protocol === 'https:';
  return env.NODE_ENV === 'production';
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const set = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  return EnvSchema.parse(set);
}

let cached: Env | null = null;
export function getEnv(): Env {
  if (typeof window !== 'undefined') {
    throw new Error('getEnv() must not be called in the browser — no secrets in client bundles.');
  }
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
