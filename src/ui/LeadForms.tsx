'use client';
/**
 * Lead capture forms (Phase 7). Presentation only — every rule (gating, plan, validation,
 * pricing, bot screening) is enforced by the tenant API. Copy states plainly who receives the
 * prospect's details; nothing here promises an email we don't send.
 */
import { useRef, useState } from 'react';
import { CONSENT_TEXT } from '@/features/leads/rules';

type Result<T> = { ok: true; data: T } | { ok: false; message: string; fields: Record<string, string> };

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as { error?: { message?: string; fields?: Record<string, string> } } & T;
    if (!r.ok) return { ok: false, message: b.error?.message ?? `Request failed (${r.status}).`, fields: b.error?.fields ?? {} };
    return { ok: true, data: b };
  } catch {
    return { ok: false, message: 'Network problem — check your connection and try again.', fields: {} };
  }
}

/** Honeypot + fill-time signals the server uses to screen bots. */
function useBotSignals() {
  const startedAt = useRef(Date.now());
  const [website, setWebsite] = useState('');
  const field = (
    <div className="hp" aria-hidden="true">
      <label>
        Website
        <input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e: { target: HTMLInputElement }) => setWebsite(e.target.value)} />
      </label>
    </div>
  );
  return { field, signals: () => ({ website, startedAt: startedAt.current }) };
}

function Consent({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label className="consent" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e: { target: HTMLInputElement }) => onChange(e.target.checked)} />
      <span>{CONSENT_TEXT}</span>
    </label>
  );
}

function FieldError({ msg }: { msg: string | undefined }) {
  return msg ? <span className="field-error">{msg}</span> : null;
}

/* ------------------------------ email gate ------------------------------ */

export function EmailGate(props: {
  apiBase: string;
  logoId: string | null;
  contactName: string;
  mode: 'hard' | 'soft';
  lockedCount: number;
  onCaptured: (email: string) => void;
}) {
  const bot = useBotSignals();
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await postJson(`${props.apiBase}/leads/email`, { email, marketingOptIn: optIn, logoId: props.logoId, ...bot.signals() });
    setBusy(false);
    if (!r.ok) return setErr(r);
    setDone(true);
    props.onCaptured(email.trim());
  };

  if (done && props.mode === 'soft') return <p className="gate-done" role="status">Thanks — {props.contactName} has your email and will follow up.</p>;

  return (
    <form id="gate" className="gate" onSubmit={submit} noValidate>
      <h2 className="gate-title">
        {props.mode === 'hard'
          ? `See your logo on ${props.lockedCount} more ${props.lockedCount === 1 ? 'product' : 'products'}`
          : `Want ${props.contactName} to follow up?`}
      </h2>
      <p className="gate-text">
        {props.mode === 'hard'
          ? `Enter your email to unlock every product. We share it with ${props.contactName} so they can help with your order.`
          : `Leave your email and ${props.contactName} will get in touch about your logo and pricing.`}
      </p>
      <div className="gate-row">
        <label className="sr-only" htmlFor="gate-email">Email</label>
        <input id="gate-email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={(e: { target: HTMLInputElement }) => setEmail(e.target.value)} aria-invalid={!!err?.fields.email} required />
        <button type="submit" className="btn-brand" disabled={busy}>
          {busy ? 'Sending…' : props.mode === 'hard' ? 'Show all products' : `Send to ${props.contactName}`}
        </button>
      </div>
      <FieldError msg={err?.fields.email} />
      <Consent id="gate-consent" checked={optIn} onChange={setOptIn} />
      {bot.field}
      {err && !err.fields.email && <p className="error" role="alert">{err.message}</p>}
    </form>
  );
}

/* ------------------------------ quote request ------------------------------ */

export interface QuoteTarget {
  slug: string;
  name: string;
  color: { name: string; hex: string };
  method: string;
  methodLabel: string;
  location: string;
}

