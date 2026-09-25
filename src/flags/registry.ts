/**
 * Central, typed feature-flag registry (§6, §7). The feature→plan map lives here as DATA,
 * not scattered `if` statements. Adding a feature = one entry + a plan mapping.
 */
export const PLANS = ['free', 'starter', 'pro', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];
export const PLAN_ORDER: Record<Plan, number> = { free: 0, starter: 1, pro: 2, enterprise: 3 };

export type FlagCategory =
  | 'core'
  | 'mockup'
  | 'catalog'
  | 'leads'
  | 'branding'
  | 'analytics'
  | 'enterprise';

export interface FeatureFlag {
  key: string;
  description: string;
  default: boolean;
  category: FlagCategory;
  killSwitchable: boolean;
  minPlan: Plan; // minimum entitled plan (§7)
}

function f(
  key: string,
  category: FlagCategory,
  minPlan: Plan,
  description: string,
  opts: { default?: boolean; killSwitchable?: boolean } = {},
): FeatureFlag {
  return {
    key,
    category,
    minPlan,
    description,
    default: opts.default ?? true,
    killSwitchable: opts.killSwitchable ?? true,
  };
}

/** Mapping mirrors §7. Tune freely — it is configuration, not code. */
export const FLAGS = {
  // Free / Lead Magnet
  logo_upload_cleanup: f('logo_upload_cleanup', 'core', 'free', 'Logo upload + cleanup'),
  auto_bg_removal: f('auto_bg_removal', 'mockup', 'free', 'Automatic background removal'),
  auto_imprint_detect: f('auto_imprint_detect', 'mockup', 'free', 'Auto imprint-zone detection'),
  brand_exact_proof: f('brand_exact_proof', 'mockup', 'free', 'Brand-Exact proof render'),
  core_catalog: f('core_catalog', 'catalog', 'free', 'Core catalog'),
  basic_facets: f('basic_facets', 'catalog', 'free', 'Basic facets (color, family, type, price)'),
  qty_price_break_preview: f('qty_price_break_preview', 'catalog', 'free', 'Quantity/price-break preview'),
  lead_email_gate: f('lead_email_gate', 'leads', 'free', 'Email-gate lead capture'),

  // Starter
  all_decoration_methods: f('all_decoration_methods', 'mockup', 'starter', 'All decoration methods'),
  quote_requests: f('quote_requests', 'leads', 'starter', 'Per-product quote requests'),
  pdf_catalog_export: f('pdf_catalog_export', 'catalog', 'starter', 'Branded PDF catalog export'),
  custom_branding: f('custom_branding', 'branding', 'starter', 'Custom branding (logo/colors)'),
  imprint_location_picker: f('imprint_location_picker', 'mockup', 'starter', 'Imprint-location picker'),
  screenprint_color_tiering: f('screenprint_color_tiering', 'mockup', 'starter', 'Color-count → screen-print tiering'),
  admin_pricing_config: f('admin_pricing_config', 'branding', 'starter', 'Admin margin & pricing config'),

  // Pro
  ai_lifestyle_render: f('ai_lifestyle_render', 'mockup', 'pro', 'AI Lifestyle renders'),
  shareable_tracked_links: f('shareable_tracked_links', 'catalog', 'pro', 'Shareable tracked catalog links'),
  all_lead_paths: f('all_lead_paths', 'leads', 'pro', 'All three lead paths'),
  crm_webhook_routing: f('crm_webhook_routing', 'leads', 'pro', 'CRM/webhook routing'),
  pms_thread_matching: f('pms_thread_matching', 'mockup', 'pro', 'PMS + thread matching'),
  recolor_to_garment: f('recolor_to_garment', 'mockup', 'pro', 'Recolor logo to garment preview'),
  saved_favorites_bundles: f('saved_favorites_bundles', 'catalog', 'pro', 'Favorites / build-a-bundle'),
  analytics_dashboard: f('analytics_dashboard', 'analytics', 'pro', 'Analytics dashboard'),
  inventory_aware_display: f('inventory_aware_display', 'catalog', 'pro', 'Inventory-aware display'),
  sustainable_filter: f('sustainable_filter', 'catalog', 'pro', 'Sustainable filter'),

  // Enterprise
  custom_domain: f('custom_domain', 'enterprise', 'enterprise', 'Custom domain'),
  multi_user_admin: f('multi_user_admin', 'enterprise', 'enterprise', 'Multi-user admin + roles'),
  api_access: f('api_access', 'enterprise', 'enterprise', 'API access'),
  promostandards_live: f('promostandards_live', 'enterprise', 'enterprise', 'PromoStandards live adapters'),
  sso: f('sso', 'enterprise', 'enterprise', 'SSO'),
  audit_log_export: f('audit_log_export', 'enterprise', 'enterprise', 'Audit-log export'),
  company_store_mode: f('company_store_mode', 'enterprise', 'enterprise', 'Company-store mode'),
} satisfies Record<string, FeatureFlag>;

export type FlagKey = keyof typeof FLAGS;
