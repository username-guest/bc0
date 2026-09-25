import { FLAGS, PLAN_ORDER, type FlagKey, type Plan } from './registry';

export type EvalReason =
  | 'kill_switch'
  | 'not_entitled'
  | 'tenant_override'
  | 'user_override'
  | 'default';

export interface FlagResult {
  key: FlagKey;
  enabled: boolean;
  locked: boolean; // true when the plan does not entitle it (upsell surface)
  reason: EvalReason;
}

export interface EvalContext {
  plan: Plan;
  /** Flags globally killed by platform_admin. */
  globalKillSwitches?: ReadonlySet<string>;
  /** Per-tenant overrides (only meaningful for entitled flags). */
  tenantOverrides?: Readonly<Record<string, boolean>>;
  /** Per-role/user overrides — highest-priority override. */
  userOverrides?: Readonly<Record<string, boolean>>;
}

/**
 * Server-authoritative evaluation (§6). Precedence, highest wins:
 *   global kill-switch → plan entitlement → tenant override → user override → default.
 * NEVER call this from the client — the client receives a snapshot and gates presentation only.
 */
export function evaluate(key: FlagKey, ctx: EvalContext): FlagResult {
  const flag = FLAGS[key];

  // 1. Global kill-switch (only for killSwitchable flags) — beats everything.
  if (flag.killSwitchable && ctx.globalKillSwitches?.has(key)) {
    return { key, enabled: false, locked: false, reason: 'kill_switch' };
  }

  // 2. Plan entitlement — a flag above the tenant's plan is locked off. Overrides can't unlock it.
  const entitled = PLAN_ORDER[ctx.plan] >= PLAN_ORDER[flag.minPlan];
  if (!entitled) {
    return { key, enabled: false, locked: true, reason: 'not_entitled' };
  }

  // 3. User/role override (highest-priority refinement within entitled features).
  if (ctx.userOverrides && key in ctx.userOverrides) {
    return { key, enabled: ctx.userOverrides[key]!, locked: false, reason: 'user_override' };
  }

  // 4. Tenant override.
  if (ctx.tenantOverrides && key in ctx.tenantOverrides) {
    return { key, enabled: ctx.tenantOverrides[key]!, locked: false, reason: 'tenant_override' };
  }

  // 5. Default.
  return { key, enabled: flag.default, locked: false, reason: 'default' };
}

/** Build the full snapshot sent to the client (presentation gating only). */
export function buildFlagSnapshot(ctx: EvalContext): Record<FlagKey, FlagResult> {
  const out = {} as Record<FlagKey, FlagResult>;
  for (const key of Object.keys(FLAGS) as FlagKey[]) out[key] = evaluate(key, ctx);
  return out;
}
