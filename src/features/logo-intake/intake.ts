/**
 * Logo intake (§3.3 Stage A, Phase 3). Server-only.
 *
 *   bytes → sniff real type (never trust the extension / Content-Type header)
 *         → size + type validation, SVG safety screen
 *         → decode (ImageCodec) → background removal → trim → palette + colour count
 *         → method recommendation + review flags
 *
 * Nothing here trusts the client. The result is persisted by the caller (logo_assets row +
 * StorageProvider); this module is pure given its codec, which keeps it unit-testable.
 */
import { createHash } from 'node:crypto';
import type { DecorationMethodKey } from '@/pricing/types';
import type { Raster } from '@/imaging/raster';
import { trimToContent } from '@/imaging/raster';
import { decodePng, isPng } from '@/imaging/png';
import { removeUniformBackground, type BgConfidence } from '@/imaging/background';
import { extractPalette, type PaletteResult } from '@/imaging/palette';

export type SniffedType = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'unknown';

export function sniffType(bytes: Uint8Array): SniffedType {
  if (isPng(bytes)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return 'unknown';
}

export type IntakeErrorCode =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'unsafe_svg'
  | 'decoder_unavailable'
  | 'decode_failed'
  | 'too_small'
  | 'blank_image';

export class LogoIntakeError extends Error {
  readonly code: IntakeErrorCode;
  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LogoIntakeError';
  }
}

/**
 * Reject SVGs that can execute or fetch. We never serve a user SVG back as-is (it's rasterized),
 * but screening at the edge keeps stored-XSS and SSRF (external refs, XXE) out entirely.
 */