export function QuoteForm(props: {
  apiBase: string;
  item: QuoteTarget;
  qty: number;
  logoId: string | null;
  defaultEmail: string;
  onSent: (email: string) => void;
  onCancel: () => void;
}) {
  const bot = useBotSignals();
  const [f, setF] = useState({ name: '', email: props.defaultEmail, company: '', phone: '', quantity: String(props.qty), notes: '' });
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await postJson<{ message: string }>(`${props.apiBase}/leads/quote`, {
      ...f,
      quantity: Number(f.quantity),
      product: props.item.slug,
      color: props.item.color.hex,
      method: props.item.method,
      location: props.item.location,
      logoId: props.logoId,
      marketingOptIn: optIn,
      ...bot.signals(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r);
    setSent(r.data.message);
    props.onSent(f.email.trim());
  };

  if (sent) return <p className="quote-sent" role="status">{sent}</p>;
  const id = (k: string) => `q-${props.item.slug}-${k}`;
  return (
    <form className="quote" onSubmit={submit} noValidate aria-label={`Request a quote for ${props.item.name}`}>
      <p className="quote-summary">
        {props.item.name} in {props.item.color.name}, {props.item.methodLabel.toLowerCase()}
      </p>
      <label htmlFor={id('name')}>Name</label>
      <input id={id('name')} autoComplete="name" value={f.name} onChange={set('name')} aria-invalid={!!err?.fields.name} />
      <FieldError msg={err?.fields.name} />
      <label htmlFor={id('email')}>Email</label>
      <input id={id('email')} type="email" autoComplete="email" value={f.email} onChange={set('email')} aria-invalid={!!err?.fields.email} />
      <FieldError msg={err?.fields.email} />
      <div className="quote-pair">
        <div>
          <label htmlFor={id('company')}>Company <span className="optional">optional</span></label>
          <input id={id('company')} autoComplete="organization" value={f.company} onChange={set('company')} />
        </div>
        <div>
          <label htmlFor={id('qty')}>Quantity</label>
          <input id={id('qty')} inputMode="numeric" value={f.quantity} onChange={set('quantity')} aria-invalid={!!err?.fields.quantity} />
        </div>
      </div>
      <FieldError msg={err?.fields.quantity} />
      <label htmlFor={id('phone')}>Phone <span className="optional">optional</span></label>
      <input id={id('phone')} type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} aria-invalid={!!err?.fields.phone} />
      <FieldError msg={err?.fields.phone} />
      <label htmlFor={id('notes')}>Anything else? <span className="optional">optional</span></label>
      <textarea id={id('notes')} rows={3} value={f.notes} onChange={set('notes')} placeholder="Deadline, sizes, second print location…" />
      <Consent id={id('consent')} checked={optIn} onChange={setOptIn} />
      {bot.field}
      {err && <p className="error" role="alert">{err.message}</p>}
      <div className="quote-actions">
        <button type="submit" className="btn-brand" disabled={busy}>{busy ? 'Sending…' : 'Send quote request'}</button>
        <button type="button" className="btn-quiet" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/* ------------------------------ PDF product sheet ------------------------------ */

export function SheetDownload(props: {
  apiBase: string;
  logoId: string;
  qty: number;
  filters: { families: string[]; categories: string[]; methods: string[] };
  knownEmail: string | null;
  onCaptured: (email: string) => void;
}) {
  const bot = useBotSignals();
  const [asking, setAsking] = useState(false);
  const [email, setEmail] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async (withForm: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${props.apiBase}/leads/leave-behind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          logoId: props.logoId,
          qty: props.qty,
          ...props.filters,
          ...(withForm ? { email, marketingOptIn: optIn, ...bot.signals() } : {}),
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        if (r.status === 422 && !withForm) return setAsking(true);
        return setErr(b.error?.message ?? 'Could not create the product sheet.');
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'product-sheet.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      if (withForm) props.onCaptured(email.trim());
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };

  if (!asking) {
    return (
      <div className="sheet">
        <button type="button" className="btn-outline" disabled={busy} onClick={() => (props.knownEmail ? void download(false) : setAsking(true))}>
          {busy ? 'Preparing PDF…' : 'Download product sheet (PDF)'}
        </button>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    );
  }
  return (
    <form
      className="sheet sheet-form"
      noValidate
      onSubmit={(e: { preventDefault(): void }) => {
        e.preventDefault();
        void download(true);
      }}
    >
      <label htmlFor="sheet-email">Email for your product sheet</label>
      <div className="gate-row">
        <input id="sheet-email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e: { target: HTMLInputElement }) => setEmail(e.target.value)} />
        <button type="submit" className="btn-brand" disabled={busy}>{busy ? 'Preparing PDF…' : 'Download PDF'}</button>
      </div>
      <Consent id="sheet-consent" checked={optIn} onChange={setOptIn} />
      {bot.field}
      {err && <p className="error" role="alert">{err}</p>}
    </form>
  );
}
