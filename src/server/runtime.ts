/**
 * Process-wide server runtime for the Next.js app: repositories, storage, limiters, API.
 * Selected by env (ADR 0006). Postgres modules are imported lazily so DATA_MODE=memory never
 * loads the pg driver.
 */
import { createPublicApi, type PublicApi } from '@/server/http/public-api';
import path from 'node:path';
import { cookiesSecure, getEnv } from '@/core/config/env';
import { createTenantApi, type TenantApi } from './http/api';
import { FixedWindowLimiter, MemoryWindowStore, type RateWindowStore } from './rate-limit';
import { startMaintenanceWorker, type MaintenanceDeps } from './jobs/maintenance';
import { buildFixture } from './testing';
import { createCrmRouter } from './crm';
import type { TenantDirectory } from './tenancy/context';
import type { StorageProvider } from '@/shared/providers';
import { warmTemplates } from '@/imaging/templates';
import { MockStorageProvider } from '@/shared/providers/mocks';
import { LocalFsStorageProvider } from '@/shared/providers/local-fs-storage';
import { S3StorageProvider } from '@/shared/providers/s3-storage';
import { createSharpCodec } from '@/features/logo-intake/sharp-codec';
import { createSecretBox, devSecretBox, parseKeyring, type SecretBox } from './crypto/secret-box';
import { startDeliveryWorker } from './jobs/deliveries';
import { runProofJobs, startProofWorker } from './jobs/proofs';
import { createAdminApi, type AdminApi } from './http/admin-api';
import { makeAdminUrl, makeApiUrl } from './admin/urls';
import { createSupplierService, runSupplierSyncs, startSupplierWorker, type SupplierService } from './suppliers/service';
import { afterResponse } from './jobs/after';
import { httpPost } from '@/integrations/promostandards/soap';
import { withFakeSupplier } from '@/integrations/promostandards/fake-supplier';
import { LogEmailProvider } from '@/shared/providers/mocks';
import { ResendEmailProvider } from '@/shared/providers/resend-email';
import type { EmailProvider } from '@/shared/providers';
import { randomUUID } from 'node:crypto';

export interface ServerRuntime {
  api: TenantApi;
  admin: AdminApi;
  directory: TenantDirectory;
  maintenance: MaintenanceDeps;
  /** Public REST API v1 (ADR 0016). */
  publicApi: PublicApi;
  /** Set once the in-process proof worker starts; uploads call it to begin rendering at once. */
  proofNudge: { current: () => void };
  /** Supplier catalog syncs (ADR 0017). */
  suppliers: SupplierService;
  supplierNudge: { current: () => void };
}

let runtime: Promise<ServerRuntime> | null = null;

function makeStorage(): StorageProvider {
  const env = getEnv();
  if (env.STORAGE_DRIVER === 'memory') return new MockStorageProvider();
  if (env.STORAGE_DRIVER === 's3') {
    return new S3StorageProvider({
      bucket: env.STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      accessKeyId: env.STORAGE_ACCESS_KEY ?? '',
      secretAccessKey: env.STORAGE_SECRET_KEY ?? '',
      ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
      ...(env.STORAGE_FORCE_PATH_STYLE !== undefined ? { forcePathStyle: env.STORAGE_FORCE_PATH_STYLE } : {}),
    });
  }
  return new LocalFsStorageProvider(path.resolve(env.LOCAL_STORAGE_DIR));
}

function makeEmail(env: ReturnType<typeof getEnv>): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend') return new ResendEmailProvider(env.RESEND_API_KEY!, env.EMAIL_FROM);
  return new LogEmailProvider();
}

/** Tenant-secret keyring. Production requires SETTINGS_ENCRYPTION_KEYS (env validation). */
function makeSecrets(env: ReturnType<typeof getEnv>): SecretBox {
  if (!env.SETTINGS_ENCRYPTION_KEYS) return devSecretBox();
  const ring = parseKeyring(env.SETTINGS_ENCRYPTION_KEYS);
  return createSecretBox(ring.keys, ring.current);
}

