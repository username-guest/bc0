/**
 * The upgrade seam (§11). Every external capability is an interface selected by config per
 * environment/tenant. Business logic depends ONLY on these interfaces; adapters (real or mock)
 * are swapped without touching callers. A working mock ships for each so the app runs with zero
 * external services (§17).
 */
import type { DecorationMethodKey } from '@/pricing/types';

export interface AssetRef {
  id: string;
  url: string;
  contentType: string;
  bytes: number;
  tenantId: string;
}

/* ---- Storage ---- */
export interface StoredObject {
  data: Uint8Array;
  contentType: string;
}
export interface StorageProvider {
  put(key: string, data: Uint8Array, contentType: string, tenantId: string): Promise<AssetRef>;
  /** Tenant-scoped read. Returns null when absent (never another tenant's object). */
  get(key: string, tenantId: string): Promise<StoredObject | null>;
  getUrl(key: string, tenantId: string): Promise<string>;
  delete(key: string, tenantId: string): Promise<void>;
}

/* ---- Background removal (Stage A) ---- */
export interface BackgroundRemovalProvider {
  remove(input: AssetRef): Promise<AssetRef>;
}

/* ---- Logo color analysis (Stage A) ---- */
export interface ColorExtractionResult {
  dominantHexes: string[]; // ordered by coverage
  colorCount: number; // feeds screen-print tiering & PMS suggestions
  isVector: boolean;
}
export interface LogoAnalyzer {
  analyze(input: AssetRef): Promise<ColorExtractionResult>;
}

/* ---- Vision: imprint-zone detection (Stage B) ---- */
export interface ImprintZone {
  label: string; // e.g. 'left_chest', 'full_front'
  bbox: { x: number; y: number; w: number; h: number }; // normalized 0..1
  confidence: number; // 0..1
}
export interface VisionResult {
  productType: string;
  material: string;
  zones: ImprintZone[];
  bestZone: ImprintZone;
}
export interface VisionAnalyzer {
  analyze(product: AssetRef): Promise<VisionResult>;
}

/* ---- Image generation / editing (Stage C, AI Lifestyle only) ---- */
export interface RenderRequest {
  logo: AssetRef;
  productImage: AssetRef;
  zone: ImprintZone;
  method: DecorationMethodKey;
  mode: 'brand_exact' | 'ai_lifestyle';
  brandHexes: string[];
  scenePrompt?: string;
  tenantId: string;
}
export interface ImageGenerationProvider {
  /** Brand-Exact is deterministic compositing and needs no model (ADR 0004). */
  render(req: RenderRequest): Promise<AssetRef>;
}

/* ---- Product data (manual/CSV now; PromoStandards later) ---- */
export interface ProductDataProvider {
  list(tenantId: string): Promise<unknown[]>;
}

/* ---- Pricing (placeholder rules now; live supplier feed later) ---- */
export interface PricingProvider {
  ratesFor(tenantId: string): Promise<unknown>;
}

/* ---- CRM / lead routing (§9) ---- */
export interface LeadPayload {
  tenantId: string;
  email: string;
  source: 'email_gate' | 'quote_request' | 'pdf_leavebehind';
  productInterest?: string;
  proofRefs?: string[];
  marketingOptIn: boolean;
  tracking?: Record<string, string>;
  /** Stable id of the stored lead, so CRMs can dedupe re-deliveries. */
  leadId?: string;
  /** Stable id of this delivery (one per capture); identical on every retry. */
  deliveryId?: string;
  contact?: { name?: string; company?: string; phone?: string };
  /** Source-specific detail, e.g. the configuration + server-computed estimate for a quote. */
  details?: Record<string, unknown>;
}
export interface CrmProvider {
  route(lead: LeadPayload): Promise<{ id: string; routedTo: string }>;
}

/** Transactional email (admin sign-in links today). ADR 0008. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}
