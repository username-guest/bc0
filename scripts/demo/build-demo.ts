/**
 * Offline core-loop demo (Phases 3→5). Runs the REAL modules — intake, background removal,
 * palette, Brand-Exact renderer, catalog search, pricing engine — and writes one self-contained
 * page to demo/index.html. It is an output of the codebase, not a hand-made mock-up.
 *
 *   npm run demo   (no npm install needed; Node >= 22.18)
 *
 * This is NOT the product UI (that's the Next.js app, next phase). It exists so the core loop
 * can be seen and checked end to end before any framework code is written.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '@/imaging/png';
import { sampleLogo } from '@/imaging/fixtures';
import { intakeLogo } from '@/features/logo-intake/intake';
import { renderProof } from '@/features/mockup/proof';
import { searchCatalog } from '@/features/catalog/catalog';
import { DEMO_CATALOG } from '@/core/domain/demo-catalog';
import { DECORATION_METHODS } from '@/core/domain/decoration-methods';
import { COLOR_FAMILIES } from '@/core/domain/color-families';
import { PLACEHOLDER_TENANT_CONFIG } from '@/pricing/placeholder-rates';
import { ESTIMATE_DISCLAIMER } from '@/pricing/engine';
import type { DecorationMethodKey } from '@/pricing/types';
import type { TemplateKind } from '@/imaging/templates';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUANTITIES = [24, 72, 144, 576];
const uri = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const t0 = Date.now();
const uploaded = encodePng(sampleLogo());
const logo = await intakeLogo(uploaded, { knockoutEnclosed: true });
const cleanedPng = encodePng(logo.raster);

// ---- Catalog at each quantity; render each (product, colour, method) proof once. ----
const proofs = new Map<string, { src: string; notes: string[] }>();
function proofFor(slug: string, template: TemplateKind, hex: string, method: DecorationMethodKey, location: string): string {
  const key = `${slug}|${hex}|${method}|${location}`;
  if (!proofs.has(key)) {
    const r = renderProof({ logo, productRef: slug, template, colorHex: hex, method, location });
    proofs.set(key, r.status === 'ready' ? { src: uri(r.png), notes: r.notes } : { src: '', notes: [r.reason] });
  }
  return key;
}

const byQty = QUANTITIES.map((quantity) => {
  const res = searchCatalog(DEMO_CATALOG, { quantity, logo: logo.palette }, PLACEHOLDER_TENANT_CONFIG);
  return {
    quantity,
    facets: res.facets,
    items: res.items.map((i) => ({
      slug: i.slug,
      name: i.name,
      brand: i.brand,
      category: i.category,
      color: i.color,
      method: i.recommended.method,
      location: i.recommended.location,
      imprint: i.recommended.imprint,
      unit: i.recommended.unit,
      total: i.recommended.total,
      lines: i.recommended.quote.lines.map((l) => ({ label: l.label, amount: l.amount })),
      priceBreaks: i.priceBreaks,
      alternatives: i.alternatives.map((a) => ({ method: a.method, unit: a.unit })),
      proof: proofFor(i.slug, i.template, i.color.hex, i.recommended.method, i.recommended.location),
    })),
  };
});

// ---- Method gallery: every shader, with the caveats the renderer emitted. ----
const GALLERY: Array<[TemplateKind, string, string, DecorationMethodKey, string]> = [
  ['tee', 'White', '#FFFFFF', 'screen_print', 'full_front'],
  ['tee', 'Black', '#0A0A0A', 'screen_print', 'full_front'],
  ['tee', 'Red', '#C6242A', 'dtg', 'full_front'],
  ['tee', 'Black', '#0A0A0A', 'dtf', 'full_front'],
  ['polo', 'Royal', '#1F45C6', 'embroidery', 'left_chest'],
  ['polo', 'White', '#FFFFFF', 'sublimation', 'full_front'],
  ['cap', 'Black', '#0A0A0A', 'embroidery', 'front_panel'],
  ['cap', 'Khaki', '#B7A98B', 'heat_transfer_htv', 'front_panel'],
  ['tumbler', 'Matte Black', '#141414', 'laser_engraving', 'wrap'],
  ['tumbler', 'Stainless', '#C7CBD1', 'laser_engraving', 'wrap'],
  ['tumbler', 'Teal', '#0E8C8C', 'pad_printing', 'one_side'],
  ['journal', 'Charcoal', '#3A3A3A', 'deboss_emboss', 'front_cover'],
];
const gallery = GALLERY.map(([t, colorName, hex, m, loc]) => ({
  template: t,
  colorName,
  method: m,
  proof: proofFor(`gallery-${t}`, t, hex, m, loc),
}));

const methodLabels = Object.fromEntries(Object.values(DECORATION_METHODS).map((m) => [m.key, m.label]));
const familyInfo = Object.fromEntries(COLOR_FAMILIES.map((f) => [f.key, { label: f.label, hex: f.anchor }]));
const data = {
  byQty,
  gallery,
  proofs: Object.fromEntries(proofs),
  methodLabels,
  familyInfo,
};

const buildMs = Date.now() - t0;
const logoChips = logo.palette.colors
  .map((c) => `<span class="chip"><i style="background:${c.hex}"></i>${c.hex} · ${Math.round(c.coverage * 100)}%</span>`)
  .join('');
const recs = logo.recommendedMethods.map((m) => esc(methodLabels[m] ?? m)).join(', ');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>BrandCanvas — core loop demo</title>
<style>
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);
  --bg:#F6F7F9;--card:#FFFFFF;--ink:#111827;--muted:#5B6472;--line:#E3E6EB;--accent:#1F45C6;--accent-ink:#FFFFFF;
  --warn-bg:#FFF6E0;--warn-ink:#7A5200;--stage:#E6E9EE;--chip:#F0F2F5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0F1216;--card:#171B21;--ink:#E8EBEF;--muted:#9AA3AF;--line:#2A3039;--accent:#7C9BFF;--accent-ink:#0B1020;--warn-bg:#3A2E10;--warn-ink:#F5D48A;--stage:#232830;--chip:#222831}}
:root[data-theme="dark"]{--bg:#0F1216;--card:#171B21;--ink:#E8EBEF;--muted:#9AA3AF;--line:#2A3039;--accent:#7C9BFF;--accent-ink:#0B1020;--warn-bg:#3A2E10;--warn-ink:#F5D48A;--stage:#232830;--chip:#222831}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
*,*::before,*::after{box-sizing:inherit}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.sub{color:var(--muted);margin:0}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:var(--warn-bg);color:var(--warn-ink);margin-top:8px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.logo-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.logo-box{border-radius:10px;height:150px;display:flex;align-items:center;justify-content:center;padding:14px}
.logo-box img{max-width:100%;max-height:100%}
.orig{background:#FFFFFF;border:1px solid var(--line)}
.checker{background-color:#fff;background-image:linear-gradient(45deg,#d9dde3 25%,transparent 25%),linear-gradient(-45deg,#d9dde3 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d9dde3 75%),linear-gradient(-45deg,transparent 75%,#d9dde3 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}
.cap{font-size:12px;color:var(--muted);margin:6px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border-radius:999px;padding:4px 10px;font-size:13px}
.chip i{width:12px;height:12px;border-radius:50%;display:inline-block;border:1px solid rgba(0,0,0,.15)}
.facts{margin:10px 0 0;padding:0;list-style:none;font-size:14px}.facts li{margin:3px 0}
.qty{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px}
.qty button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px;border-radius:999px;font:inherit;cursor:pointer;min-height:40px}
.qty button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.layout{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
@media (max-width:760px){.layout{grid-template-columns:1fr}}
.facets h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 6px}
.facets h3:first-child{margin-top:0}
.facet{display:flex;justify-content:space-between;align-items:center;font-size:14px;padding:3px 0;gap:8px}
.facet span:first-child{display:flex;align-items:center;gap:6px}
.facet i{width:11px;height:11px;border-radius:50%;border:1px solid rgba(0,0,0,.15)}
.count{color:var(--muted);font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.stage{background:var(--stage);aspect-ratio:1/1}
.stage img{width:100%;height:100%;display:block}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
.name{font-weight:650}
.meta{font-size:13px;color:var(--muted)}
.price{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.price small{font-size:13px;font-weight:500;color:var(--muted)}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;background:var(--chip)}
.breaks{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.breaks td{padding:3px 4px;border-top:1px solid var(--line)}
.breaks td:last-child{text-align:right}
.breaks tr.on td{font-weight:700;color:var(--accent)}
.note{font-size:12.5px;background:var(--warn-bg);color:var(--warn-ink);padding:6px 8px;border-radius:8px}
details{font-size:13px}summary{cursor:pointer;color:var(--muted)}
.lines{margin:6px 0 0;padding:0;list-style:none}.lines li{display:flex;justify-content:space-between;gap:10px;padding:2px 0;font-variant-numeric:tabular-nums}
.g-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.foot{margin-top:28px;font-size:12.5px;color:var(--muted)}
</style>
</head>
<body>
<main>
  <h1>BrandCanvas · core loop demo</h1>
  <p class="sub">Logo in → cleaned → Brand-Exact proofs on real product templates → priced catalog. Generated by the codebase in ${buildMs} ms, no AI model involved.</p>
  <span class="badge">Estimated pricing · placeholder rate tables</span>

  <h2>1 · Logo intake</h2>
  <div class="panel">
    <div class="logo-row">
      <div><div class="logo-box orig"><img alt="Uploaded logo" src="${uri(uploaded)}"></div><p class="cap">Uploaded (PNG on white)</p></div>
      <div><div class="logo-box checker"><img alt="Cleaned logo, transparent background" src="${uri(cleanedPng)}"></div><p class="cap">Cleaned: background removed, trimmed</p></div>
    </div>
    <div class="chips">${logoChips}</div>
    <ul class="facts">
      <li><b>${logo.palette.colorCount} spot colours</b> detected (anti-aliased edge pixels folded into their inks, not counted)</li>
      <li>${esc(logo.background.reason)}</li>
      <li>${logo.background.enclosedRegions} enclosed white area found — knocked out after confirmation (default is to ask)</li>
      <li>Suited to: ${recs}</li>
    </ul>
  </div>

  <h2>2 · Your catalog</h2>
  <div class="qty" role="group" aria-label="Quantity">${QUANTITIES.map((q) => `<button type="button" data-q="${q}" aria-pressed="${q === 144}">${q} pcs</button>`).join('')}</div>
  <div class="layout">
    <aside class="panel facets" id="facets"></aside>
    <section class="grid" id="grid"></section>
  </div>

  <h2>3 · Every decoration method, rendered honestly</h2>
  <p class="sub" style="margin-bottom:12px">Each method encodes its physical limits: spot inks, raised thread, no white in sublimation, single-tone laser, blind deboss.</p>
  <section class="g-grid" id="gallery"></section>

  <p class="foot">${esc(ESTIMATE_DISCLAIMER)} Product imagery is procedural placeholder art until real blank photography is connected.</p>
</main>
<script>
const D = ${JSON.stringify(data)};
const $ = (s) => document.querySelector(s);
const money = (c) => '$' + (c / 100).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
function notesHtml(key) {
  return (D.proofs[key]?.notes || []).map((n) => '<div class="note">' + esc(n) + '</div>').join('');
}
function render(q) {
  const view = D.byQty.find((v) => v.quantity === q);
  const f = view.facets;
  const row = (label, count, dot) => '<div class="facet"><span>' + (dot ? '<i style="background:' + dot + '"></i>' : '') + esc(label) + '</span><span class="count">' + count + '</span></div>';
  $('#facets').innerHTML =
    '<h3>Colour</h3>' + f.colorFamilies.map((c) => row(D.familyInfo[c.key].label, c.count, D.familyInfo[c.key].hex)).join('') +
    '<h3>Category</h3>' + f.categories.map((c) => row(c.key, c.count)).join('') +
    '<h3>Method</h3>' + f.methods.map((c) => row(D.methodLabels[c.key], c.count)).join('') +
    '<h3>Other</h3>' + row('Eco-friendly', f.eco) +
    (f.priceRange ? row('Price / unit', money(f.priceRange.min) + '–' + money(f.priceRange.max)) : '');
  $('#grid').innerHTML = view.items.map((i) => {
    const on = i.priceBreaks.reduce((acc, b) => (b.minQty <= q ? b.minQty : acc), i.priceBreaks[0].minQty);
    const breaks = i.priceBreaks.filter((b) => [24, 72, 144, 576].includes(b.minQty) || b.minQty === on)
      .map((b) => '<tr class="' + (b.minQty === on ? 'on' : '') + '"><td>' + b.minQty + '+</td><td>' + money(b.unit) + ' ea</td></tr>').join('');
    const alts = i.alternatives.length ? '<div class="meta">Also: ' + i.alternatives.map((a) => esc(D.methodLabels[a.method]) + ' ' + money(a.unit)).join(' · ') + '</div>' : '';
    const lines = i.lines.map((l) => '<li><span>' + esc(l.label) + '</span><span>' + money(l.amount) + '</span></li>').join('');
    return '<article class="card"><div class="stage"><img loading="lazy" alt="' + esc(i.name + ' with logo, ' + D.methodLabels[i.method]) + '" src="' + D.proofs[i.proof].src + '"></div>' +
      '<div class="body"><div class="name">' + esc(i.name) + '</div>' +
      '<div class="meta">' + esc(i.brand) + ' · ' + esc(i.color.name) + ' · ' + i.imprint.widthIn + '×' + i.imprint.heightIn + ' in ' + esc(i.location.replace('_', ' ')) + '</div>' +
      '<div><span class="tag">' + esc(D.methodLabels[i.method]) + '</span></div>' +
      '<div class="price">' + money(i.unit) + ' <small>/ unit est. · ' + money(i.total) + ' for ' + q + '</small></div>' + alts +
      '<table class="breaks">' + breaks + '</table>' + notesHtml(i.proof) +
      '<details><summary>Price breakdown</summary><ul class="lines">' + lines + '</ul></details></div></article>';
  }).join('');
  document.querySelectorAll('.qty button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.q) === q)));
}
document.querySelectorAll('.qty button').forEach((b) => b.addEventListener('click', () => render(Number(b.dataset.q))));
$('#gallery').innerHTML = D.gallery.map((g) =>
  '<article class="card"><div class="stage"><img loading="lazy" alt="' + esc(D.methodLabels[g.method]) + ' on ' + esc(g.template) + '" src="' + D.proofs[g.proof].src + '"></div>' +
  '<div class="body"><div class="name">' + esc(D.methodLabels[g.method]) + '</div><div class="meta">' + esc(g.template) + ' · ' + esc(g.colorName) + '</div>' + notesHtml(g.proof) + '</div></article>').join('');
render(144);
</script>
</body>
</html>
`;

mkdirSync(path.join(root, 'demo'), { recursive: true });
const out = path.join(root, 'demo/index.html');
writeFileSync(out, html);
console.log(`demo written: ${path.relative(root, out)} (${(html.length / 1024 / 1024).toFixed(2)} MB, ${proofs.size} proofs, ${buildMs} ms)`);
for (const v of byQty) {
  console.log(`qty ${String(v.quantity).padStart(3)}: ` + v.items.map((i) => `${i.slug.split('-')[0]}=${i.method}@${money(i.unit)}`).join('  '));
}
function money(c: number) {
  return '$' + (c / 100).toFixed(2);
}
