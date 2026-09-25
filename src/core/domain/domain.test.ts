import { describe, it, expect } from 'vitest';
import { COLOR_FAMILIES, mapColorToFamily, hexToRgb } from './color-families';
import { DECORATION_METHODS, isMethodCompatible } from './decoration-methods';

describe('color families', () => {
  it('maps every family anchor to itself', () => {
    for (const fam of COLOR_FAMILIES) {
      expect(mapColorToFamily(fam.anchor)).toBe(fam.key);
    }
  });

  it('buckets desaturated colors as neutrals, not chromatic', () => {
    expect(mapColorToFamily('#3A3A3A')).toBe('gray'); // charcoal, not navy
    expect(mapColorToFamily('#C7CBD1')).toBe('gray'); // stainless, not light_blue
    expect(mapColorToFamily('#0A0A0A')).toBe('black');
    expect(mapColorToFamily('#FFFFFF')).toBe('white_neutral');
  });

  it('routes muted warm tones to brown/tan', () => {
    expect(mapColorToFamily('#B7A98B')).toBe('brown_tan'); // khaki
    expect(mapColorToFamily('#8A6A45')).toBe('brown_tan'); // tan
  });

  it('splits blue siblings by lightness', () => {
    expect(mapColorToFamily('#1B2A4A')).toBe('navy');
    expect(mapColorToFamily('#1F45C6')).toBe('royal_blue');
    expect(mapColorToFamily('#8EC6E6')).toBe('light_blue');
  });

  it('keeps a vivid pastel chromatic rather than washing it to white', () => {
    expect(mapColorToFamily('#F8C0D8')).toBe('pink');
  });

  it('rejects malformed hex', () => {
    expect(() => hexToRgb('#zzential')).toThrow();
    expect(() => hexToRgb('12345')).toThrow();
  });

  it('every family key is unique', () => {
    const keys = COLOR_FAMILIES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('decoration compatibility (§3.1/§5)', () => {
  const darkCottonTee = { isApparel: true, isHardGood: false, isPolyester: false, isDark: true };
  const stainlessTumbler = { isApparel: false, isHardGood: true, isPolyester: false, isDark: false };
  const polyPolo = { isApparel: true, isHardGood: false, isPolyester: true, isDark: false };

  it('hides sublimation on dark cotton', () => {
    expect(isMethodCompatible('sublimation', darkCottonTee)).toBe(false);
  });

  it('allows sublimation on light polyester', () => {
    expect(isMethodCompatible('sublimation', polyPolo)).toBe(true);
  });

  it('keeps screen print off hard goods', () => {
    expect(isMethodCompatible('screen_print', stainlessTumbler)).toBe(false);
  });

  it('keeps laser engraving off apparel', () => {
    expect(isMethodCompatible('laser_engraving', darkCottonTee)).toBe(false);
    expect(isMethodCompatible('laser_engraving', stainlessTumbler)).toBe(true);
  });

  it('exposes all nine methods', () => {
    expect(Object.keys(DECORATION_METHODS)).toHaveLength(9);
  });
});
