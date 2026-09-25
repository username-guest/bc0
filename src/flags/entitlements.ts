/**
 * Entitlements derived from flags (server-side). Kept as DATA so plan packaging can change
 * without touching business logic (ADR 0006).
 */
import type { DecorationMethodKey } from '@/pricing/types';
import type { FlagResult } from './evaluate';
import type { FlagKey } from './registry';
import { DECORATION_METHOD_KEYS } from '@/core/domain/decoration-methods';

/**
 * Methods available WITHOUT `all_decoration_methods` (Free tier): one flagship per product
 * family — printed apparel, stitched apparel, hard goods. The original spec's exact list was
 * not recoverable, so this is a documented default (ADR 0006), not a spec quote.
 */
export const BASE_TIER_METHODS: readonly DecorationMethodKey[] = ['screen_print', 'embroidery', 'laser_engraving'];

export type FlagSnapshot = Record<FlagKey, FlagResult>;

export function entitledMethods(snap: FlagSnapshot): DecorationMethodKey[] {
  return snap.all_decoration_methods.enabled ? [...DECORATION_METHOD_KEYS] : [...BASE_TIER_METHODS];
}
