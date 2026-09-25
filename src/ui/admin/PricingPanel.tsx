'use client';
/**
 * Pricing admin (ADR 0009): markups, fees, display, and per-method decoration rates, with a live
 * preview that prices every product at a sample order using the UNSAVED values. Money is typed in
 * dollars and sent as integer cents; the server validates everything again.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiError, type AdminClient } from './client';

// A generic editor over dotted config paths; the server validates every value (ADR 0009).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = Record<string, any>; // mirrors TenantPricingConfig; the server is the schema
interface PricingDto {
  config: Cfg;
  usingOwnRates: boolean;
  defaults: Cfg;
  categories: string[];
  methods: { key: string; label: string }[];
  isOwner: boolean;
}
interface Preview {
  rows: { slug: string; name: string; category: string; method: string; unit: number; total: number; currentUnit: number | null; lines: { label: string; amount: number; note?: string }[] | null }[];
  warnings: string[];
  disclaimer: string;
}

const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const setIn = (o: Cfg, path: string, v: unknown): Cfg => {
  const next = structuredClone(o);
  const keys = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks an arbitrary dotted path
  let cur: any = next;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys[keys.length - 1]!] = v;
  return next;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks an arbitrary dotted path
const getIn = (o: Cfg, path: string): any => path.split('.').reduce((a: any, k) => a?.[k], o);

/** Dollars field over an integer-cents value; keeps what the user types until it parses. */
function Money({ id, label, path, cfg, set, errors, hint, disabled }: { id: string; label: string; path: string; cfg: Cfg; set: (p: string, v: unknown) => void; errors: Record<string, string>; hint?: string; disabled?: boolean }) {
  const cents = getIn(cfg, path) as number;
  const [text, setText] = useState(Number.isFinite(cents) ? (cents / 100).toFixed(2) : '');
  const last = useRef(cents);
  useEffect(() => {
    if (cents !== last.current && Number.isFinite(cents)) setText((cents / 100).toFixed(2)); // external reset
    last.current = cents;
  }, [cents]);
  return (
    <div className="px-field">
      <label htmlFor={id}>{label}</label>
      <span className="px-money">
        <span aria-hidden="true">$</span>
        <input
          id={id}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          aria-invalid={!!errors[path]}
          onChange={(e: { target: HTMLInputElement }) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(/[$,\s]/g, ''));
            const c = e.target.value.trim() === '' || !Number.isFinite(n) ? Number.NaN : Math.round(n * 100);
            last.current = c;
            set(path, Number.isNaN(c) ? null : c);
          }}
        />
      </span>
      {hint && !errors[path] && <span className="fine-inline">{hint}</span>}
      {errors[path] && <span className="field-error">{errors[path]}</span>}
    </div>
  );
}

/** Markup as a percentage over a ratio value (1.4 ⇄ 40%), with the margin it implies. */
function Markup({ id, label, path, cfg, set, errors, optional, disabled }: { id: string; label: string; path: string; cfg: Cfg; set: (p: string, v: unknown) => void; errors: Record<string, string>; optional?: boolean; disabled?: boolean }) {
  const ratio = getIn(cfg, path) as number | undefined;
  const [text, setText] = useState(ratio === undefined ? '' : String(Math.round((ratio - 1) * 10_000) / 100));
  const pct = Number(text);
  const margin = text !== '' && Number.isFinite(pct) && pct >= 0 ? (pct / (100 + pct)) * 100 : null;
  return (
    <div className="px-field">
      <label htmlFor={id}>
        {label} {optional && <span className="optional">optional</span>}
      </label>
      <span className="px-pct">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          placeholder={optional ? 'Same as default' : undefined}
          aria-invalid={!!errors[path]}
          onChange={(e: { target: HTMLInputElement }) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (optional && e.target.value.trim() === '') return set(path, undefined);
            set(path, e.target.value.trim() === '' || !Number.isFinite(n) ? null : 1 + n / 100);
          }}
        />
        <span aria-hidden="true">% markup</span>
      </span>
      {errors[path] ? (
        <span className="field-error">{errors[path]}</span>
      ) : margin !== null ? (
        <span className="fine-inline">= {margin.toFixed(1)}% gross margin</span>
      ) : null}
    </div>
  );
}

function Int({ id, label, path, cfg, set, errors, disabled }: { id: string; label: string; path: string; cfg: Cfg; set: (p: string, v: unknown) => void; errors: Record<string, string>; disabled?: boolean }) {
  const v = getIn(cfg, path);
  return (
    <div className="px-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="numeric" value={v ?? ''} disabled={disabled} aria-invalid={!!errors[path]} onChange={(e: { target: HTMLInputElement }) => set(path, e.target.value === '' ? null : Number(e.target.value))} />
      {errors[path] && <span className="field-error">{errors[path]}</span>}
    </div>
  );
}

