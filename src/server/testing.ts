/** Test/dev fixture: three tenants on different plans over in-memory repos + storage. */
import { createPublicApi } from './http/public-api';
import { MockStorageProvider } from '@/shared/providers/mocks';
import type { StorageProvider } from '@/shared/providers';
import type { ImageCodec } from '@/features/logo-intake/intake';
import { DEMO_CATALOG, DEMO_TENANT_ID } from '@/core/domain/demo-catalog';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';
import { FixedWindowLimiter } from './rate-limit';
import { MemoryAdminAuthStore, MemoryAnalyticsRepo, MemoryApiKeyRepo, MemoryProofJobRepo, MemoryAuditRepo, MemoryDeliveryRepo, MemoryLeadRepo, MemoryLogoRepo, MemoryProductRepo, MemorySupplierRepo, MemoryTenantDirectory } from './repos/memory';
import { createSupplierService } from './suppliers/service';
import { SoapError, type SoapPost } from '@/integrations/promostandards/soap';
import { withFakeSupplier } from '@/integrations/promostandards/fake-supplier';
import { devSecretBox, type SecretBox } from './crypto/secret-box';
import type { WebhookOptions } from '@/shared/providers/webhook-crm';
import { MemorySessionStore } from './session';
import { MockCrmProvider, MockEmailProvider } from '@/shared/providers/mocks';
import type { EmailProvider } from '@/shared/providers';
import { createAdminApi } from './http/admin-api';
import { makeAdminUrl, makeApiUrl } from './admin/urls';
import type { AdminUser } from './admin/types';
import { createCrmRouter } from './crm';
import { createTenantApi } from './http/api';
import type { TenantRecord } from './tenancy/context';

export const FREE_TENANT_ID = '00000000-0000-4000-8000-0000000000f1';
export const ENT_TENANT_ID = '00000000-0000-4000-8000-0000000000e1';

/** Seeded admin accounts: demo has an owner and a (non-owner) admin; basic (Free) has an owner. */
export function fixtureAdmins(): AdminUser[] {
  return [
    { id: '00000000-0000-4000-8000-00000000a001', tenantId: DEMO_TENANT_ID, email: 'owner@demo.test', role: 'tenant_owner' },
    { id: '00000000-0000-4000-8000-00000000a002', tenantId: DEMO_TENANT_ID, email: 'staff@demo.test', role: 'tenant_admin' },
    { id: '00000000-0000-4000-8000-00000000a003', tenantId: FREE_TENANT_ID, email: 'owner@basic.test', role: 'tenant_owner' },
    // Enterprise: the plan where inviting teammates ("Multi-user admin", §7) is included.
    { id: '00000000-0000-4000-8000-00000000a004', tenantId: ENT_TENANT_ID, email: 'owner@bigco.test', role: 'tenant_owner' },
    { id: '00000000-0000-4000-8000-00000000a005', tenantId: ENT_TENANT_ID, email: 'staff@bigco.test', role: 'tenant_admin' },
  ];
}

export function fixtureTenants(): TenantRecord[] {
  const base = { pricingConfig: PLACEHOLDER_TENANT_CONFIG, flagOverrides: {} };
  return [
    {
      ...base,
      id: DEMO_TENANT_ID,
      slug: 'demo',
      name: 'Demo Distributor',
      plan: 'pro',
      leads: { gate: { mode: 'hard', freeProducts: 3 }, routing: { provider: 'mock' }, contactName: 'Jordan at Demo Promo Co.' },
      branding: { displayName: 'Demo Promo Co.', primaryHex: '#0E8C8C', secondaryHex: '#0B2530', fontFamily: 'Inter' },
    },
    {
      ...base,
      id: FREE_TENANT_ID,
      slug: 'basic',
      name: 'Basic Promo',
      plan: 'free',
      leads: { gate: { mode: 'soft', freeProducts: 3 }, routing: { provider: 'mock' } },
      branding: { displayName: 'Basic Promo', primaryHex: '#E8722A', secondaryHex: '#222222', fontFamily: 'Georgia' },
    },
    {
      ...base,
      id: ENT_TENANT_ID,
      slug: 'bigco',
      name: 'BigCo Merch',
      plan: 'enterprise',
      customDomain: 'shop.bigco.com',
      leads: { gate: { mode: 'off', freeProducts: 0 }, routing: { provider: 'mock' } },
      branding: { displayName: 'BigCo Merch', primaryHex: '#6B3FA0', secondaryHex: '#1B1030', fontFamily: 'Inter' },
    },
  ];
}

