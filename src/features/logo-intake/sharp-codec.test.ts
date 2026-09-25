/**
 * Real-sharp tests. Skipped automatically where sharp isn't installed (the codec returns null),
 * so the offline runner still works on a bare checkout.
 */
import { describe, it, expect } from 'vitest';
import { encodePng } from '@/imaging/png';
import { sampleLogo, SAMPLE_LOGO_INKS } from '@/imaging/fixtures';
import { parseHex } from '@/imaging/palette';
import { intakeLogo } from './intake';
import { createSharpCodec } from './sharp-codec';

const codec = await createSharpCodec();
const d = codec ? describe : describe.skip;

async function toFormat(fmt: 'jpeg' | 'webp', quality: number): Promise<Uint8Array> {
  const { default: sharp } = (await import('sharp')) as { default: (b: Uint8Array) => { jpeg(o: object): { toBuffer(): Promise<Buffer> }; webp(o: object): { toBuffer(): Promise<Buffer> } } };
  const img = sharp(encodePng(sampleLogo()));
  const buf = fmt === 'jpeg' ? await img.jpeg({ quality }).toBuffer() : await img.webp({ quality }).toBuffer();
  return new Uint8Array(buf);
}

const SVG_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect width="200" height="100" fill="#ffffff"/>
  <circle cx="50" cy="50" r="40" fill="#D7263D"/>
  <rect x="100" y="30" width="90" height="16" rx="4" fill="#1B2A4A"/>
  <rect x="100" y="56" width="60" height="16" rx="4" fill="#F2A900"/>
</svg>`;

function inksRecovered(colors: Array<{ rgb: [number, number, number] }>, tol: number): number {
  return Object.values(SAMPLE_LOGO_INKS).filter((hex) => {
    const t = parseHex(hex);
    return colors.some((c) => c.rgb.every((v, i) => Math.abs(v - t[i]!) <= tol));
  }).length;
}

d('sharp codec (JPEG / WebP / SVG / PDF)', () => {
  it('JPEG: compression noise does not inflate the colour count', async () => {
    const r = await intakeLogo(await toFormat('jpeg', 80), { codec: codec!, knockoutEnclosed: true });
    expect(r.sourceType).toBe('jpeg');
    expect(r.background.removed).toBe(true);
    expect(r.palette.colorCount).toBe(3);
    expect(inksRecovered(r.palette.colors, 8)).toBe(3);
  });

  it('WebP decodes and analyses like PNG', async () => {
    const r = await intakeLogo(await toFormat('webp', 85), { codec: codec!, knockoutEnclosed: true });
    expect(r.sourceType).toBe('webp');
    expect(r.palette.colorCount).toBe(3);
  });

  it('SVG is rasterized at print-friendly resolution and flagged as vector', async () => {
    const r = await intakeLogo(new TextEncoder().encode(SVG_LOGO), { codec: codec! });
    expect(r.isVector).toBe(true);
    expect(Math.max(r.sourceSize.width, r.sourceSize.height)).toBeGreaterThanOrEqual(1500);
    expect(r.palette.colorCount).toBe(3);
    expect(r.warnings.join(' ')).not.toMatch(/Low-resolution/);
  });

  it('still rejects unsafe SVG before decoding', async () => {
    await expect(intakeLogo(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'), { codec: codec! })).rejects.toThrow();
  });
});
