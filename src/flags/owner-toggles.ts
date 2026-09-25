/**
 * Storefront features an owner may switch off (or back on) for their own site — ADR 0013.
 * Only features that exist, are optional for a distributor, and are enforced on the server as well
 * as the storefront. Core features (logo upload, proofs), admin capabilities (pricing, CRM routing,
 * domain, team) and placeholder flags are deliberately absent. The email gate has its own setting.
 *
 * A switch refines within the plan: it can turn an included feature off, never unlock one
 * (ADR 0003 precedence: kill switch → plan → tenant override → default).
 */
import type { FlagKey } from './registry';

export interface OwnerToggle {
  key: FlagKey;
  label: string;
  help: string;
}

export const OWNER_TOGGLES = [
  { key: 'quote_requests', label: 'Quote requests', help: 'Prospects can ask for a quote on any product. Requests arrive in your inbox.' },
  { key: 'all_lead_paths', label: 'Downloadable product sheets', help: 'Prospects can download a branded PDF of a product with their logo on it.' },
  { key: 'basic_facets', label: 'Catalog filters', help: 'Prospects can filter by colour, product type and price.' },
  { key: 'qty_price_break_preview', label: 'Quantity price breaks', help: 'Show how the price per item drops at larger quantities.' },
  { key: 'sustainable_filter', label: 'Sustainable filter', help: 'Prospects can show only sustainable products.' },
  { key: 'auto_bg_removal', label: 'Automatic logo background removal', help: 'Remove the background from uploaded logos. Turn off to keep logos exactly as uploaded.' },
] as const satisfies readonly OwnerToggle[];

export type OwnerToggleKey = (typeof OWNER_TOGGLES)[number]['key'];
export const OWNER_TOGGLE_KEYS: readonly OwnerToggleKey[] = OWNER_TOGGLES.map((t) => t.key);
export const isOwnerToggle = (k: string): k is OwnerToggleKey => (OWNER_TOGGLE_KEYS as readonly string[]).includes(k);
