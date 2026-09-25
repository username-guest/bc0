import { describe, it, expect } from 'vitest';
import { encodePng, decodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { intakeLogo } from '@/features/logo-intake/intake';
import { proofCacheKey, renderProof, resolveZone, ZONE_CONFIDENCE_THRESHOLD } from './proof';
import type { VisionResult } from '@/shared/providers';

const vision = (confidence: number): VisionResult => {
  const z = { label: 'mystery_panel', bbox: { x: 0.3, y: 0.3, w: 0.3, h: 0.2 }, confidence };
  return { productType: 'unknown', material: 'unknown', zones: [z], bestZone: z };
};

describe('zone resolution guardrail (§17)', () => {
  it('uses authored template zones at full confidence', () => {
    const z = resolveZone('tee', 'left_chest');
    expect(z.status).toBe('ready');
  });
  it('accepts a confident vision zone', () => {
    expect(resolveZone('tee', 'mystery_panel', vision(ZONE_CONFIDENCE_THRESHOLD + 0.01)).status).toBe('ready');
  });
  it('refuses to render on a low-confidence vision zone', () => {
    const z = resolveZone('tee', 'mystery_panel', vision(0.4));
    expect(z.status).toBe('needs_placement');
  });
  it('refuses unknown locations with no vision data', () => {
    expect(resolveZone('cap', 'back').status).toBe('needs_placement');
  });
});

describe('renderProof', () => {
  it('renders a decodable PNG with a stable cache key', async () => {
    const logo = await intakeLogo(encodePng(sampleLogo()), { knockoutEnclosed: true });
    const spec = { logo, productRef: 'tee-1', template: 'tee' as const, colorHex: '#ffffff', method: 'screen_print' as const, location: 'left_chest' };
    const a = renderProof(spec);
    const b = renderProof(spec);
    expect(a.status).toBe('ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    expect(a.cacheKey).toBe(b.cacheKey);
    expect(Array.from(a.png)).toEqual(Array.from(b.png)); // deterministic
    expect(decodePng(a.png).width).toBe(420);
  });

  it('never produces an image when placement is untrusted', async () => {
    const logo = await intakeLogo(encodePng(sampleLogo()), { knockoutEnclosed: true });
    const r = renderProof({ logo, productRef: 'x', template: 'cap', colorHex: '#000000', method: 'embroidery', location: 'back' });
    expect(r.status).toBe('needs_placement');
    expect('png' in r).toBe(false);
  });

  it('cache key changes with every input that changes the pixels', () => {
    const base = { logoHash: 'h', productRef: 'p', colorHex: '#000000', method: 'dtg' as const, location: 'full_front' };
    const k = proofCacheKey(base);
    expect(proofCacheKey({ ...base, colorHex: '#000000'.toLowerCase() })).toBe(k); // case-insensitive
    expect(proofCacheKey({ ...base, method: 'dtf' })).not.toBe(k);
    expect(proofCacheKey({ ...base, location: 'left_chest' })).not.toBe(k);
    expect(proofCacheKey({ ...base, logoHash: 'h2' })).not.toBe(k);
  });
});
