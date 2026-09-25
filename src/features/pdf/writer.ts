/**
 * Minimal PDF 1.4 writer (no dependencies; server-only, uses node:zlib).
 *
 * Supports exactly what branded leave-behinds need: standard Helvetica / Helvetica-Bold
 * (WinAnsi, not embedded — every PDF reader ships them), filled/stroked rectangles and lines,
 * and RGBA images (Flate RGB + Flate alpha SMask, so transparent logos stay transparent).
 * Coordinates are TOP-LEFT based in points (72 pt = 1 in); converted to PDF's bottom-left space.
 */
import { deflateSync } from 'node:zlib';
import type { Raster } from '@/imaging/raster';

export type Rgb = readonly [number, number, number];

/* Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from the standard AFMs. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Unicode → WinAnsi byte for the typographic characters we actually use; else Latin-1 or '?'. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
  '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};

function toWinAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (WIN_ANSI[ch] !== undefined) out.push(WIN_ANSI[ch]!);
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) out.push(c);
    else if (c === 0x2009 || c === 0x202f || c === 0x00a0) out.push(32); // thin/narrow spaces
    else out.push(63); // '?'
  }
  return out;
}

export function textWidth(s: string, size: number, bold = false): number {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of toWinAnsi(s)) w += b >= 32 && b <= 126 ? table[b - 32]! : 556;
  return (w * size) / 1000;
}

/** Greedy word wrap to a max width. */
export function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, size, bold) <= maxWidth || !cur) cur = next;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function pdfString(s: string): string {
  let out = '(';
  for (const b of toWinAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/**
 * Document-level strings (Info dictionary) use PDFDocEncoding, NOT the font's WinAnsi encoding —
 * writing them with pdfString() turned "—" into "Š". UTF-16BE with a BOM is valid everywhere.
 */
function pdfTextString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((x) => n(x / 255)).join(' ');

export interface ImageRef {
  name: string;
  width: number;
  height: number;
}

export class PdfPage {
  readonly width: number;
  readonly height: number;
  private readonly ops: string[] = [];
  readonly images = new Set<string>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  rect(x: number, y: number, w: number, h: number, opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }): this {
    const parts = [`${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re`];
    if (opts.fill) this.ops.push(`${rgb(opts.fill)} rg`);
    if (opts.stroke) this.ops.push(`${rgb(opts.stroke)} RG ${n(opts.lineWidth ?? 1)} w`);
    this.ops.push(`${parts[0]} ${opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S'}`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.75): this {
    this.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`);
    return this;
  }

  /** `y` is the text BASELINE measured from the top. */
  text(x: number, y: number, s: string, opts: { size: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' }): this {
    const w = opts.align === 'right' ? textWidth(s, opts.size, opts.bold) : 0;
    this.ops.push(
      `BT ${rgb(opts.color ?? [0, 0, 0])} rg /${opts.bold ? 'F2' : 'F1'} ${n(opts.size)} Tf ${n(x - w)} ${n(this.height - y)} Td ${pdfString(s)} Tj ET`,
    );
    return this;
  }

  /** Draw an image fitted (contain) into the box. */
  image(img: ImageRef, x: number, y: number, w: number, h: number): this {
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    this.images.add(img.name);
    this.ops.push(`q ${n(dw)} 0 0 ${n(dh)} ${n(dx)} ${n(this.height - dy - dh)} cm /${img.name} Do Q`);
    return this;
  }

  content(): string {
    return this.ops.join('\n');
  }
}

interface ImageData {
  ref: ImageRef;
  rgb: Uint8Array;
  alpha: Uint8Array | null;
}

export class PdfDocument {
  private readonly pages: PdfPage[] = [];
  private readonly images: ImageData[] = [];
  private readonly title: string;

  constructor(title: string) {
    this.title = title;
  }

  addPage(width = 612, height = 792): PdfPage {
    const p = new PdfPage(width, height);
    this.pages.push(p);
    return p;
  }

  addImage(r: Raster): ImageRef {
    const px = r.width * r.height;
    const rgbBytes = new Uint8Array(px * 3);
    const alpha = new Uint8Array(px);
    let hasAlpha = false;
    for (let i = 0; i < px; i++) {
      rgbBytes[i * 3] = r.data[i * 4]!;
      rgbBytes[i * 3 + 1] = r.data[i * 4 + 1]!;
      rgbBytes[i * 3 + 2] = r.data[i * 4 + 2]!;
      alpha[i] = r.data[i * 4 + 3]!;
      if (alpha[i] !== 255) hasAlpha = true;
    }
    const ref = { name: `Im${this.images.length + 1}`, width: r.width, height: r.height };
    this.images.push({ ref, rgb: rgbBytes, alpha: hasAlpha ? alpha : null });
    return ref;
  }

  build(): Uint8Array<ArrayBuffer> {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let size = 0;
    const push = (b: Uint8Array | string) => {
      const u = typeof b === 'string' ? enc.encode(b) : b;
      chunks.push(u);
      size += u.length;
    };
    const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

    // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then images, then pages+contents.
    let next = 6;
    const imgObj = new Map<string, { obj: number; smask: number | null }>();
    for (const im of this.images) {
      const obj = next++;
      const smask = im.alpha ? next++ : null;
      imgObj.set(im.ref.name, { obj, smask });
    }
    const pageObjs = this.pages.map(() => ({ page: next++, content: next++ }));
    const total = next;

    const obj = (num: number, body: string | Uint8Array, stream?: Uint8Array) => {
      offsets[num] = size;
      push(`${num} 0 obj\n`);
      push(body);
      if (stream) {
        push('\nstream\n');
        push(stream);
        push('\nendstream');
      }
      push('\nendobj\n');
    };

    push(latin1('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'));
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Count ${this.pages.length} /Kids [${pageObjs.map((p) => `${p.page} 0 R`).join(' ')}] >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, latin1(`<< /Title ${pdfTextString(this.title)} /Producer (BrandCanvas) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`));

    for (const im of this.images) {
      const o = imgObj.get(im.ref.name)!;
      const data = new Uint8Array(deflateSync(im.rgb));
      obj(
        o.obj,
        `<< /Type /XObject /Subtype /Image /Width ${im.ref.width} /Height ${im.ref.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length}${o.smask ? ` /SMask ${o.smask} 0 R` : ''} >>`,
        data,
      );
      if (o.smask && im.alpha) {
        const a = new Uint8Array(deflateSync(im.alpha));
        obj(o.smask, `<< /Type /XObject /Subtype /Image /Width ${im.ref.width} /Height ${im.ref.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${a.length} >>`, a);
      }
    }

    this.pages.forEach((p, i) => {
      const { page, content } = pageObjs[i]!;
      const xobjects = [...p.images].map((name) => `/${name} ${imgObj.get(name)!.obj} 0 R`).join(' ');
      obj(
        page,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.width)} ${n(p.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${content} 0 R >>`,
      );
      const stream = new Uint8Array(deflateSync(latin1(p.content())));
      obj(content, `<< /Filter /FlateDecode /Length ${stream.length} >>`, stream);
    });

    const xref = size;
    push(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