export function buildFixture(
  opts: {
    uploadLimit?: number;
    proofLimit?: number;
    visitLimit?: number;
    apiLimit?: number;
    onProofJobsQueued?: () => void;
    leadLimit?: number;
    windowMs?: number;
    tenants?: TenantRecord[];
    allowInsecureWebhooks?: boolean;
    /** Simulated DNS for webhook hosts (the SSRF guard still applies). */
    resolver?: WebhookOptions['resolver'];
    now?: () => Date;
    secrets?: SecretBox;
    email?: EmailProvider;
    signInLimit?: number;
    publicBaseUrl?: string;
    maxUploadBytes?: number;
    trustProxy?: boolean;
    storage?: StorageProvider;
    codec?: ImageCodec;
    /** PromoStandards transport (ADR 0017). Default: the fake supplier on its reserved host, nothing else. */
    supplierPost?: SoapPost;
    onSuppliersQueued?: () => void;
  } = {},
) {
  const tenants = opts.tenants ?? fixtureTenants();
  const directory = new MemoryTenantDirectory(tenants);
  const products = new MemoryProductRepo(Object.fromEntries(tenants.map((t) => [t.id, DEMO_CATALOG])));
  const logos = new MemoryLogoRepo();
  const storage = opts.storage ?? new MockStorageProvider();
  const leads = new MemoryLeadRepo();
  const sessions = new MemorySessionStore();
  const crm = new MockCrmProvider();
  const deliveries = new MemoryDeliveryRepo();
  const analytics = new MemoryAnalyticsRepo();
  const proofJobs = new MemoryProofJobRepo();
  const apiKeys = new MemoryApiKeyRepo();
  const suppliers = new MemorySupplierRepo(products);
  const secrets: SecretBox = opts.secrets ?? devSecretBox();
  const crmFor = createCrmRouter({
    secrets,
    mock: crm,
    allowInsecureWebhooks: opts.allowInsecureWebhooks ?? false,
    ...(opts.resolver ? { resolver: opts.resolver } : {}),
  });
  const api = createTenantApi({
    logos,
    products,
    storage,
    leads,
    sessions,
    deliveries,
    analytics,
    proofJobs,
    ...(opts.onProofJobsQueued ? { onProofJobsQueued: opts.onProofJobsQueued } : {}),
    crmFor,
    sessionSecret: 'test-session-secret-not-for-production',
    secureCookies: false,
    limits: {
      lead: new FixedWindowLimiter(opts.leadLimit ?? 100, opts.windowMs ?? 60_000),
      upload: new FixedWindowLimiter(opts.uploadLimit ?? 100, opts.windowMs ?? 60_000),
      proof: new FixedWindowLimiter(opts.proofLimit ?? 1000, opts.windowMs ?? 60_000),
      visit: new FixedWindowLimiter(opts.visitLimit ?? 1000, opts.windowMs ?? 60_000),
    },
    maxUploadBytes: opts.maxUploadBytes ?? 10 * 1024 * 1024,
    trustProxy: opts.trustProxy ?? false,
    ...(opts.codec ? { codec: opts.codec } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const publicApi = createPublicApi({
    keys: apiKeys,
    leads,
    products,
    analytics,
    limit: new FixedWindowLimiter(opts.apiLimit ?? 600, opts.windowMs ?? 60_000),
    now: opts.now ?? (() => new Date()),
  });
  const supplierService = createSupplierService({
    suppliers,
    catalog: products,
    secrets,
    // Tests never touch the network: anything but the fake supplier's host is refused.
    post: opts.supplierPost ?? withFakeSupplier(async () => Promise.reject(new SoapError('No network in tests', 'network'))),
    now: opts.now ?? (() => new Date()),
    ...(opts.onSuppliersQueued ? { onQueued: opts.onSuppliersQueued } : {}),
    log: () => {},
  });
  const email = opts.email ?? new MockEmailProvider();
  const auth = new MemoryAdminAuthStore(fixtureAdmins());
  const audit = new MemoryAuditRepo();
  const admin = createAdminApi({
    auth,
    settings: directory,
    audit,
    email,
    leads,
    products,
    deliveries,
    delivery: api.delivery,
    analytics,
    apiKeys,
    suppliers: { repo: suppliers, service: supplierService },
    secrets,
    limits: {
      signIn: new FixedWindowLimiter(opts.signInLimit ?? 100, opts.windowMs ?? 60_000),
      signInEmail: new FixedWindowLimiter(5, 15 * 60_000),
      invite: new FixedWindowLimiter(20, 3_600_000),
    },
    adminUrl: makeAdminUrl({ publicBaseUrl: opts.publicBaseUrl ?? 'http://localhost:3000', baseDomain: 'brandcanvas.app' }),
    apiUrl: makeApiUrl({ publicBaseUrl: opts.publicBaseUrl ?? 'http://localhost:3000', baseDomain: 'brandcanvas.app' }),
    secureCookies: false,
    trustProxy: opts.trustProxy ?? false,
    webhook: { allowInsecure: opts.allowInsecureWebhooks ?? false, ...(opts.resolver ? { resolver: opts.resolver } : {}) },
    now: opts.now ?? (() => new Date()),
    newId: () => crypto.randomUUID(),
    log: () => {},
  });
  return { api, admin, auth, audit, email, directory, products, logos, storage, tenants, leads, sessions, crm, deliveries, secrets, crmFor, analytics, proofJobs, apiKeys, publicApi, suppliers, supplierService };
}