export function PricingPanel({ api, locked }: { api: AdminClient; locked: boolean }) {
  const [dto, setDto] = useState<PricingDto | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sample, setSample] = useState({ quantity: 144, colorCount: 2 });
  const [status, setStatus] = useState<{ busy: boolean; ok: string | null; err: string | null; warnings: string[] }>({ busy: false, ok: null, err: null, warnings: [] });
  const [formKey, setFormKey] = useState(0); // remount inputs after a reset so their text follows

  useEffect(() => {
    if (locked) return;
    api.get<PricingDto>('settings/pricing').then((d) => (setDto(d), setCfg(d.config)));
  }, [api, locked]);

  const set = (path: string, v: unknown) => setCfg((c) => (c ? setIn(c, path, v) : c));
  const dirty = useMemo(() => !!dto && !!cfg && JSON.stringify(dto.config) !== JSON.stringify(cfg), [dto, cfg]);

  // Live preview, debounced: validates too, so errors show while typing.
  useEffect(() => {
    if (!cfg) return;
    const t = setTimeout(async () => {
      try {
        const p = await api.post<Preview>('settings/pricing/preview', { config: cfg, ...sample });
        setPreview(p);
        setErrors({});
      } catch (e) {
        if (isApiError(e) && e.errors) setErrors(e.errors);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [api, cfg, sample]);

  if (locked) {
    return (
      <div className="settings">
        <section className="settings-section">
          <h2 className="admin-h2">Pricing</h2>
          <p className="note">Your storefront uses BrandCanvas's placeholder prices. Upgrade to Starter to set your own markups, fees and decoration rates.</p>
        </section>
      </div>
    );
  }
  if (!dto || !cfg) return <p className="fine">Loading…</p>;
  const ro = !dto.isOwner;
  const methodOn = new Set(dto.methods.map((m) => m.key));
  const F = { cfg, set, errors, disabled: ro };

  async function save() {
    setStatus({ busy: true, ok: null, err: null, warnings: [] });
    try {
      const r = await api.put<{ warnings: string[] }>('settings/pricing', { config: cfg });
      setDto((d) => (d ? { ...d, config: cfg!, usingOwnRates: true } : d));
      setStatus({ busy: false, ok: 'Saved. Your storefront shows these prices now.', err: null, warnings: r.warnings });
    } catch (e) {
      if (isApiError(e) && e.errors) setErrors(e.errors);
      setStatus({ busy: false, ok: null, err: isApiError(e) ? e.message : 'Could not save.', warnings: [] });
    }
  }
  function resetRates() {
    setCfg({ ...cfg, rates: structuredClone(dto!.defaults.rates) });
    setFormKey((k) => k + 1);
  }
  function discard() {
    setCfg(dto!.config);
    setErrors({});
    setFormKey((k) => k + 1);
  }

  const tiers = (cfg.rates.screen_print.runByBreak as { minQty: number; base: number; perColor: number }[]) ?? [];
  const rush = cfg.fees.rush as { mode: 'none' | 'percent' | 'flat'; percent?: number; flat?: number };

  return (
    <div className="pricing">
      <div className="pricing-form" key={formKey}>
        {ro && <p className="note">You can explore prices here. Only the account owner can save changes.</p>}
        {!dto.usingOwnRates && <p className="note">These are BrandCanvas's placeholder rates. Replace them with your own before relying on the prices.</p>}

        <section className="settings-section">
          <h2 className="admin-h2">Markups</h2>
          <Markup id="px-margin" label="On blank products" path="marginMarkup" {...F} />
          <Markup id="px-deco" label="On decoration" path="decorationMarkup" {...F} />
          <details className="px-more">
            <summary>Different markup for a category</summary>
            {dto.categories.map((c) => (
              <Markup key={c} id={`px-cat-${c}`} label={c} path={`categoryMarkupOverrides.${c}`} optional {...F} />
            ))}
          </details>
        </section>

        <section className="settings-section">
          <h2 className="admin-h2">Fees</h2>
          <div className="settings-pair">
            <Money id="px-ltm" label="Small-order fee" path="fees.ltmFee" hint="Charged when the quantity is below the decoration minimum." {...F} />
            <Money id="px-pms" label="Colour match, per colour" path="fees.pmsMatchFee" {...F} />
            <Money id="px-pers" label="Personalisation, per item" path="fees.personalizationPerUnit" {...F} />
          </div>
          <fieldset disabled={ro} className="px-rush">
            <legend>Rush orders</legend>
            {(['none', 'percent', 'flat'] as const).map((m) => (
              <label key={m} className="radio">
                <input type="radio" name="rush" checked={rush.mode === m} onChange={() => set('fees.rush', m === 'none' ? { mode: 'none' } : m === 'percent' ? { mode: 'percent', percent: rush.percent ?? 15 } : { mode: 'flat', flat: rush.flat ?? 5000 })} />
                <span>{m === 'none' ? 'No rush charge' : m === 'percent' ? 'Percentage of the order' : 'Flat amount'}</span>
              </label>
            ))}
            {rush.mode === 'percent' && <Int id="px-rush-pct" label="Rush percentage" path="fees.rush.percent" {...F} />}
            {rush.mode === 'flat' && <Money id="px-rush-flat" label="Rush charge" path="fees.rush.flat" {...F} />}
          </fieldset>
        </section>

        <section className="settings-section">
          <h2 className="admin-h2">What prospects see</h2>
          <label htmlFor="px-round">Price per item</label>
          <select id="px-round" value={cfg.rounding} disabled={ro} onChange={(e: { target: HTMLSelectElement }) => set('rounding', e.target.value)}>
            <option value="none">Exact, to the cent</option>
            {cfg.rounding === 'nearest_cent' && <option value="nearest_cent">Exact, to the cent</option>}
            <option value="nearest_5c">Rounded to the nearest 5¢</option>
            <option value="charm_95">Ending in .95</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={!!cfg.showItemizedToProspect} disabled={ro} onChange={(e: { target: HTMLInputElement }) => set('showItemizedToProspect', e.target.checked)} />
            Show the cost breakdown (blanks, setup, run, fees) on quotes
          </label>
        </section>

        <section className="settings-section">
          <h2 className="admin-h2">Decoration rates</h2>
          <p className="fine">Your cost to decorate, before your decoration markup. Only methods on your plan are shown.</p>
          {methodOn.has('screen_print') && (
            <details className="px-method" open>
              <summary>Screen printing</summary>
              <Money id="px-sp-screen" label="Screen charge, per colour per location" path="rates.screen_print.screenChargePerColor" {...F} />
              <table className="px-tiers">
                <caption className="fine">Run charge per item: base + per colour, by quantity</caption>
                <thead>
                  <tr><th scope="col">From qty</th><th scope="col">Base</th><th scope="col">Per colour</th><th><span className="sr-only">Remove</span></th></tr>
                </thead>
                <tbody>
                  {tiers.map((_, i) => (
                    <tr key={i}>
                      <td><Int id={`px-t${i}-q`} label={`Tier ${i + 1} from quantity`} path={`rates.screen_print.runByBreak.${i}.minQty`} {...F} /></td>
                      <td><Money id={`px-t${i}-b`} label={`Tier ${i + 1} base`} path={`rates.screen_print.runByBreak.${i}.base`} {...F} /></td>
                      <td><Money id={`px-t${i}-c`} label={`Tier ${i + 1} per colour`} path={`rates.screen_print.runByBreak.${i}.perColor`} {...F} /></td>
                      <td>
                        {!ro && tiers.length > 1 && (
                          <button type="button" className="btn-quiet px-tier-remove" onClick={() => (set('rates.screen_print.runByBreak', tiers.filter((__, j) => j !== i)), setFormKey((k) => k + 1))}>
                            <span className="px-remove-word">Remove</span>
                            <span className="px-remove-x" aria-hidden="true">×</span>
                            <span className="sr-only"> tier {i + 1}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {errors['rates.screen_print.runByBreak'] && <span className="field-error">{errors['rates.screen_print.runByBreak']}</span>}
              {!ro && tiers.length < 12 && (
                <button type="button" className="btn-outline" onClick={() => set('rates.screen_print.runByBreak', [...tiers, { ...tiers[tiers.length - 1]!, minQty: (tiers[tiers.length - 1]?.minQty ?? 0) * 2 || 12 }])}>
                  Add a quantity tier
                </button>
              )}
            </details>
          )}
          {methodOn.has('embroidery') && (
            <details className="px-method">
              <summary>Embroidery</summary>
              <div className="settings-pair">
                <Money id="px-em-dig" label="Digitizing (one-time)" path="rates.embroidery.digitizingFee" {...F} />
                <Money id="px-em-rate" label="Per 1,000 stitches" path="rates.embroidery.ratePer1kStitches" {...F} />
                <Int id="px-em-inc" label="Thread colours included" path="rates.embroidery.includedThreadColors" {...F} />
                <Money id="px-em-extra" label="Each extra thread colour" path="rates.embroidery.extraThreadColorFee" {...F} />
              </div>
            </details>
          )}
          {(['dtg', 'dtf', 'sublimation'] as const).filter((k) => methodOn.has(k)).map((k) => (
            <details key={k} className="px-method">
              <summary>{dto.methods.find((m) => m.key === k)!.label}</summary>
              <div className="settings-pair">
                {(['small', 'medium', 'large'] as const).map((sz) => (
                  <Money key={sz} id={`px-${k}-${sz}`} label={`${sz[0]!.toUpperCase()}${sz.slice(1)} print, per item`} path={`rates.${k}.perUnitBySize.${sz}`} {...F} />
                ))}
                {k === 'dtg' && <Money id="px-dtg-dark" label="Dark garment surcharge, per item" path="rates.dtg.darkSurchargePerUnit" {...F} />}
              </div>
            </details>
          ))}
          {([
            ['laser_engraving', 'setup', 'Setup (one-time)'],
            ['pad_printing', 'setupPerColor', 'Setup per colour (one-time)'],
            ['deboss_emboss', 'dieSetup', 'Die (one-time)'],
            ['heat_transfer_htv', 'setup', 'Setup (one-time)'],
          ] as const)
            .filter(([k]) => methodOn.has(k))
            .map(([k, setupKey, setupLabel]) => (
              <details key={k} className="px-method">
                <summary>{dto.methods.find((m) => m.key === k)!.label}</summary>
                <div className="settings-pair">
                  <Money id={`px-${k}-setup`} label={setupLabel} path={`rates.${k}.${setupKey}`} {...F} />
                  <Money id={`px-${k}-unit`} label="Per item" path={`rates.${k}.perUnit`} {...F} />
                </div>
              </details>
            ))}
          {!ro && (
            <button type="button" className="btn-quiet" onClick={resetRates}>
              Fill in BrandCanvas's placeholder rates
            </button>
          )}
        </section>

        {!ro && (
          <div className="pricing-actions">
            <button type="button" className="btn-brand" onClick={save} disabled={status.busy || !dirty}>
              {status.busy ? 'Saving…' : 'Save pricing'}
            </button>
            {dirty && <button type="button" className="btn-quiet" onClick={discard}>Discard changes</button>}
            {status.ok && <span className="saved" role="status">{status.ok}</span>}
            {status.err && <span className="error" role="alert">{status.err}</span>}
          </div>
        )}
      </div>

      <aside className="ticket" aria-label="Price preview" aria-live="polite">
        <h2 className="ticket-title">What a prospect sees</h2>
        <div className="ticket-sample">
          <label htmlFor="px-qty">Quantity</label>
          <input id="px-qty" inputMode="numeric" value={sample.quantity} onChange={(e: { target: HTMLInputElement }) => setSample({ ...sample, quantity: Math.max(1, Math.min(100_000, Number(e.target.value) || 1)) })} />
          <label htmlFor="px-colors">Logo colours</label>
          <input id="px-colors" inputMode="numeric" value={sample.colorCount} onChange={(e: { target: HTMLInputElement }) => setSample({ ...sample, colorCount: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} />
        </div>
        {Object.keys(errors).length > 0 && <p className="error" role="alert">Fix the highlighted fields to update the preview.</p>}
        {preview && (
          <>
            <ul className="ticket-rows">
              {preview.rows.map((r) => {
                const delta = r.currentUnit === null ? 0 : r.unit - r.currentUnit;
                return (
                  <li key={r.slug}>
                    <details>
                      <summary>
                        <span className="ticket-name">{r.name}<span className="fine-inline">{r.method}</span></span>
                        <span className="ticket-price">
                          <strong>{usd(r.unit)}</strong> each
                          {delta !== 0 && dirty && (
                            <span className={`ticket-delta ${delta > 0 ? 'is-up' : 'is-down'}`}>
                              {delta > 0 ? '+' : '−'}{usd(Math.abs(delta))}
                            </span>
                          )}
                          <span className="fine-inline">{usd(r.total)} total</span>
                        </span>
                      </summary>
                      {r.lines ? (
                        <table className="ticket-lines">
                          <tbody>
                            {r.lines.map((l, i) => (
                              <tr key={i}><td>{l.label}</td><td>{usd(l.amount)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="fine">Prospects see the total only (breakdown hidden).</p>
                      )}
                    </details>
                  </li>
                );
              })}
            </ul>
            {preview.warnings.length > 0 && (
              <ul className="ticket-warnings">
                {preview.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
            <p className="fine">{preview.disclaimer}</p>
          </>
        )}
      </aside>
    </div>
  );
}
