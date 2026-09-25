import type { RateWindowStore } from '@/server/rate-limit';
/** Typed stand-in for src/server/repos/drizzle.ts: checks that runtime.ts uses the right contracts. */
import type { TenantDirectory } from '@/server/tenancy/context';
import type { AdminAuthStore, AuditRepo, TenantSettingsWriter } from '@/server/admin/types';
import type { SupplierCatalogWriter, SupplierRepo, ApiKeyRepo, ProofJobRepo, AnalyticsRepo, DeliveryRepo, LeadRepo, LogoRepo, ProductRepo } from '@/server/repos/types';
import type { SessionStore } from '@/server/session';
export declare class DrizzleTenantDirectory implements TenantDirectory, TenantSettingsWriter {
  updateBranding: TenantSettingsWriter['updateBranding'];
  updateLeadSettings: TenantSettingsWriter['updateLeadSettings'];
  updatePricingConfig: TenantSettingsWriter['updatePricingConfig'];
  setFlagOverrides: TenantSettingsWriter['setFlagOverrides'];
  findBySlug: TenantDirectory['findBySlug'];
  findByDomain: TenantDirectory['findByDomain'];
  listSlugs: TenantDirectory['listSlugs'];
  globalKillSwitches: TenantDirectory['globalKillSwitches'];
}
export declare class DrizzleProductRepo implements ProductRepo, SupplierCatalogWriter {
  list: ProductRepo['list'];
  get: ProductRepo['get'];
  applySupplierImport: SupplierCatalogWriter['applySupplierImport'];
}
export declare class DrizzleSupplierRepo implements SupplierRepo {
  list: SupplierRepo['list'];
  get: SupplierRepo['get'];
  create: SupplierRepo['create'];
  update: SupplierRepo['update'];
  remove: SupplierRepo['remove'];
  transition: SupplierRepo['transition'];
  finish: SupplierRepo['finish'];
  due: SupplierRepo['due'];
}
export declare class DrizzleLogoRepo implements LogoRepo {
  create: LogoRepo['create'];
  get: LogoRepo['get'];
  findByHash: LogoRepo['findByHash'];
  update: LogoRepo['update'];
}
export declare class DrizzleLeadRepo implements LeadRepo {
  upsertByEmail: LeadRepo['upsertByEmail'];
  get: LeadRepo['get'];
  addEvent: LeadRepo['addEvent'];
  events: LeadRepo['events'];
  list: LeadRepo['list'];
}
export declare class DrizzleSessionStore implements SessionStore {
  get: SessionStore['get'];
  save: SessionStore['save'];
}
export declare class DrizzleDeliveryRepo implements DeliveryRepo {
  create: DeliveryRepo['create'];
  get: DeliveryRepo['get'];
  update: DeliveryRepo['update'];
  claimDue: DeliveryRepo['claimDue'];
  forLead: DeliveryRepo['forLead'];
  statusesFor: DeliveryRepo['statusesFor'];
  leadIdsWithStatus: DeliveryRepo['leadIdsWithStatus'];
}
export declare class DrizzleAdminAuthStore implements AdminAuthStore {
  findUserByEmail: AdminAuthStore['findUserByEmail'];
  getUser: AdminAuthStore['getUser'];
  createLoginToken: AdminAuthStore['createLoginToken'];
  consumeLoginToken: AdminAuthStore['consumeLoginToken'];
  createSession: AdminAuthStore['createSession'];
  findSession: AdminAuthStore['findSession'];
  revokeSession: AdminAuthStore['revokeSession'];
  sweep: AdminAuthStore['sweep'];
  listMembers: AdminAuthStore['listMembers'];
  addMember: AdminAuthStore['addMember'];
  changeRole: AdminAuthStore['changeRole'];
  removeMember: AdminAuthStore['removeMember'];
  recordSignIn: AdminAuthStore['recordSignIn'];
}
export declare class DrizzleAuditRepo implements AuditRepo {
  record: AuditRepo['record'];
  recent: AuditRepo['recent'];
}
export declare class DrizzleRateWindowStore implements RateWindowStore {
  bump(key: string, windowMs: number, now: number): Promise<{ count: number; windowStart: number }>;
  sweep(before: number): Promise<number>;
}
export declare class DrizzleAnalyticsRepo implements AnalyticsRepo {
  listLinks: AnalyticsRepo['listLinks'];
  getLink: AnalyticsRepo['getLink'];
  findActiveLinkByCode: AnalyticsRepo['findActiveLinkByCode'];
  countActiveLinks: AnalyticsRepo['countActiveLinks'];
  createLink: AnalyticsRepo['createLink'];
  updateLink: AnalyticsRepo['updateLink'];
  record: AnalyticsRepo['record'];
  counts: AnalyticsRepo['counts'];
  sweep: AnalyticsRepo['sweep'];
}
export declare class DrizzleProofJobRepo implements ProofJobRepo {
  enqueue: ProofJobRepo['enqueue'];
  pendingCount: ProofJobRepo['pendingCount'];
  claimDue: ProofJobRepo['claimDue'];
  finish: ProofJobRepo['finish'];
  list: ProofJobRepo['list'];
  sweep: ProofJobRepo['sweep'];
}
export declare class DrizzleApiKeyRepo implements ApiKeyRepo {
  list: ApiKeyRepo['list'];
  create: ApiKeyRepo['create'];
  findActive: ApiKeyRepo['findActive'];
  countActive: ApiKeyRepo['countActive'];
  revoke: ApiKeyRepo['revoke'];
  touch: ApiKeyRepo['touch'];
}