/** Cookie-signing key: AUTH_SECRET in production (env validation requires it); a dev key otherwise. */
function sessionSecret(env: ReturnType<typeof getEnv>): string {
  return env.AUTH_SECRET ?? 'dev-only-session-secret-change-me';
}

async function build(): Promise<ServerRuntime> {
  const env = getEnv();
  const storage = makeStorage();
  // sharp adds JPEG/WebP/SVG/PDF; without it, uploads are PNG-only with a clear 415.
  const codec = (await createSharpCodec()) ?? undefined;
  const secrets = makeSecrets(env);
  const proofNudge = { current: () => {} };
  const supplierNudge = { current: () => {} };
  // Real suppliers over the guarded transport; the fake one only when explicitly enabled (dev/tests).
  const supplierPost = env.PROMOSTANDARDS_FAKE_SUPPLIER ? withFakeSupplier(httpPost()) : httpPost();
  if (env.DATA_MODE === 'memory') {
    const fx = buildFixture({
      secrets,
      email: makeEmail(env),
      signInLimit: env.ADMIN_SIGNIN_RATE_MAX,
      ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
      storage,
      maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
      uploadLimit: env.UPLOAD_RATE_MAX,
      proofLimit: env.PROOF_RATE_MAX,
      leadLimit: env.LEAD_RATE_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      trustProxy: env.TRUST_PROXY,
      onProofJobsQueued: () => proofNudge.current(),
      supplierPost,
      onSuppliersQueued: () => supplierNudge.current(),
      ...(codec ? { codec } : {}),
    });
    return { api: fx.api, admin: fx.admin, directory: fx.directory, maintenance: { directory: fx.directory, auth: fx.auth, rateStore: new MemoryWindowStore(), analytics: fx.analytics, proofJobs: fx.proofJobs }, publicApi: fx.publicApi, proofNudge, suppliers: fx.supplierService, supplierNudge };
  }
  const { DrizzleAdminAuthStore, DrizzleAnalyticsRepo, DrizzleAuditRepo, DrizzleProofJobRepo, DrizzleApiKeyRepo, DrizzleDeliveryRepo, DrizzleLeadRepo, DrizzleLogoRepo, DrizzleProductRepo, DrizzleRateWindowStore, DrizzleSessionStore, DrizzleSupplierRepo, DrizzleTenantDirectory } = await import('@/server/repos/drizzle');
  // One store for every limiter; names keep their budgets apart (ADR 0010).
  const rateStore: RateWindowStore = (env.RATE_LIMIT_STORE ?? 'postgres') === 'postgres' ? new DrizzleRateWindowStore() : new MemoryWindowStore();
  const limiter = (name: string, max: number, windowMs: number) => new FixedWindowLimiter(max, windowMs, { store: rateStore, name });
  const products = new DrizzleProductRepo();
  const analytics = new DrizzleAnalyticsRepo();
  const proofJobs = new DrizzleProofJobRepo();
  const apiKeys = new DrizzleApiKeyRepo();
  const supplierRepo = new DrizzleSupplierRepo();
  const suppliers = createSupplierService({ suppliers: supplierRepo, catalog: products, secrets, post: supplierPost, now: () => new Date(), onQueued: () => supplierNudge.current() });
  const api = createTenantApi({
    logos: new DrizzleLogoRepo(),
    products,
    storage,
    leads: new DrizzleLeadRepo(),
    sessions: new DrizzleSessionStore(),
    deliveries: new DrizzleDeliveryRepo(),
    analytics,
    proofJobs,
    onProofJobsQueued: () => proofNudge.current(),
    crmFor: createCrmRouter({ secrets }),
    sessionSecret: sessionSecret(env),
    secureCookies: cookiesSecure(env),
    limits: {
      lead: limiter('lead', env.LEAD_RATE_MAX, env.RATE_LIMIT_WINDOW_MS),
      upload: limiter('upload', env.UPLOAD_RATE_MAX, env.RATE_LIMIT_WINDOW_MS),
      proof: limiter('proof', env.PROOF_RATE_MAX, env.RATE_LIMIT_WINDOW_MS),
      visit: limiter('visit', 120, 60_000),
    },
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    trustProxy: env.TRUST_PROXY,
    ...(codec ? { codec } : {}),
  });
  const directory = new DrizzleTenantDirectory();
  const leads = api.deliveryDeps.leads;
  const auth = new DrizzleAdminAuthStore();
  const admin = createAdminApi({
    auth,
    settings: directory,
    audit: new DrizzleAuditRepo(),
    email: makeEmail(env),
    leads,
    products,
    deliveries: api.deliveryDeps.deliveries,
    delivery: api.delivery,
    analytics,
    apiKeys,
    suppliers: { repo: supplierRepo, service: suppliers },
    secrets,
    limits: {
      signIn: limiter('signin', env.ADMIN_SIGNIN_RATE_MAX, env.RATE_LIMIT_WINDOW_MS),
      signInEmail: limiter('signin-email', 5, 15 * 60_000),
      invite: limiter('invite', 20, 3_600_000),
    },
    adminUrl: makeAdminUrl({ baseDomain: env.BASE_DOMAIN, ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}) }),
    apiUrl: makeApiUrl({ baseDomain: env.BASE_DOMAIN, ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}) }),
    secureCookies: cookiesSecure(env),
    trustProxy: env.TRUST_PROXY,
    now: () => new Date(),
    newId: randomUUID,
  });
  const publicApi = createPublicApi({ keys: apiKeys, leads, products, analytics, limit: limiter('api', 600, 60_000), now: () => new Date() });
  return { api, admin, directory, maintenance: { directory, auth, rateStore, analytics, proofJobs }, publicApi, proofNudge, suppliers, supplierNudge };
}

