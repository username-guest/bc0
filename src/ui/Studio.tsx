'use client';
/**
 * The prospect-facing studio: upload a logo → see it on the tenant's products → compare
 * estimated prices by quantity. All data and every gate come from the tenant API; the flag
 * snapshot here only decides what to SHOW.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DECORATION_METHODS } from '@/core/domain/decoration-methods';
import { COLOR_FAMILIES } from '@/core/domain/color-families';
import { useFeature, useTenantConfig } from './flags';
import { ProofImage } from './ProofImage';
import { EmailGate, QuoteForm, SheetDownload } from './LeadForms';

type Money = number; // cents

interface LogoDto {
  id: string;
  colorCount: number;
  colors: Array<{ hex: string; coverage: number }>;
  isPhotographic: boolean;
  knockoutEnclosed: boolean;
  background: { removed: boolean; confidence: string; reason: string; enclosedRegions: number };
  recommendedMethods: string[];
  warnings: string[];
  needsReview: boolean;
  cleanUrl: string;
}

interface CatalogItem {
  slug: string;
  name: string;
  brand: string;
  category: string;
  isEco: boolean;
  color: { name: string; hex: string };
  method: string;
  location: string;
  imprint: { widthIn: number; heightIn: number };
  unit: Money;
  total: Money;
  /** Selling-price breakdown; null when the distributor hides it. */
  lines: Array<{ label: string; amount: Money }> | null;
  alternatives: Array<{ method: string; unit: Money }>;
  priceBreaks: Array<{ minQty: number; unit: Money }>;
  proofUrl: string | null;
  /** Hidden behind the email gate for this session (the server refuses its proof too). */
  locked: boolean;
}

interface GateSummary {
  mode: 'off' | 'soft' | 'hard';
  freeProducts: number;
  hasLead: boolean;
  remaining: number | null;
}

interface CatalogResponse {
  gate: GateSummary;
  quantity: number;
  disclaimer: string;
  facets: {
    colorFamilies: Array<{ key: string; count: number }>;
    categories: Array<{ key: string; count: number }>;
    methods: Array<{ key: string; count: number }>;
  } | null;
  items: CatalogItem[];
}

const QUANTITIES = [24, 48, 72, 144, 288, 576];
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (c: Money) => usd.format(c / 100);
const methodLabel = (k: string) => DECORATION_METHODS[k as keyof typeof DECORATION_METHODS]?.label ?? k;
const familyInfo = Object.fromEntries(COLOR_FAMILIES.map((f) => [f.key, f]));
const spaced = (s: string) => s.replace(/_/g, ' ');

async function errorMessage(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { error?: { message?: string } };
    return b.error?.message ?? `Request failed (${r.status}).`;
  } catch {
    return `Request failed (${r.status}).`;
  }
}

