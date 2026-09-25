import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createRaster, resize, alphaBounds, trimToContent, type Raster } from './raster';
import { decodePng, encodePng } from './png';
import { extractPalette, parseHex } from './palette';
import { removeUniformBackground } from './background';
import { renderBrandExact, contrastRatio, relLuminance } from './compose';
import { colorway, getTemplate } from './templates';
import { sampleLogo, SAMPLE_LOGO_INKS } from './fixtures';

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Hand-built 2×2 palette PNG with tRNS and a Sub filter — a format the encoder never emits. */
function palettePng(): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 2);
  new DataView(ihdr.buffer).setUint32(4, 2);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = Uint8Array.from([255, 0, 0, 0, 0, 255]);
  const trns = Uint8Array.from([255, 0]); // index 1 fully transparent
  // row0: filter 1 (Sub): raw [0,1] → encoded [0, 1-0]; row1: filter 0: [1,0]
  const raw = Uint8Array.from([1, 0, 1, 0, 1, 0]);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const px = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe('PNG codec', () => {
  it('round-trips RGBA exactly', () => {
    const r = createRaster(37, 11);
    for (let i = 0; i < r.data.length; i++) r.data[i] = (i * 7919) % 256;
    expect(Array.from(decodePng(encodePng(r)).data)).toEqual(Array.from(r.data));
  });

  it('decodes palette + tRNS + Sub filter', () => {
    const r = decodePng(palettePng());
    expect(px(r, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(r, 1, 0)[3]).toBe(0);
    expect(px(r, 0, 1)[3]).toBe(0);
    expect(px(r, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it('rejects corrupted data via CRC', () => {
    const bytes = encodePng(createRaster(4, 4, [1, 2, 3, 255]));
    const i = bytes.length - 20;
    bytes[i] = bytes[i]! ^ 0xff;
    expect(() => decodePng(bytes)).toThrow();
  });
});

describe('raster', () => {
  it('trims to visible content', () => {
    const r = createRaster(20, 20);
    r.data[(5 * 20 + 7) * 4 + 3] = 255;
    expect(alphaBounds(r)).toEqual({ x: 7, y: 5, w: 1, h: 1 });
    expect(trimToContent(r, 0).width).toBe(1);
  });

  it('resize keeps transparent edges free of dark fringe (premultiplied)', () => {
    const r = createRaster(4, 1);
    r.data.set([255, 255, 255, 255], 0); // white opaque next to transparent black
    const out = resize(r, 2, 1);
    const [cr, cg, cb] = px(out, 0, 0);
    expect(Math.min(cr!, cg!, cb!)).toBeGreaterThan(250);
  });
});

describe('palette extraction', () => {
  const logo = trimToContent(removeUniformBackground(sampleLogo(), { removeEnclosed: true }).raster);
  const p = extractPalette(logo);

  it('counts the real spot inks, not the anti-aliasing', () => {
    expect(p.colorCount).toBe(3);
    expect(p.isPhotographic).toBe(false);
  });

  it('recovers each ink within 2 RGB units', () => {
    for (const hex of Object.values(SAMPLE_LOGO_INKS)) {
      const target = parseHex(hex);
      const hit = p.colors.find((c) => c.rgb.every((v, i) => Math.abs(v - target[i]!) <= 2));
      expect(hit).toBeDefined();
    }
  });

  it('folds a mixing band between two inks, but keeps a small genuine third ink', () => {
    // 45% red, 45% navy, 5% exact red/navy blend (edge smear), 5% green (a real small ink).
    const img = createRaster(100, 100);
    const fill = (from: number, to: number, rgb: [number, number, number]) => {
      for (let p = from; p < to; p++) img.data.set([...rgb, 255], p * 4);
    };
    fill(0, 4500, [216, 38, 62]);
    fill(4500, 9000, [27, 42, 74]);
    fill(9000, 9500, [178, 39, 64]); // 80/20 red–navy mix
    fill(9500, 10000, [46, 139, 46]);
    const r = extractPalette(img);
    expect(r.colorCount).toBe(3);
    expect(r.colors.map((c) => c.hex)).toContain('#2E8B2E');
    expect(r.colors.map((c) => c.hex)).not.toContain('#B22740');
    expect(Math.round(r.colors.reduce((n, c) => n + c.coverage, 0) * 100)).toBe(100); // coverage conserved
  });

  it('treats a gradient as photographic', () => {
    const g = createRaster(200, 60);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 200; x++) g.data.set([x, (x * 3 + y * 2) % 256, 255 - x, 255], (y * 200 + x) * 4);
    expect(extractPalette(g).isPhotographic).toBe(true);
  });
});

describe('background removal', () => {
  it('removes a uniform background and reports enclosed areas instead of guessing', () => {
    const res = removeUniformBackground(sampleLogo());
    expect(res.removed).toBe(true);
    expect(res.backgroundHex).toBe('#FFFFFF');
    expect(res.enclosedRegions).toBe(1);
    expect(res.confidence).toBe('medium');
    expect(px(res.raster, 2, 2)[3]).toBe(0); // corner cleared
    expect(px(res.raster, 150, 115)[3]).toBe(255); // enclosed white kept by default
  });

  it('knocks out enclosed areas only when asked', () => {
    const res = removeUniformBackground(sampleLogo(), { removeEnclosed: true });
    expect(px(res.raster, 150, 115)[3]).toBe(0);
    expect(res.confidence).toBe('high');
  });

  it('refuses to guess on non-uniform backgrounds', () => {
    const noisy = createRaster(80, 80);
    for (let i = 0; i < noisy.data.length; i += 4) noisy.data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255], i);
    const res = removeUniformBackground(noisy);
    expect(res.removed).toBe(false);
    expect(res.confidence).toBe('low');
  });

  it('passes through already-transparent art', () => {
    const t = createRaster(40, 40);
    t.data.set([10, 10, 10, 255], (20 * 40 + 20) * 4);
    expect(removeUniformBackground(t).alreadyTransparent).toBe(true);
  });
});

describe('Brand-Exact compositor', () => {
  const logo = trimToContent(removeUniformBackground(sampleLogo(), { removeEnclosed: true }).raster);
  const palette = extractPalette(logo).colors;
  const render = (kind: 'tee' | 'polo' | 'tumbler', hex: string, method: Parameters<typeof renderBrandExact>[0]['method'], loc: string) => {
    const template = getTemplate(kind);
    return renderBrandExact({ product: colorway(template, hex), template, zone: template.zones[loc]!, logo, palette, method, substrateHex: hex });
  };

  it('screen print only ever lays down brand inks (modulated by fabric shading)', () => {
    const r = render('tee', '#FFFFFF', 'screen_print', 'full_front');
    const { x, y, w, h } = r.placed;
    // Every fully-inked pixel's hue must match one of the three inks (shading scales, never shifts hue).
    const inks = palette.map((c) => c.rgb);
    let checked = 0;
    for (let j = y + 2; j < y + h - 2; j += 3) {
      for (let i = x + 2; i < x + w - 2; i += 3) {
        const [pr, pg, pb] = px(r.raster, i, j);
        if (pr! > 245 && pg! > 245 && pb! > 245) continue; // garment
        const close = inks.some(([ir, ig, ib]) => {
          const k = (pr! + pg! + pb!) / (ir + ig + ib || 1);
          return Math.abs(pr! - ir * k) < 14 && Math.abs(pg! - ig * k) < 14 && Math.abs(pb! - ib * k) < 14;
        });
        if (close) checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('sublimation cannot print white', () => {
    const white = createRaster(60, 60, [255, 255, 255, 255]);
    const template = getTemplate('polo');
    const r = renderBrandExact({ product: colorway(template, '#8EC6E6'), template, zone: template.zones['full_front']!, logo: white, palette: [], method: 'sublimation', substrateHex: '#8EC6E6' });
    const cx = Math.round(r.placed.x + r.placed.w / 2);
    const cy = Math.round(r.placed.y + r.placed.h / 2);
    const [pr, pg, pb] = px(r.raster, cx, cy);
    expect(pr! < 200 && pg! < 230 && pb! > pr!).toBe(true); // still light blue, not white
    expect(r.notes.join(' ')).toMatch(/can't print white/);
  });

  it('laser engraving shows only achromatic etched metal — no logo colours leak through', () => {
    const template = getTemplate('tumbler');
    const base = colorway(template, '#141414');
    const r = render('tumbler', '#141414', 'laser_engraving', 'wrap');
    let changed = 0;
    let maxSpread = 0;
    for (let i = 0; i < base.data.length; i += 4) {
      const diff = Math.abs(r.raster.data[i]! - base.data[i]!) + Math.abs(r.raster.data[i + 1]! - base.data[i + 1]!) + Math.abs(r.raster.data[i + 2]! - base.data[i + 2]!);
      if (diff < 60) continue; // untouched (or grain-only) substrate
      changed++;
      const c = [r.raster.data[i]!, r.raster.data[i + 1]!, r.raster.data[i + 2]!];
      maxSpread = Math.max(maxSpread, Math.max(...c) - Math.min(...c));
    }
    expect(changed).toBeGreaterThan(500);
    expect(maxSpread).toBeLessThan(30); // red #D7263D would be ~177, gold ~242
    expect(r.notes.join(' ')).toMatch(/single-tone/);
  });

  it('flags low-contrast inks on the product colour', () => {
    const r = render('tee', '#0A0A0A', 'screen_print', 'full_front');
    expect(r.notes.some((n) => n.includes(SAMPLE_LOGO_INKS.navy))).toBe(true);
    expect(render('tee', '#FFFFFF', 'screen_print', 'full_front').notes).toHaveLength(0);
  });

  it('contrast ratio matches WCAG reference values', () => {
    expect(contrastRatio(relLuminance(0, 0, 0), relLuminance(255, 255, 255))).toBeCloseTo(21, 1);
  });

  it('top-anchors full-front prints', () => {
    const t = getTemplate('tee');
    const r = render('tee', '#FFFFFF', 'screen_print', 'full_front');
    expect(r.placed.y).toBe(Math.round(t.zones['full_front']!.y * t.height));
  });
});
