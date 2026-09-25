/**
 * Production ImageCodec backed by sharp/libvips (ADR 0006): JPEG, WebP, SVG, PDF (+ PNG via the
 * local codec, which is faster for the common case). Loaded lazily so environments without sharp
 * still run with PNG-only intake.
 *
 * Safety: SVGs are screened by svgSafetyIssues() BEFORE reaching here; libvips additionally never
 * fetches external resources. Input pixel limits guard against decompression bombs.
 */
import type { Raster } from '@/imaging/raster';
import { decodePng } from '@/imaging/png';
import type { ImageCodec, SniffedType } from './intake';

const MAX_INPUT_PIXELS = 40_000_000;
const VECTOR_TARGET_PX = 1600; // rasterize vectors so the longest side is ~this

type SharpFn = (input: Uint8Array, opts?: Record<string, unknown>) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  rotate(): ReturnType<SharpFn>;
  ensureAlpha(): ReturnType<SharpFn>;
  raw(): ReturnType<SharpFn>;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }>;
};

export async function createSharpCodec(): Promise<ImageCodec | null> {
  let sharp: SharpFn;
  try {
    const mod = (await import('sharp')) as { default: SharpFn };
    sharp = mod.default;
  } catch {
    return null;
  }
  const supported: SniffedType[] = ['png', 'jpeg', 'webp', 'svg', 'pdf'];

  return {
    canDecode: (t) => supported.includes(t),
    async decode(bytes, type): Promise<Raster> {
      if (type === 'png') return decodePng(bytes);
      const base = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const };
      let opts: Record<string, unknown> = base;
      if (type === 'svg' || type === 'pdf') {
        // Rasterize at a density that yields ~VECTOR_TARGET_PX on the long side.
        const meta = await sharp(bytes, { ...base, pages: 1 }).metadata();
        const longest = Math.max(meta.width ?? 0, meta.height ?? 0) || 300;
        const density = Math.max(72, Math.min(1200, Math.round((72 * VECTOR_TARGET_PX) / longest)));
        opts = { ...base, density, pages: 1 };
      }
      const { data, info } = await sharp(bytes, opts).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.channels !== 4) throw new Error(`Unexpected channel count ${info.channels}`);
      return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
    },
  };
}
