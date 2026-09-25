/**
 * PDF leave-behind (Phase 7, Pro lead path): a branded product sheet the prospect keeps and
 * forwards internally — their logo on the tenant's products with ESTIMATED pricing. Every page
 * carries the estimate disclaimer (§17: never present placeholder pricing as a quote).
 */
import type { Raster } from '@/imaging/raster';
import { parseHex } from '@/imaging/palette';
import { contrastRatio, relLuminance } from '@/imaging/compose';
import { endSentence } from '@/features/leads/rules';
import { PdfDocument, type PdfPage, type Rgb, textWidth, wrap } from './writer';

export interface LeaveBehindItem {
  name: string;
  brand: string;
  colorName: string;
  methodLabel: string;
  placement: string; // e.g. "3 × 2 in on the left chest"
  proof: Raster | null;
  unit: number; // cents
  total: number; // cents
  breaks: Array<{ minQty: number; unit: number }>;
}

export interface LeaveBehindInput {
  tenantName: string;
  brandHex: string;
  contactName?: string;
  preparedFor: string;
  date: Date;
  quantity: number;
  logo: Raster;
  items: LeaveBehindItem[];
  disclaimer: string;
}

const W = 612;
const H = 792;
const M = 40;
const INK: Rgb = [28, 33, 39];
const SOFT: Rgb = [93, 102, 112];
const RULE: Rgb = [213, 218, 214];
const STAGE: Rgb = [236, 239, 236];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (c: number) => usd.format(c / 100);

function inkFor(bg: Rgb): Rgb {
  const l = relLuminance(bg[0], bg[1], bg[2]);
  return contrastRatio(l, 1) >= contrastRatio(l, 0) ? [255, 255, 255] : INK;
}

function footer(p: PdfPage, input: LeaveBehindInput, pageNo: number, pages: number): void {
  const top = H - 58;
  p.line(M, top, W - M, top, RULE);
  let y = top + 13;
  for (const line of wrap(input.disclaimer, 7.5, W - 2 * M - 70)) {
    p.text(M, y, line, { size: 7.5, color: SOFT });
    y += 10;
  }
  p.text(W - M, top + 13, `Page ${pageNo} of ${pages}`, { size: 7.5, color: SOFT, align: 'right' });
}

export function buildLeaveBehind(input: LeaveBehindInput): Uint8Array<ArrayBuffer> {
  const doc = new PdfDocument(`${input.tenantName}: your logo on our products`);
  const brand: Rgb = parseHex(input.brandHex);
  const onBrand = inkFor(brand);
  const logoRef = doc.addImage(input.logo);

  const PER_PAGE = 6;
  const pages = Math.max(1, Math.ceil(input.items.length / PER_PAGE));
  const dateStr = input.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  for (let pi = 0; pi < pages; pi++) {
    const p = doc.addPage(W, H);

    // Header band in the tenant's colour.
    p.rect(0, 0, W, 92, { fill: brand });
    p.text(M, 38, input.tenantName, { size: 20, bold: true, color: onBrand });
    p.text(M, 60, 'Your logo on our products', { size: 11, color: onBrand });
    p.rect(W - M - 150, 18, 150, 58, { fill: [255, 255, 255] });
    p.image(logoRef, W - M - 146, 22, 142, 50);

    p.text(M, 118, `Prepared for ${input.preparedFor} on ${dateStr}.`, { size: 9.5, color: INK });
    p.text(M, 132, `Estimated pricing for ${input.quantity.toLocaleString('en-US')} pieces per product.`, { size: 9.5, color: SOFT });

    const colW = (W - 2 * M - 20) / 2;
    const rowH = 186;
    const gridTop = 150;
    input.items.slice(pi * PER_PAGE, (pi + 1) * PER_PAGE).forEach((it, i) => {
      const x = M + (i % 2) * (colW + 20);
      const y = gridTop + Math.floor(i / 2) * rowH;
      const img = 112;
      p.rect(x, y, img, img, { fill: STAGE });
      if (it.proof) p.image(doc.addImage(it.proof), x, y, img, img);

      const tx = x + img + 12;
      const tw = colW - img - 12;
      let ty = y + 11;
      for (const l of wrap(it.name, 10.5, tw, true).slice(0, 2)) {
        p.text(tx, ty, l, { size: 10.5, bold: true, color: INK });
        ty += 13;
      }
      p.text(tx, ty, `${it.brand}, ${it.colorName}`, { size: 8, color: SOFT });
      ty += 11;
      for (const l of wrap(`${it.methodLabel}, ${it.placement}`, 8, tw).slice(0, 2)) {
        p.text(tx, ty, l, { size: 8, color: SOFT });
        ty += 10;
      }
      ty += 10;
      p.text(tx, ty, money(it.unit), { size: 15, bold: true, color: INK });
      p.text(tx + textWidth(money(it.unit), 15, true) + 4, ty, 'each, est.', { size: 8, color: SOFT });
      ty += 12;
      p.text(tx, ty, `${money(it.total)} for ${input.quantity.toLocaleString('en-US')}`, { size: 8, color: SOFT });
      ty += 8;
      // Price breaks: the three nearest the chosen quantity.
      let idx = 0;
      it.breaks.forEach((b, k) => {
        if (b.minQty <= input.quantity) idx = k;
      });
      const shown = it.breaks.slice(Math.max(0, idx - 1), Math.max(0, idx - 1) + 3);
      for (const b of shown) {
        ty += 11;
        p.line(tx, ty - 8.5, tx + tw, ty - 8.5, RULE, 0.5);
        const on = b.minQty === it.breaks[idx]?.minQty;
        p.text(tx, ty, `${b.minQty}+`, { size: 8, bold: on, color: on ? INK : SOFT });
        p.text(tx + tw, ty, money(b.unit), { size: 8, bold: on, color: on ? INK : SOFT, align: 'right' });
      }
    });

    if (input.contactName && pi === pages - 1) {
      p.text(M, H - 76, `Questions or ready to order? ${endSentence(`Reply to ${input.contactName}`)}`, { size: 9.5, bold: true, color: INK });
    }
    footer(p, input, pi + 1, pages);
  }
  return doc.build();
}
