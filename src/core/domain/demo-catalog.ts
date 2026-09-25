/**
 * Demo tenant catalog (§3.2, §16). PURE data — imported by the DB seed, the catalog service tests,
 * and the offline demo. All blank costs are PLACEHOLDER cents, never real supplier pricing.
 */
import type { QuantityBreak } from '@/pricing/types';
import type { DecorationMethodKey } from '@/pricing/types';
import type { TemplateKind } from '@/imaging/templates';

/** Standard promo quantity breaks (§16). blankUnitCost is PLACEHOLDER (cents). */
export function breaksFor(base: number): QuantityBreak[] {
  const steps: Array<[number, number]> = [
    [12, 1.0],
    [24, 0.95],
    [48, 0.9],
    [72, 0.86],
    [144, 0.82],
    [288, 0.78],
    [576, 0.74],
  ];
  return steps.map(([minQty, mult]) => ({ minQty, blankUnitCost: Math.round(base * mult) }));
}

export interface DemoProduct {
  slug: string;
  template: TemplateKind;
  name: string;
  category: string;
  brand: string;
  traits: { isApparel?: boolean; isHardGood?: boolean; isPolyester?: boolean; isEco?: boolean };
  blankBase: number; // cents, PLACEHOLDER
  colors: Array<{ name: string; hex: string; isDark?: boolean }>;
  methods: Array<{ method: DecorationMethodKey; location: string; w: number; h: number }>;
}

export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export const DEMO_CATALOG: DemoProduct[] = [
  {
    slug: 'classic-cotton-tee',
    template: 'tee',
    name: 'Classic Cotton Tee',
    category: 'Apparel',
    brand: 'Gildan',
    traits: { isApparel: true },
    blankBase: 350,
    colors: [
      { name: 'Black', hex: '#0A0A0A', isDark: true },
      { name: 'White', hex: '#FFFFFF' },
      { name: 'Navy', hex: '#1B2A4A', isDark: true },
      { name: 'Red', hex: '#C6242A', isDark: true },
    ],
    methods: [
      { method: 'screen_print', location: 'full_front', w: 10, h: 12 },
      { method: 'screen_print', location: 'left_chest', w: 3.5, h: 3 },
      { method: 'dtg', location: 'full_front', w: 10, h: 12 },
      { method: 'dtf', location: 'full_front', w: 10, h: 12 },
    ],
  },
  {
    slug: 'performance-polo',
    template: 'polo',
    name: 'Performance Polo',
    category: 'Apparel',
    brand: 'Sport-Tek',
    traits: { isApparel: true, isPolyester: true },
    blankBase: 1200,
    colors: [
      { name: 'Royal', hex: '#1F45C6', isDark: true },
      { name: 'White', hex: '#FFFFFF' },
      { name: 'Forest', hex: '#2E5D34', isDark: true },
    ],
    methods: [
      { method: 'embroidery', location: 'left_chest', w: 3, h: 2 },
      { method: 'sublimation', location: 'full_front', w: 8, h: 8 },
    ],
  },
  {
    slug: 'structured-cap',
    template: 'cap',
    name: 'Structured Cap',
    category: 'Headwear',
    brand: 'Yupoong',
    traits: { isApparel: true },
    blankBase: 700,
    colors: [
      { name: 'Black', hex: '#0A0A0A', isDark: true },
      { name: 'Charcoal', hex: '#3A3A3A', isDark: true },
      { name: 'Khaki', hex: '#B7A98B' },
    ],
    methods: [
      { method: 'embroidery', location: 'front_panel', w: 4, h: 2.25 },
      { method: 'heat_transfer_htv', location: 'front_panel', w: 3, h: 1.5 },
    ],
  },
  {
    slug: 'stainless-tumbler-20oz',
    template: 'tumbler',
    name: 'Stainless Tumbler 20oz',
    category: 'Drinkware',
    brand: 'Polar Camel',
    traits: { isHardGood: true },
    blankBase: 950,
    colors: [
      { name: 'Stainless', hex: '#C7CBD1' },
      { name: 'Matte Black', hex: '#141414', isDark: true },
      { name: 'Teal', hex: '#0E8C8C' },
    ],
    methods: [
      { method: 'laser_engraving', location: 'wrap', w: 3, h: 3 },
      { method: 'pad_printing', location: 'one_side', w: 2.5, h: 2.5 },
    ],
  },
  {
    slug: 'cotton-canvas-tote',
    template: 'tote',
    name: 'Cotton Canvas Tote',
    category: 'Bags',
    brand: 'Liberty Bags',
    traits: { isApparel: true, isEco: true },
    blankBase: 500,
    colors: [
      { name: 'Natural', hex: '#E9E2CE' },
      { name: 'Black', hex: '#0A0A0A', isDark: true },
    ],
    methods: [
      { method: 'screen_print', location: 'center_front', w: 8, h: 8 },
      { method: 'dtf', location: 'center_front', w: 8, h: 8 },
    ],
  },
  {
    slug: 'softbound-journal',
    template: 'journal',
    name: 'Softbound Journal',
    category: 'Writing',
    brand: 'JournalBook',
    traits: { isHardGood: true, isEco: true },
    blankBase: 800,
    colors: [
      { name: 'Charcoal', hex: '#3A3A3A', isDark: true },
      { name: 'Tan', hex: '#8A6A45' },
    ],
    methods: [
      { method: 'deboss_emboss', location: 'front_cover', w: 3, h: 3 },
      { method: 'laser_engraving', location: 'front_cover', w: 3, h: 3 },
    ],
  },
];
