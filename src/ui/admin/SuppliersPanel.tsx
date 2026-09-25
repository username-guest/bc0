'use client';
/**
 * Supplier connections (ADR 0017), in Settings, for owners. Connect a supplier's PromoStandards
 * services, sync its catalog into the storefront, and see what couldn't be imported and why.
 * The password is write-only: the server never sends it back.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { isApiError, type AdminClient, type ApiError } from './client';

type Status = 'never' | 'queued' | 'running' | 'ok' | 'partial' | 'failed';
interface Summary {
  at: string;
  created: number;
  updated: number;
  hidden: number;
  skipped: number;
  failed: number;
  remaining: number;
  error?: string;
  notes: string[];
}
interface Supplier {
  id: string;
  name: string;
  productDataUrl: string;
  pricingUrl: string;
  accountId: string;
  hasPassword: boolean;
  currency: string;
  priceType: 'Net' | 'List';
  fobId: string | null;
  productIds: string[];
  status: Status;
  lastSync: Summary | null;
  createdAt: string;
}
interface SuppliersDto {
  suppliers: Supplier[];
  canUse: boolean;
  upgradeable: boolean;
  defaultCurrency: string;
  maxSuppliers: number;
  maxProductsPerRun: number;
}

interface Form {
  name: string;
  productDataUrl: string;
  pricingUrl: string;
  accountId: string;
  password: string;
  currency: string;
  priceType: 'Net' | 'List';
  fobId: string;
  productIds: string;
}

const STATUS: Record<Status, string> = {
  never: 'Not synced yet',
  queued: 'Waiting to sync',
  running: 'Syncing…',
  ok: 'Up to date',
  partial: 'Partly synced',
  failed: 'Last sync failed',
};
const asError = (e: unknown): ApiError => (isApiError(e) ? e : { status: 0, code: 'unknown', message: 'Something went wrong. Try again.' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function emptyForm(currency: string): Form {
  return { name: '', productDataUrl: '', pricingUrl: '', accountId: '', password: '', currency, priceType: 'Net', fobId: '', productIds: '' };
}
function formFor(s: Supplier): Form {
  return {
    name: s.name,
    productDataUrl: s.productDataUrl,
    pricingUrl: s.pricingUrl,
    accountId: s.accountId,
    password: '',
    currency: s.currency,
    priceType: s.priceType,
    fobId: s.fobId ?? '',
    productIds: s.productIds.join('\n'),
  };
}

export function SuppliersPanel({ api }: { api: AdminClient }) {
  const [dto, setDto] = useState<SuppliersDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<Form>(emptyForm('USD'));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api
        .get<SuppliersDto>('suppliers')
        .then((d) => (setDto(d), setErr(null)))
        .catch((e) => setErr(asError(e).message)),
    [api],
  );
  useEffect(() => void reload(), [reload]);

  // While a sync is waiting or running, check back every few seconds.
  const active = !!dto?.suppliers.some((s) => s.status === 'queued' || s.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [active, reload]);
  // Once nothing is syncing, the "Syncing…" note has done its job (the row shows the result).
  useEffect(() => {
    if (!active) setMsg((m) => (m?.ok?.startsWith('Syncing') ? null : m));
  }, [active]);

  if (err) return <section className="settings-section"><h2 className="admin-h2">Suppliers</h2><p className="error" role="alert">{err}</p></section>;
  if (!dto) return null;

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      const ok = await action();
      await reload();
      setMsg({ ok });
    } catch (e) {
      await reload();
      setMsg({ err: asError(e).message });
    } finally {
      setBusy(false);
    }
  }

  /** Queue a sync; say "syncing" only if it's still going when the list comes back. */
  async function sync(s: Supplier) {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`suppliers/${s.id}/sync`);
      const d = await api.get<SuppliersDto>('suppliers');
      setDto(d);
      const now = d.suppliers.find((x) => x.id === s.id);
      if (now && (now.status === 'queued' || now.status === 'running')) setMsg({ ok: `Syncing “${s.name}”. This page updates when it’s done.` });
    } catch (e) {
      await reload();
      setMsg({ err: asError(e).message });
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof Form) => (e: { target: HTMLInputElement | HTMLTextAreaElement }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFields({});
    const body = { ...form, fobId: form.fobId.trim(), productIds: form.productIds };
    try {
      if (editing === 'new') {
        await api.post('suppliers', body);
        setMsg({ ok: `Connected “${form.name}”. Press Sync now to bring in its products.` });
      } else if (editing) {
        await api.put(`suppliers/${editing}`, body);
        setMsg({ ok: `Saved “${form.name}”.` });
      }
      setEditing(null);
      await reload();
    } catch (x) {
      const a = asError(x);
      setFields(a.fields ?? {});
      setMsg({ err: a.message });
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof Form, label: string, input: ReactNode, hint?: string) => (
    <div className={`sup-field${fields[k] ? ' has-error' : ''}`}>
      <label htmlFor={`sup-${k}`}>{label}</label>
      {input}
      {fields[k] ? <p className="field-error" id={`sup-${k}-err`}>{fields[k]}</p> : hint ? <p className="fine">{hint}</p> : null}
    </div>
  );
  const describedBy = (k: keyof Form) => (fields[k] ? { 'aria-invalid': true, 'aria-describedby': `sup-${k}-err` } : {});
  const full = dto.suppliers.length >= dto.maxSuppliers;

  return (
    <section className="settings-section suppliers" aria-labelledby="sup-h">
      <h2 className="admin-h2" id="sup-h">Suppliers</h2>
      <p className="fine">
        Bring products and your costs straight from a supplier through PromoStandards. Your supplier gives you the service addresses,
        an account ID and a password. Prospects see only the prices your pricing rules produce, never your costs.
      </p>

      {!dto.canUse && (
        <p className="note">
          {dto.upgradeable ? 'Supplier connections are available on the Enterprise plan.' : 'Supplier connections are turned off for this workspace.'}
          {dto.suppliers.length ? ' Existing connections no longer sync; you can still remove them.' : ''}
        </p>
      )}

      {dto.canUse && editing === null && (
        <button type="button" className="btn-brand" disabled={busy || full} onClick={() => (setForm(emptyForm(dto.defaultCurrency)), setFields({}), setMsg(null), setEditing('new'))}>
          Connect a supplier
        </button>
      )}
      {dto.canUse && full && editing === null && <p className="fine">You’ve connected {dto.maxSuppliers} suppliers, the most allowed.</p>}

      {editing !== null && (
        <form className="sup-form" onSubmit={save} noValidate>
          <fieldset disabled={busy}>
            <legend className="sup-legend">{editing === 'new' ? 'Connect a supplier' : `Edit ${form.name || 'supplier'}`}</legend>
            {field('name', 'Supplier name', <input id="sup-name" required maxLength={60} placeholder="e.g. Acme Promo" value={form.name} onChange={set('name')} {...describedBy('name')} />)}
            {field(
              'productDataUrl',
              'Product Data service address',
              <input id="sup-productDataUrl" type="url" required inputMode="url" placeholder="https://…" value={form.productDataUrl} onChange={set('productDataUrl')} {...describedBy('productDataUrl')} />,
              'Product Data 2.0.0. Your supplier lists it, or look it up in the PromoStandards directory.',
            )}
            {field(
              'pricingUrl',
              'Pricing and Configuration service address',
              <input id="sup-pricingUrl" type="url" required inputMode="url" placeholder="https://…" value={form.pricingUrl} onChange={set('pricingUrl')} {...describedBy('pricingUrl')} />,
              'Pricing and Configuration 1.0.0.',
            )}
            {field('accountId', 'Account ID', <input id="sup-accountId" required autoComplete="off" value={form.accountId} onChange={set('accountId')} {...describedBy('accountId')} />)}
            {field(
              'password',
              'Password',
              <input
                id="sup-password"
                type="password"
                autoComplete="new-password"
                required={editing === 'new'}
                placeholder={editing === 'new' ? '' : 'Leave blank to keep the saved password'}
                value={form.password}
                onChange={set('password')}
                {...describedBy('password')}
              />,
              editing === 'new' ? 'Stored encrypted. It is never shown again, even to you.' : undefined,
            )}
            <div className="sup-row">
              {field('currency', 'Currency', <input id="sup-currency" maxLength={3} value={form.currency} onChange={set('currency')} {...describedBy('currency')} />)}
              {field('fobId', 'FOB ID (optional)', <input id="sup-fobId" maxLength={50} value={form.fobId} onChange={set('fobId')} {...describedBy('fobId')} />, 'Blank: the supplier’s first shipping point.')}
            </div>
            <fieldset className="team-roles">
              <legend className="fine-inline">Prices to import</legend>
              <label className="radio">
                <input type="radio" name="sup-price" checked={form.priceType === 'Net'} onChange={() => setForm((f) => ({ ...f, priceType: 'Net' }))} />
                <span>Your cost (Net). Your markup is applied on top.</span>
              </label>
              <label className="radio">
                <input type="radio" name="sup-price" checked={form.priceType === 'List'} onChange={() => setForm((f) => ({ ...f, priceType: 'List' }))} />
                <span>List price</span>
              </label>
            </fieldset>
            {field(
              'productIds',
              'Only these products (optional)',
              <textarea id="sup-productIds" rows={3} placeholder="One product ID per line, or commas" value={form.productIds} onChange={set('productIds')} {...describedBy('productIds')} />,
              `Blank: everything the supplier sells, up to ${dto.maxProductsPerRun} per sync.`,
            )}
            <div className="sup-actions">
              <button type="submit" className="btn-brand">{busy ? 'Saving…' : editing === 'new' ? 'Connect' : 'Save'}</button>
              <button type="button" className="btn-quiet" onClick={() => (setEditing(null), setFields({}), setMsg(null))}>Cancel</button>
            </div>
          </fieldset>
        </form>
      )}

      {msg?.ok && <p className="saved" role="status">{msg.ok}</p>}
      {msg?.err && <p className="error" role="alert">{msg.err}</p>}

      {dto.suppliers.length > 0 && (
        <ul className="an-link-list">
          {dto.suppliers.map((s) => {
            const syncing = s.status === 'queued' || s.status === 'running';
            const L = s.lastSync;
            return (
              <li key={s.id} className="an-link sup-item">
                <div className="an-link-who">
                  <span className="team-email">{s.name}</span>
                  <span className={`tag sup-status sup-${s.status}`} role="status">{STATUS[s.status]}</span>
                  <span className="fine an-channel">
                    Account <code>{s.accountId}</code> · {s.priceType === 'Net' ? 'your cost' : 'list price'} in {s.currency}
                    {s.productIds.length ? ` · ${plural(s.productIds.length, 'picked product')}` : ''}
                  </span>
                  {L && !L.error && (
                    <span className="fine an-channel sup-summary">
                      {when(L.at)}: {plural(L.created, 'product')} added, {L.updated} updated
                      {L.hidden ? `, ${L.hidden} hidden (no longer sold)` : ''}
                      {L.skipped ? ` · ${L.skipped} not imported` : ''}
                      {L.failed ? ` · ${L.failed} couldn’t be fetched` : ''}
                    </span>
                  )}
                  {L?.error && <span className="fine an-channel error sup-error">{when(L.at)}: {L.error}</span>}
                  {L && L.notes.length > 0 && (
                    <details className="sup-notes">
                      <summary>What was left out ({L.notes.length})</summary>
                      <ul>
                        {L.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
                {confirming !== s.id && (
                  <div className="team-actions">
                    {dto.canUse && (
                      <>
                        <button
                          type="button"
                          className="btn-quiet"
                          disabled={busy || syncing}
                          onClick={() => void sync(s)}
                        >
                          {syncing ? 'Syncing…' : 'Sync now'}
                        </button>
                        <button type="button" className="btn-quiet" disabled={busy} onClick={() => (setForm(formFor(s)), setFields({}), setMsg(null), setEditing(s.id))}>Edit</button>
                      </>
                    )}
                    <button type="button" className="btn-quiet btn-danger-quiet" disabled={busy} onClick={() => setConfirming(s.id)}>Remove</button>
                  </div>
                )}
                {confirming === s.id && (
                  <div className="team-confirm" role="group" aria-label={`Confirm removing ${s.name}`}>
                    <p>Remove “{s.name}”? Its products leave your storefront and the saved password is deleted.</p>
                    <button type="button" className="btn-danger" onClick={() => (setConfirming(null), void run(async () => (await api.del(`suppliers/${s.id}`), `Removed “${s.name}”.`)))}>Remove</button>
                    <button type="button" className="btn-quiet" onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