/** Renderer notes name inks by hex; show them as a swatch so a prospect can see which colour. */
function NoteText({ text }: { text: string }) {
  const parts = text.split(/(#[0-9A-F]{6}\b)/i);
  return (
    <>
      {parts.map((part, i) =>
        /^#[0-9A-F]{6}$/i.test(part) ? (
          <span key={i} className="ink-ref">
            <i style={{ background: part }} aria-hidden />
            Your {part.toUpperCase()} ink
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function Studio({ apiBase }: { apiBase: string }) {
  const cfg = useTenantConfig();
  const eco = useFeature('sustainable_filter');
  const facetsOn = useFeature('basic_facets').enabled;
  const uploadOn = useFeature('logo_upload_cleanup').enabled;
  const quoteOn = useFeature('quote_requests').enabled;
  const sheetOn = useFeature('all_lead_paths').enabled;
  const contactName = cfg.leads.contactName;

  const [file, setFile] = useState<File | null>(null);
  const [logo, setLogo] = useState<LogoDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [keptEnclosed, setKeptEnclosed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [qty, setQty] = useState(144);
  const [families, setFamilies] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [methods, setMethods] = useState<string[]>([]);
  const [ecoOnly, setEcoOnly] = useState(false);
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Page-load beacon (ADR 0014): counts the visit, credits a tracked link from ?src=, and says
  // whether we already know this prospect (prefills forms; the gate comes back with every
  // catalog response).
  useEffect(() => {
    const src = new URLSearchParams(window.location.search).get('src');
    fetch(`${apiBase}/visit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(src ? { src } : {}),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { email: string | null } | null) => b?.email && setSessionEmail(b.email))
      .catch(() => undefined);
  }, [apiBase]);

  const captured = (email: string) => {
    setSessionEmail(email);
    setRefreshKey((k) => k + 1); // re-fetch: the server now unlocks gated products
  };

  const keepEnclosed = async () => {
    if (!logo) return;
    const r = await fetch(`${apiBase}/logos/${logo.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepEnclosed: true }),
    });
    if (r.ok) setLogo(((await r.json()) as { logo: LogoDto }).logo);
    setKeptEnclosed(true);
  };

  const upload = useCallback(
    async (f: File, knockout: boolean) => {
      setUploading(true);
      setUploadError(null);
      const form = new FormData();
      form.set('file', f);
      form.set('knockout', String(knockout));
      try {
        const r = await fetch(`${apiBase}/logos`, { method: 'POST', body: form });
        if (!r.ok) throw new Error(await errorMessage(r));
        const b = (await r.json()) as { logo: LogoDto };
        setLogo(b.logo);
        setKeptEnclosed(false);
      } catch (e) {
        setUploadError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [apiBase],
  );

  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    void upload(f, false);
  };

  const query = useMemo(() => {
    const p = new URLSearchParams({ qty: String(qty) });
    if (logo) p.set('logo', logo.id);
    families.forEach((x) => p.append('family', x));
    categories.forEach((x) => p.append('category', x));
    methods.forEach((x) => p.append('method', x));
    if (ecoOnly) p.set('eco', '1');
    return p.toString();
  }, [qty, logo, families, categories, methods, ecoOnly]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setCatalogError(null);
    fetch(`${apiBase}/catalog?${query}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r));
        setData((await r.json()) as CatalogResponse);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setCatalogError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [apiBase, query, refreshKey]);

  const askKnockout = logo && !logo.knockoutEnclosed && logo.background.enclosedRegions > 0 && logo.needsReview && !keptEnclosed;
  const lockedCount = data?.items.filter((i) => i.locked).length ?? 0;
  const showHardGate = !!logo && data?.gate.mode === 'hard' && !data.gate.hasLead && lockedCount > 0;
  const showSoftGate = !!logo && data?.gate.mode === 'soft' && !data.gate.hasLead && !sessionEmail;
  const anyFilter = families.length + categories.length + methods.length > 0 || ecoOnly;

  return (
    <main className="studio">
      {!logo ? (
        <section
          className={`drop${dragging ? ' is-dragging' : ''}`}
          onDragOver={(e: { preventDefault(): void }) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e: { preventDefault(): void; dataTransfer: DataTransfer }) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <h1 className="drop-title">See your logo on {cfg.branding.displayName}&rsquo;s products</h1>
          <p className="drop-text">Upload your logo file. We clean up plain backgrounds, match your brand colours, and show estimated prices by quantity.</p>
          {uploadOn ? (
            <>
              <button type="button" className="btn-brand" onClick={() => inputRef.current?.click()} disabled={uploading}>
                {uploading ? 'Preparing your logo…' : 'Upload your logo'}
              </button>
              <input
                ref={inputRef}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
                onChange={(e: { target: HTMLInputElement }) => choose(e.target.files?.[0])}
              />
              <p className="fine">Or drop the file here. Up to 10 MB.</p>
            </>
          ) : (
            <p className="fine">Logo uploads are turned off for this site.</p>
          )}
          {uploadError && <p className="error" role="alert">{uploadError}</p>}
        </section>
      ) : (
        <section className="logo-strip" aria-label="Your logo">
          <div className="logo-tile checker">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo.cleanUrl} alt="Your logo with the background removed" />
          </div>
          <div className="logo-facts">
            <p className="logo-count">
              {logo.isPhotographic ? 'Full-colour artwork' : `${logo.colorCount} ${logo.colorCount === 1 ? 'colour' : 'colours'}`}
            </p>
            <div className="swatches">
              {logo.colors.map((c) => (
                <span key={c.hex} className="swatch" title={`${c.hex}, ${Math.round(c.coverage * 100)}% of the logo`} style={{ background: c.hex }} />
              ))}
            </div>
            {logo.warnings.filter((w) => !/enclosed/.test(w)).map((w) => (
              <p key={w} className="note">{w}</p>
            ))}
            <button type="button" className="btn-quiet" onClick={() => { setLogo(null); setFile(null); }}>
              Use a different logo
            </button>
          </div>
          {askKnockout && file && (
            <div className="ask" role="group" aria-label="Enclosed areas">
              <p>
                Your logo has {logo.background.enclosedRegions === 1 ? 'an area' : `${logo.background.enclosedRegions} areas`} matching the
                background inside it, like the middle of an O. Should {logo.background.enclosedRegions === 1 ? 'it' : 'they'} show the product colour?
              </p>
              <div className="ask-actions">
                <button type="button" className="btn-brand" disabled={uploading} onClick={() => void upload(file, true)}>
                  Show product colour
                </button>
                <button type="button" className="btn-quiet" onClick={() => void keepEnclosed()}>
                  Keep as printed ink
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="controls" aria-label="Quantity and filters">
        <div className="qty" role="group" aria-label="Quantity">
          <span className="control-label">Quantity</span>
          {QUANTITIES.map((q) => (
            <button key={q} type="button" aria-pressed={q === qty} onClick={() => setQty(q)}>
              {q}
            </button>
          ))}
        </div>
        {facetsOn && data?.facets && (
          <div className="filters">
            <div className="chips" role="group" aria-label="Colour">
              {data.facets.colorFamilies.map((f) => (
                <button key={f.key} type="button" className="chip" aria-pressed={families.includes(f.key)} onClick={() => setFamilies(toggle(families, f.key))}>
                  <i style={{ background: familyInfo[f.key]?.anchor }} aria-hidden />
                  {familyInfo[f.key]?.label ?? f.key} <span className="count">{f.count}</span>
                </button>
              ))}
            </div>
            <div className="chips" role="group" aria-label="Category">
              {data.facets.categories.map((f) => (
                <button key={f.key} type="button" className="chip" aria-pressed={categories.includes(f.key)} onClick={() => setCategories(toggle(categories, f.key))}>
                  {f.key} <span className="count">{f.count}</span>
                </button>
              ))}
            </div>
            <div className="chips" role="group" aria-label="Decoration">
              {data.facets.methods.map((f) => (
                <button key={f.key} type="button" className="chip" aria-pressed={methods.includes(f.key)} onClick={() => setMethods(toggle(methods, f.key))}>
                  {methodLabel(f.key)} <span className="count">{f.count}</span>
                </button>
              ))}
              {eco.enabled && (
                <button type="button" className="chip" aria-pressed={ecoOnly} onClick={() => setEcoOnly(!ecoOnly)}>
                  Eco-friendly only
                </button>
              )}
            </div>
            {anyFilter && (
              <button type="button" className="btn-quiet" onClick={() => { setFamilies([]); setCategories([]); setMethods([]); setEcoOnly(false); }}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {sheetOn && logo && (
          <SheetDownload
            apiBase={apiBase}
            logoId={logo.id}
            qty={qty}
            filters={{ families, categories, methods }}
            knownEmail={sessionEmail}
            onCaptured={captured}
          />
        )}
      </section>

      {(showHardGate || showSoftGate) && (
        <EmailGate
          apiBase={apiBase}
          logoId={logo?.id ?? null}
          contactName={contactName}
          mode={showHardGate ? 'hard' : 'soft'}
          lockedCount={lockedCount}
          onCaptured={captured}
        />
      )}
      {catalogError && <p className="error" role="alert">{catalogError}</p>}
      <section className="grid" aria-busy={loading} aria-live="polite">
        {data?.items.length === 0 && <p className="empty">Nothing matches those filters. Clear a filter to see more products.</p>}
        {data?.items.map((i) => (
          <ItemCard
            key={i.slug}
            item={i}
            qty={qty}
            quote={quoteOn ? { apiBase, logoId: logo?.id ?? null, email: sessionEmail ?? '', onSent: captured } : null}
          />
        ))}
      </section>
      {data && <p className="disclaimer">{data.disclaimer}</p>}
    </main>
  );
}

interface QuoteContext {
  apiBase: string;
  logoId: string | null;
  email: string;
  onSent: (email: string) => void;
}

function ItemCard({ item: i, qty, quote }: { item: CatalogItem; qty: number; quote: QuoteContext | null }) {
  const [notes, setNotes] = useState<string[]>([]);
  const [quoting, setQuoting] = useState(false);
  const current = [...i.priceBreaks].reverse().find((b) => b.minQty <= qty)?.minQty;
  return (
    <article className="item">
      <div className="proof">
        <i className="mark tl" aria-hidden />
        <i className="mark tr" aria-hidden />
        <i className="mark bl" aria-hidden />
        <i className="mark br" aria-hidden />
        {i.proofUrl ? (
          <ProofImage url={i.proofUrl} alt={`${i.name} in ${i.color.name} with your logo, ${methodLabel(i.method)}`} onNotes={setNotes} />
        ) : i.locked ? (
          <p className="proof-empty">
            <a href="#gate">Enter your email</a> to see your logo on this product.
          </p>
        ) : (
          <p className="proof-empty">Upload a logo to see it on this product.</p>
        )}
      </div>
      <div className="item-body">
        <h2 className="item-name">{i.name}</h2>
        <p className="item-meta">
          {i.brand}, {i.color.name}
        </p>
        <p className="item-method">
          {methodLabel(i.method)}, {i.imprint.widthIn}&thinsp;×&thinsp;{i.imprint.heightIn} in on the {spaced(i.location)}
        </p>
        <p className="price">
          {money(i.unit)} <span>each, estimated</span>
        </p>
        <p className="item-total">
          {money(i.total)} for {qty}
        </p>
        {notes.map((n) => (
          <p key={n} className="note"><NoteText text={n} /></p>
        ))}
        {i.alternatives.length > 0 && (
          <p className="item-alt">Also available: {i.alternatives.map((a) => `${methodLabel(a.method)} at ${money(a.unit)}`).join(', ')}</p>
        )}
        {i.priceBreaks.length > 0 && (
          <table className="breaks">
            <caption className="sr-only">Estimated price per item by quantity</caption>
            <tbody>
              {i.priceBreaks.map((b) => (
                <tr key={b.minQty} className={b.minQty === current ? 'on' : undefined}>
                  <th scope="row">{b.minQty}+</th>
                  <td>{money(b.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {quote &&
          (quoting ? (
            <QuoteForm
              apiBase={quote.apiBase}
              item={{ slug: i.slug, name: i.name, color: i.color, method: i.method, methodLabel: methodLabel(i.method), location: i.location }}
              qty={qty}
              logoId={quote.logoId}
              defaultEmail={quote.email}
              onSent={quote.onSent}
              onCancel={() => setQuoting(false)}
            />
          ) : (
            <button type="button" className="btn-outline quote-open" onClick={() => setQuoting(true)}>
              Request a quote
            </button>
          ))}
        {i.lines && (
          <details>
            <summary>How this price adds up</summary>
            <ul className="lines">
              {i.lines.map((l) => (
                <li key={l.label}>
                  <span>{l.label}</span>
                  <span>{money(l.amount)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}
