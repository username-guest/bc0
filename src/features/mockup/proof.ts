/**
 * Brand-Exact proof service (§3.3 Stages B–D). Synchronous and deterministic, so it can run
 * inline for a single proof or inside a pg-boss worker for catalog-wide propagation.
 *
 * Guardrail (§17): a proof is only rendered when the imprint zone is trustworthy. Authored
 * template zones have confidence 1.0; vision-detected zones must clear the threshold, otherwise
 * the result is `needs_placement` and NO image is produced — the UI asks for manual placement.
 */
import { createHash } from 'node:crypto';
import type { DecorationMethodKey } from '@/pricing/types';
import type { VisionResult } from '@/shared/providers';
import { encodePng } from '@/imaging/png';
import { renderBrandExact } from '@/imaging/compose';
import { colorway, getTemplate, type TemplateKind, type Zone } from '@/imaging/templates';
import { DECORATION_METHODS } from '@/core/domain/decoration-methods';
import type { ProcessedLogo } from '@/features/logo-intake/intake';

/** The subset of a processed logo the renderer needs — also reconstructible from storage. */
export type ProofLogo = Pick<ProcessedLogo, 'hash' | 'raster' | 'needsReview'> & {
  palette: Pick<ProcessedLogo['palette'], 'colors'>;
};

/** Bump when shader output changes, so cached proofs are invalidated. */
export const RENDERER_VERSION = 'brand-exact@1';
export const ZONE_CONFIDENCE_THRESHOLD = 0.75;

export type ZoneResolution =
  | { status: 'ready'; zone: Zone; source: 'template' | 'vision' }
  | { status: 'needs_placement'; reason: string };

export function resolveZone(kind: TemplateKind, location: string, vision?: VisionResult): ZoneResolution {
  const authored = getTemplate(kind).zones[location];
  if (authored) return { status: 'ready', zone: authored, source: 'template' };
  if (vision) {
    const z = vision.zones.find((v) => v.label === location) ?? vision.bestZone;
    if (z.confidence >= ZONE_CONFIDENCE_THRESHOLD) {
      return {
        status: 'ready',
        zone: { x: z.bbox.x, y: z.bbox.y, w: z.bbox.w, h: z.bbox.h, confidence: z.confidence },
        source: 'vision',
      };
    }
    return {
      status: 'needs_placement',
      reason: `Detected print area confidence ${Math.round(z.confidence * 100)}% is below ${ZONE_CONFIDENCE_THRESHOLD * 100}% — place the logo manually.`,
    };
  }
  return { status: 'needs_placement', reason: `No known print area "${location}" on this product.` };
}

export function proofCacheKey(parts: {
  logoHash: string;
  productRef: string;
  colorHex: string;
  method: DecorationMethodKey;
  location: string;
}): string {
  return createHash('sha256')
    .update([RENDERER_VERSION, parts.logoHash, parts.productRef, parts.colorHex.toUpperCase(), parts.method, parts.location].join('|'))
    .digest('hex')
    .slice(0, 32);
}

export interface ProofSpec {
  logo: ProofLogo;
  productRef: string;
  template: TemplateKind;
  colorHex: string;
  method: DecorationMethodKey;
  location: string;
  vision?: VisionResult;
}

export type ProofOutcome =
  | { status: 'ready'; png: Uint8Array<ArrayBuffer>; cacheKey: string; notes: string[]; zoneSource: 'template' | 'vision' }
  | { status: 'needs_placement'; cacheKey: string; reason: string };

export function renderProof(spec: ProofSpec): ProofOutcome {
  const cacheKey = proofCacheKey({
    logoHash: spec.logo.hash,
    productRef: spec.productRef,
    colorHex: spec.colorHex,
    method: spec.method,
    location: spec.location,
  });
  const z = resolveZone(spec.template, spec.location, spec.vision);
  if (z.status === 'needs_placement') return { status: 'needs_placement', cacheKey, reason: z.reason };

  const template = getTemplate(spec.template);
  const maxColors = DECORATION_METHODS[spec.method].maxColors;
  const result = renderBrandExact({
    product: colorway(template, spec.colorHex),
    template,
    zone: z.zone,
    logo: spec.logo.raster,
    palette: spec.logo.palette.colors,
    method: spec.method,
    substrateHex: spec.colorHex,
    ...(typeof maxColors === 'number' ? { maxSpotColors: maxColors } : {}),
  });
  const notes = [...result.notes];
  if (spec.logo.needsReview) notes.unshift('Logo cleanup needs confirmation — proof may change.');
  return { status: 'ready', png: encodePng(result.raster), cacheKey, notes, zoneSource: z.source };
}