export function getRuntime(opts: { worker?: boolean } = {}): Promise<ServerRuntime> {
  if (!runtime) {
    runtime = build().then((rt) => {
      const env = getEnv();
      if ((opts.worker ?? true) && env.DELIVERY_WORKER === 'inline') {
        startDeliveryWorker({ directory: rt.directory, delivery: rt.api.delivery }, env.DELIVERY_WORKER_INTERVAL_MS);
        startMaintenanceWorker(rt.maintenance, env.MAINTENANCE_INTERVAL_MS);
      }
      if ((opts.worker ?? true) && env.SUPPLIER_WORKER === 'inline') {
        const w = startSupplierWorker({ directory: rt.directory, service: rt.suppliers }, env.SUPPLIER_WORKER_INTERVAL_MS);
        rt.supplierNudge.current = w.nudge;
      }
      if ((opts.worker ?? true) && env.PROOF_WORKER === 'inline') {
        const w = startProofWorker({ directory: rt.directory, queue: rt.api.proofQueue }, env.PROOF_WORKER_INTERVAL_MS);
        rt.proofNudge.current = w.nudge;
      }
      // Serverless (ADR 0018): no timers; run the work right after the response that queued it.
      // (Set even for worker:false runtimes, e.g. the cron route, since it's request-scoped.)
      if (env.PROOF_WORKER === 'after') {
        rt.proofNudge.current = () => afterResponse(() => runProofJobs({ directory: rt.directory, queue: rt.api.proofQueue, budgetMs: 45_000 }), 'proofs');
      }
      if (env.SUPPLIER_WORKER === 'after') {
        rt.supplierNudge.current = () => afterResponse(() => runSupplierSyncs({ directory: rt.directory, service: rt.suppliers }), 'suppliers');
      }
      return rt;
    });
    // Pre-build product templates off the request path (first proof would otherwise take ~1.5 s).
    setTimeout(() => warmTemplates(), 0);
  }
  return runtime;
}
