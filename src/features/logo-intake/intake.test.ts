import { describe, it, expect } from 'vitest';
import { encodePng } from '@/imaging/png';
import { createRaster } from '@/imaging/raster';
import { sampleLogo } from '@/imaging/fixtures';
import { intakeLogo, sniffType, svgSafetyIssues, LogoIntakeError, recommendMethods } from './intake';

const enc = (s: string) => new TextEncoder().encode(s);
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof LogoIntakeError ? e.code : `other:${(e as Error).message}`;
  }
}

describe('type sniffing (never trust the extension)', () => {
  it('identifies by magic bytes', () => {
    expect(sniffType(encodePng(createRaster(2, 2)))).toBe('png');
    expect(sniffType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffType(enc('%PDF-1.7'))).toBe('pdf');
    expect(sniffType(enc('<?xml version="1.0"?><svg></svg>'))).toBe('svg');
    expect(sniffType(enc('MZ\u0090\u0000 not an image'))).toBe('unknown');
  });
});

describe('SVG safety screen', () => {
  it('flags script, handlers, external refs, XXE', () => {
    expect(svgSafetyIssues('<svg><script>alert(1)</script></svg>')).toContain('script element');
    expect(svgSafetyIssues('<svg onload="x()"></svg>')).toContain('event-handler attribute');
    expect(svgSafetyIssues('<svg><image href="https://evil.test/a.png"/></svg>')).toContain('external reference');
    expect(svgSafetyIssues('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>').length).toBeGreaterThan(0);
    expect(svgSafetyIssues('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#123456"/></svg>')).toEqual([]);
  });
});

describe('intakeLogo', () => {
  it('rejects empty, oversize, unknown, unsafe, and undecodable input with typed errors', async () => {
    expect(await code(intakeLogo(new Uint8Array(0)))).toBe('empty');
    expect(await code(intakeLogo(encodePng(sampleLogo()), { maxBytes: 100 }))).toBe('too_large');
    expect(await code(intakeLogo(enc('hello')))).toBe('unsupported_type');
    expect(await code(intakeLogo(enc('<svg><script>x</script></svg>')))).toBe('unsafe_svg');
    expect(await code(intakeLogo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])))).toBe('decoder_unavailable');
    expect(await code(intakeLogo(encodePng(createRaster(16, 16, [0, 0, 0, 255]))))).toBe('too_small');
    expect(await code(intakeLogo(encodePng(createRaster(64, 64, [255, 255, 255, 255]))))).toBe('blank_image');
  });

  it('processes a real logo end to end', async () => {
    const r = await intakeLogo(encodePng(sampleLogo()), { knockoutEnclosed: true });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.palette.colorCount).toBe(3);
    expect(r.background.removed).toBe(true);
    expect(r.needsReview).toBe(false);
    expect(r.raster.width).toBeLessThan(600); // trimmed
    expect(r.recommendedMethods).toContain('screen_print');
  });

  it('flags the enclosed-area ambiguity for review when not resolved', async () => {
    const r = await intakeLogo(encodePng(sampleLogo()));
    expect(r.needsReview).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/enclosed/);
  });

  it('warns on low-resolution raster logos', async () => {
    const r = await intakeLogo(encodePng(sampleLogo(200, 100)), { knockoutEnclosed: true });
    expect(r.warnings.join(' ')).toMatch(/Low-resolution/);
  });

  it('steers photographic art away from spot-colour methods', () => {
    const recs = recommendMethods({ colors: [], colorCount: 12, isPhotographic: true, opaquePixels: 1 });
    expect(recs).toContain('dtg');
    expect(recs).not.toContain('screen_print');
  });
});