export function svgSafetyIssues(svgText: string): string[] {
  const s = svgText.toLowerCase();
  const issues: string[] = [];
  if (/<script[\s>]/.test(s)) issues.push('script element');
  if (/\son[a-z]+\s*=/.test(s)) issues.push('event-handler attribute');
  if (/javascript:/.test(s)) issues.push('javascript: URL');
  if (/<foreignobject[\s>]/.test(s)) issues.push('foreignObject');
  if (/<!entity|<!doctype[^>]*\[/.test(s)) issues.push('DTD/entity (XXE)');
  if (/(xlink:)?href\s*=\s*["']\s*(https?:|\/\/|file:)/.test(s)) issues.push('external reference');
  return issues;
}

/** Decoder seam. Local PNG codec always available; the sharp adapter adds JPEG/WebP/SVG/PDF. */
export interface ImageCodec {
  canDecode(type: SniffedType): boolean;
  decode(bytes: Uint8Array, type: SniffedType): Promise<Raster>;
}

export const localPngCodec: ImageCodec = {
  canDecode: (t) => t === 'png',
  decode: async (bytes) => decodePng(bytes),
};

export interface IntakeOptions {
  maxBytes?: number; // default 10 MB
  codec?: ImageCodec;
  knockoutEnclosed?: boolean; // treat enclosed background-coloured areas as holes
  /** When the tenant's `auto_bg_removal` flag is off, keep the artwork's own background. */
  skipBackgroundRemoval?: boolean;
}

export interface ProcessedLogo {
  hash: string; // sha256 of the uploaded bytes (render-cache key component)
  sourceType: SniffedType;
  isVector: boolean;
  sourceSize: { width: number; height: number };
  raster: Raster; // background removed + trimmed
  palette: PaletteResult;
  background: {
    removed: boolean;
    confidence: BgConfidence;
    reason: string;
    enclosedRegions: number;
    backgroundHex?: string;
  };
  recommendedMethods: DecorationMethodKey[];
  warnings: string[];
  /** True when a human should confirm before proofs are shown as final (§17 guardrail). */
  needsReview: boolean;
}

const ALLOWED: SniffedType[] = ['png', 'jpeg', 'webp', 'svg', 'pdf'];
const SPOT_METHODS: DecorationMethodKey[] = ['screen_print', 'embroidery', 'pad_printing', 'heat_transfer_htv', 'dtf', 'dtg'];
const FULL_COLOR_METHODS: DecorationMethodKey[] = ['dtg', 'dtf', 'sublimation'];

export function recommendMethods(p: PaletteResult): DecorationMethodKey[] {
  if (p.isPhotographic) return [...FULL_COLOR_METHODS, 'laser_engraving'];
  const recs = [...SPOT_METHODS];
  if (p.colorCount <= 1) recs.push('laser_engraving', 'deboss_emboss');
  else recs.push('laser_engraving'); // single-tone conversion is always possible
  return recs;
}

export async function intakeLogo(bytes: Uint8Array, opts: IntakeOptions = {}): Promise<ProcessedLogo> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const codec = opts.codec ?? localPngCodec;
  const warnings: string[] = [];

  if (!bytes.length) throw new LogoIntakeError('empty', 'The file is empty.');
  if (bytes.length > maxBytes) {
    throw new LogoIntakeError('too_large', `File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const type = sniffType(bytes);
  if (!ALLOWED.includes(type)) {
    throw new LogoIntakeError('unsupported_type', 'Upload a PNG, JPG, WebP, SVG, or PDF logo.');
  }
  if (type === 'svg') {
    const issues = svgSafetyIssues(new TextDecoder().decode(bytes));
    if (issues.length) {
      throw new LogoIntakeError('unsafe_svg', `SVG rejected for safety (${issues.join(', ')}).`);
    }
  }
  if (!codec.canDecode(type)) {
    throw new LogoIntakeError('decoder_unavailable', `No decoder configured for ${type.toUpperCase()} in this environment.`);
  }

  let decoded: Raster;
  try {
    decoded = await codec.decode(bytes, type);
  } catch (e) {
    throw new LogoIntakeError('decode_failed', `Could not read the image: ${(e as Error).message}`);
  }
  if (decoded.width < 32 || decoded.height < 32) {
    throw new LogoIntakeError('too_small', 'Logo is too small to reproduce — upload at least 300px wide.');
  }
  const isVector = type === 'svg' || type === 'pdf';
  if (!isVector && Math.max(decoded.width, decoded.height) < 300) {
    warnings.push('Low-resolution logo: fine for a proof, but ask for a vector file before production.');
  }

  const bg = opts.skipBackgroundRemoval
    ? {
        raster: decoded,
        removed: false,
        alreadyTransparent: false,
        confidence: 'high' as const,
        reason: 'Automatic background removal is off for this site',
        enclosedRegions: 0,
      }
    : removeUniformBackground(decoded, { removeEnclosed: opts.knockoutEnclosed ?? false });
  if (bg.confidence === 'low') warnings.push(bg.reason);
  else if (bg.enclosedRegions > 0 && !opts.knockoutEnclosed) warnings.push(bg.reason);

  const trimmed = trimToContent(bg.raster, 2);
  const palette = extractPalette(trimmed);
  if (palette.opaquePixels === 0) throw new LogoIntakeError('blank_image', 'No visible artwork found in the file.');
  if (palette.isPhotographic) {
    warnings.push('Full-colour / photographic artwork: best suited to DTG, DTF, or sublimation.');
  }

  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    sourceType: type,
    isVector,
    sourceSize: { width: decoded.width, height: decoded.height },
    raster: trimmed,
    palette,
    background: {
      removed: bg.removed,
      confidence: bg.confidence,
      reason: bg.reason,
      enclosedRegions: bg.enclosedRegions,
      ...('backgroundHex' in bg && bg.backgroundHex ? { backgroundHex: bg.backgroundHex } : {}),
    },
    recommendedMethods: recommendMethods(palette),
    warnings,
    needsReview: bg.confidence === 'low' || (bg.enclosedRegions > 0 && !opts.knockoutEnclosed),
  };
}
