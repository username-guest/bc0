/**
 * Tenant admin contracts (ADR 0008). Everything here is tenant-scoped: every method takes the
 * tenant id and the Postgres implementations run inside withTenant (RLS).
 */
import type { LeadSettings } from '@/features/leads/rules';
import type { TenantBranding } from '@/server/tenancy/context';
import type { TenantPricingConfig } from '@/pricing/types';

export type AdminRole = 'tenant_owner' | 'tenant_admin';

export interface AdminUser {
  id: string;
  tenantId: string;
  email: string; // lower-cased
  role: AdminRole;
}

/** A row in the team list (ADR 0011). */
export interface TeamMember extends AdminUser {
  createdAt: string;
  lastSignInAt: string | null;
  invitedBy: string | null;
}

/** `last_owner`: refused because the tenant would be left without an owner. */
export type TeamChange = 'ok' | 'not_found' | 'last_owner';

export interface AdminSession {
  id: string;
  tenantId: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

export interface AdminAuthStore {
  findUserByEmail(tenantId: string, email: string): Promise<AdminUser | null>;
  getUser(tenantId: string, id: string): Promise<AdminUser | null>;
  /** Stores only the SHA-256 of the token. */
  createLoginToken(t: { id: string; tenantId: string; userId: string; tokenHash: string; expiresAt: Date; createdAt: Date }): Promise<void>;
  /**
   * Single use, atomically: marks the token used and returns its user id, or null if it is
   * unknown, expired or already used. Two concurrent consumes can't both succeed.
   */
  consumeLoginToken(tenantId: string, tokenHash: string, now: Date): Promise<string | null>;
  createSession(s: AdminSession & { tokenHash: string; createdAt: Date }): Promise<void>;
  /** Live (unexpired, unrevoked) session for this token hash, else null. */
  findSession(tenantId: string, tokenHash: string, now: Date): Promise<AdminSession | null>;
  revokeSession(tenantId: string, id: string, now: Date): Promise<void>;
  /**
   * Maintenance (ADR 0010): deletes login tokens that expired or were used before `tokensBefore`,
   * and sessions that expired or were revoked before `sessionsBefore`. Returns rows removed.
   */
  sweep(tenantId: string, cutoffs: { tokensBefore: Date; sessionsBefore: Date }): Promise<{ tokens: number; sessions: number }>;

  /* Team (ADR 0011) */
  listMembers(tenantId: string): Promise<TeamMember[]>;
  /** `exists` if that email already has access to this tenant. */
  addMember(m: { id: string; tenantId: string; email: string; role: AdminRole; invitedBy: string; createdAt: Date }): Promise<'created' | 'exists'>;
  /**
   * Both refuse (`last_owner`) to leave the tenant without an owner. The check and the write are
   * one atomic step: two owners demoting each other at once can't both succeed.
   * Removing a member deletes their sign-in links and sessions (FK cascade): access ends at once.
   */
  changeRole(tenantId: string, id: string, role: AdminRole): Promise<TeamChange>;
  removeMember(tenantId: string, id: string): Promise<TeamChange>;
  recordSignIn(tenantId: string, id: string, at: Date): Promise<void>;
}

export interface TenantSettingsWriter {
  updateBranding(tenantId: string, b: Omit<TenantBranding, 'logoUrl'>): Promise<void>;
  updateLeadSettings(tenantId: string, s: LeadSettings): Promise<void>;
  updatePricingConfig(tenantId: string, c: TenantPricingConfig): Promise<void>;
  /**
   * Owner feature switches (ADR 0013). Replaces the tenant-scope overrides for exactly the `managed`
   * keys: each key in `overrides` is stored, every other managed key is cleared (back to default).
   * Overrides for keys outside `managed` (set by operators) are left alone.
   */
  setFlagOverrides(tenantId: string, managed: readonly string[], overrides: Record<string, boolean>): Promise<void>;
}

export interface AuditEntry {
  tenantId: string;
  actor: string; // user id or 'system'
  action: string;
  target?: string;
  at: string;
}

export interface AuditRepo {
  record(e: AuditEntry): Promise<void>;
  recent(tenantId: string, limit: number): Promise<AuditEntry[]>;
}
