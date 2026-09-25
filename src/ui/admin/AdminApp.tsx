'use client';
/**
 * Tenant admin (ADR 0008): sign-in, the lead inbox, and settings. All gating is enforced by the
 * server; this UI only mirrors it (disabled controls explain why, the API refuses regardless).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminClient, isApiError, type AdminClient, type ApiError } from './client';
import { PricingPanel } from './PricingPanel';
import { TeamPanel } from './TeamPanel';
import { AnalyticsPanel } from './AnalyticsPanel';
import { ApiKeysPanel } from './ApiKeysPanel';
import { SuppliersPanel } from './SuppliersPanel';

/** Lead-level summary from the API: `crm` = really delivered to the tenant's CRM; `inbox` = kept here only. */
type Delivery = 'none' | 'inbox' | 'crm' | 'pending' | 'failed' | 'dead';
type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';
type Source = 'email_gate' | 'quote_request' | 'pdf_leavebehind';

interface Me {
  user: { email: string; role: 'tenant_owner' | 'tenant_admin' };
  csrfToken: string;
  tenant: { name: string; plan: string };
  routing: 'inbox' | 'webhook';
  can: { customBranding: boolean; webhookRouting: boolean; quoteRequests: boolean; leaveBehind: boolean; pricing: boolean; manageTeam: boolean; analytics: boolean; analyticsUpgradeable: boolean };
}
interface Lead {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  marketingOptIn: boolean;
  consent: { version: string; at: string } | null;
  sources: Source[];
  createdAt: string;
  delivery: Delivery;
}
interface Detail {
  lead: Lead;
  events: { kind: string; at: string; payload: Record<string, unknown> }[];
  deliveries: { id: string; source: Source; status: DeliveryStatus; toCrm: boolean; attempts: number; nextAttemptAt: string | null; lastError: string | null; routedTo: string | null; createdAt: string; retryable: boolean }[];
}

const ACTIVITY: Record<string, string> = {
  'admin.sign_in_link_sent': 'Sign-in link sent',
  'admin.sign_in': 'Signed in',
  'admin.sign_out': 'Signed out',
  'settings.branding': 'Changed the storefront look',
  'settings.gate': 'Changed the email gate',
  'settings.routing': 'Changed where leads go',
  'settings.routing_test': 'Sent a test to the CRM',
  'leads.export_csv': 'Exported leads as CSV',
  'settings.pricing': 'Changed pricing',
  'delivery.retry': 'Retried a CRM delivery',
  'settings.features': 'Changed storefront features',
  'team.invite': 'Invited a teammate',
  'team.invite_resent': 'Resent an invite',
  'team.role_changed': 'Changed a teammate’s role',
  'team.removed': 'Removed someone from the team',
  'links.create': 'Created a tracked link',
  'links.update': 'Changed a tracked link',
  'api_keys.create': 'Created an API key',
  'api_keys.revoke': 'Revoked an API key',
};
const SOURCE_LABEL: Record<Source, string> = { email_gate: 'Email gate', quote_request: 'Quote request', pdf_leavebehind: 'Product sheet' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The delivery stamp: only shown when it tells the rep something (inbox-only leads get none). */
const STAMPS: Partial<Record<Delivery, [string, string]>> = {
  crm: ['Sent to CRM', 'is-sent'],
  pending: ['Sending', 'is-pending'],
  failed: ['Retrying', 'is-retrying'],
  dead: ['Not delivered', 'is-dead'],
};
function Stamp({ d }: { d: Delivery }) {
  const s = STAMPS[d];
  return s ? <span className={`stamp ${s[1]}`}>{s[0]}</span> : null;
}

export function AdminApp({ apiBase }: { apiBase: string }) {
  const api = useMemo(() => adminClient(apiBase), [apiBase]);
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [tab, setTab] = useState<'leads' | 'analytics' | 'pricing' | 'team' | 'settings'>('leads');

  const loadMe = useCallback(async () => {
    try {
      const m = await api.get<Me>('me');
      api.setCsrf(m.csrfToken);
      setMe(m);
    } catch {
      setMe(null);
    }
  }, [api]);
  useEffect(() => void loadMe(), [loadMe]);

  if (me === 'loading') return <main className="admin"><p className="fine">Loading…</p></main>;
  if (me === null) return <SignIn api={api} />;

  async function signOut() {
    await api.post('sign-out').catch(() => {});
    setMe(null);
  }

  return (
    <main className="admin">
      <div className="admin-bar">
        <nav className="admin-tabs" aria-label="Admin">
          <button type="button" aria-current={tab === 'leads' ? 'page' : undefined} onClick={() => setTab('leads')}>Leads</button>
          <button type="button" aria-current={tab === 'analytics' ? 'page' : undefined} onClick={() => setTab('analytics')}>Analytics</button>
          <button type="button" aria-current={tab === 'pricing' ? 'page' : undefined} onClick={() => setTab('pricing')}>Pricing</button>
          <button type="button" aria-current={tab === 'team' ? 'page' : undefined} onClick={() => setTab('team')}>Team</button>
          <button type="button" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>Settings</button>
        </nav>
        <span className="admin-who">
          {me.user.email}
          <button type="button" className="btn-quiet" onClick={signOut}>Sign out</button>
        </span>
      </div>
      {tab === 'leads' ? (
        <Leads api={api} me={me} />
      ) : tab === 'analytics' ? (
        <AnalyticsPanel api={api} dashboard={{ can: me.can.analytics, upgradeable: me.can.analyticsUpgradeable }} />
      ) : tab === 'pricing' ? (
        <PricingPanel api={api} locked={!me.can.pricing} />
      ) : tab === 'team' ? (
        <TeamPanel api={api} onRoleChanged={loadMe} onSignedOut={() => setMe(null)} />
      ) : (
        <Settings api={api} me={me} onSaved={loadMe} />
      )}
    </main>
  );
}

/* --------------------------------- sign in -------------------------------- */

function SignIn({ api }: { api: AdminClient }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setSent((await api.post<{ message: string }>('sign-in', { email })).message);
    } catch (x) {
      setErr(isApiError(x) ? x.message : 'Could not send the link. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-narrow">
      <h1 className="admin-h1">Sign in to your admin</h1>
      {sent ? (
        <p role="status" className="admin-sent">{sent}</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <label htmlFor="admin-email">Work email</label>
          <input id="admin-email" type="email" autoComplete="email" value={email} onChange={(e: { target: HTMLInputElement }) => setEmail(e.target.value)} aria-invalid={!!err} required />
          {err && <span className="field-error" role="alert">{err}</span>}
          <p className="fine">We'll email you a one-time sign-in link. No password needed.</p>
          <button type="submit" className="btn-brand" disabled={busy || !email}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
        </form>
      )}
    </main>
  );
}

/* ---------------------------------- leads --------------------------------- */

function Leads({ api, me }: { api: AdminClient; me: Me }) {
  const [items, setItems] = useState<Lead[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [source, setSource] = useState<Source | ''>('');
  const [attention, setAttention] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const query = useCallback(
    (after?: string) => {
      const p = new URLSearchParams({ limit: '25' });
      if (applied) p.set('search', applied);
      if (source) p.set('source', source);
      if (attention) p.set('attention', '1');
      if (after) p.set('cursor', after);
      return `leads?${p}`;
    },
    [applied, source, attention],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get<{ items: Lead[]; nextCursor: string | null }>(query())
      .then((r) => live && (setItems(r.items), setCursor(r.nextCursor), setErr(null)))
      .catch((e) => live && setErr(isApiError(e) ? e.message : 'Could not load leads.'))
      .finally(() => live && setLoading(false));
    return () => void (live = false);
  }, [api, query]);

  async function more() {
    if (!cursor) return;
    const r = await api.get<{ items: Lead[]; nextCursor: string | null }>(query(cursor));
    setItems((x) => [...x, ...r.items]);
    setCursor(r.nextCursor);
  }

  const filtered = !!(applied || source || attention);
  return (
    <div className={`inbox ${selected ? 'has-detail' : ''}`}>
      <section className="inbox-list" aria-label="Leads">
        <form className="inbox-tools" role="search" onSubmit={(e: { preventDefault(): void }) => (e.preventDefault(), setApplied(search.trim()))}>
          <label className="sr-only" htmlFor="lead-search">Search leads</label>
          <input id="lead-search" type="search" placeholder="Search email, name or company" value={search} onChange={(e: { target: HTMLInputElement }) => setSearch(e.target.value)} />
          <button type="submit" className="btn-outline">Search</button>
          <a className="btn-outline" href={api.csvUrl} download>Export CSV</a>
        </form>
        <div className="chips" role="group" aria-label="Filter by how they reached you">
          {(['', 'email_gate', 'quote_request', 'pdf_leavebehind'] as const).map((s) => (
            <button key={s || 'all'} type="button" className="chip" aria-pressed={source === s} onClick={() => setSource(s)}>
              {s ? SOURCE_LABEL[s] : 'All'}
            </button>
          ))}
          <button type="button" className="chip chip-attention" aria-pressed={attention} onClick={() => setAttention((a) => !a)}>
            Needs attention
          </button>
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        {!loading && items.length === 0 && !err && (
          <p className="inbox-empty">
            {filtered ? 'No leads match these filters.' : 'No leads yet. They appear here as soon as a prospect gives their email on your storefront.'}
          </p>
        )}
        <ul className="lead-rows">
          {items.map((l) => (
            <li key={l.id}>
              <button type="button" className="lead-row" aria-current={selected === l.id ? 'true' : undefined} onClick={() => setSelected(l.id)}>
                <span className="lead-who">
                  <strong>{l.name ?? l.email}</strong>
                  {l.name && <span className="lead-email">{l.email}</span>}
                  {l.company && <span className="lead-company">{l.company}</span>}
                </span>
                <span className="lead-meta">
                  <span className="lead-sources">{l.sources.map((s) => SOURCE_LABEL[s]).join(', ')}</span>
                  <time dateTime={l.createdAt}>{when(l.createdAt)}</time>
                </span>
                <Stamp d={l.delivery} />
              </button>
            </li>
          ))}
        </ul>
        {cursor && <button type="button" className="btn-outline inbox-more" onClick={more}>Show more</button>}
      </section>
      {selected && <LeadPane api={api} me={me} id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function eventLine(e: Detail['events'][number]): string {
  const p = e.payload;
  switch (e.kind) {
    case 'captured':
      return 'Gave their email';
    case 'quote_requested': {
      const prod = p.product as { name?: string } | undefined;
      const qty = typeof p.quantity === 'number' ? p.quantity : undefined;
      return `Asked for a quote${prod?.name ? `: ${prod.name}` : ''}${qty ? `, ${qty} units` : ''}`;
    }
    case 'leave_behind':
      return 'Downloaded a product sheet';
    case 'routed':
      return p.routedTo === 'mock' ? 'Saved to your inbox' : `Delivered to ${String(p.routedTo)}`;
    case 'routing_failed':
      return `Delivery failed${p.final ? ' (gave up)' : ''}: ${String(p.error ?? '')}`;
    default:
      return e.kind;
  }
}

function LeadPane({ api, me, id, onClose }: { api: AdminClient; me: Me; id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Detail>(`leads/${id}`).then(setD, (e) => setErr(isApiError(e) ? e.message : 'Could not load this lead.'));
  }, [api, id]);
  useEffect(load, [load]);

  async function retry(deliveryId: string) {
    setBusy(deliveryId);
    try {
      await api.post(`deliveries/${deliveryId}/retry`);
    } catch (e) {
      setErr(isApiError(e) ? e.message : 'Retry failed.');
    } finally {
      setBusy(null);
      load();
    }
  }

  if (err) return <aside className="lead-pane"><p className="error" role="alert">{err}</p></aside>;
  if (!d) return <aside className="lead-pane"><p className="fine">Loading…</p></aside>;
  const l = d.lead;
  return (
    <aside className="lead-pane" aria-label={`Lead ${l.email}`}>
      <button type="button" className="btn-quiet lead-close" onClick={onClose}>Back to leads</button>
      <h2 className="lead-title">{l.name ?? l.email}</h2>
      <dl className="lead-facts">
        <dt>Email</dt>
        <dd><a href={`mailto:${l.email}`}>{l.email}</a></dd>
        {l.company && (<><dt>Company</dt><dd>{l.company}</dd></>)}
        {l.phone && (<><dt>Phone</dt><dd><a href={`tel:${l.phone.replace(/[^+\d]/g, '')}`}>{l.phone}</a></dd></>)}
        <dt>Marketing</dt>
        <dd>{l.consent ? `Opted in ${when(l.consent.at)} (consent ${l.consent.version})` : 'Not opted in. Reply to their request only.'}</dd>
      </dl>
      <h3 className="lead-h3">What they did</h3>
      <ol className="timeline">
        {d.events.map((e, i) => (
          <li key={i} className={e.kind === 'routing_failed' ? 'is-problem' : undefined}>
            <time dateTime={e.at}>{when(e.at)}</time> {eventLine(e)}
          </li>
        ))}
      </ol>
      {me.routing === 'webhook' || d.deliveries.some((x) => x.status !== 'delivered') ? (
        <>
          <h3 className="lead-h3">CRM deliveries</h3>
          <ul className="deliveries">
            {d.deliveries.map((x) => (
              <li key={x.id}>
                <span>{SOURCE_LABEL[x.source]}</span>{' '}
                {x.status === 'delivered' ? (x.toCrm ? <Stamp d="crm" /> : <span className="fine-inline">Kept in this inbox</span>) : <Stamp d={x.status} />}
                <span className="fine">
                  {x.attempts} attempt{x.attempts === 1 ? '' : 's'}
                  {x.status === 'failed' && x.nextAttemptAt ? `, next try ${when(x.nextAttemptAt)}` : ''}
                  {x.lastError && x.status !== 'delivered' ? `. Last error: ${x.lastError}` : ''}
                </span>
                {x.retryable && (
                  <button type="button" className="btn-outline" onClick={() => retry(x.id)} disabled={busy === x.id}>
                    {busy === x.id ? 'Retrying…' : 'Retry now'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

/* -------------------------------- settings -------------------------------- */

interface SettingsDto {
  branding: { displayName: string; primaryHex: string; secondaryHex: string; fontFamily: string };
  fonts: string[];
  gate: { mode: 'off' | 'soft' | 'hard'; freeProducts: number; contactName: string };
  routing: { provider: 'mock' } | { provider: 'webhook'; url: string; hasSecret: boolean };
  can: { customBranding: boolean; webhookRouting: boolean };
  isOwner: boolean;
  recentActivity: { action: string; at: string; target: string | null; by: string }[];
}

function useSave(api: AdminClient, onSaved: () => void) {
  const [state, setState] = useState<{ busy: boolean; ok: string | null; err: ApiError | null }>({ busy: false, ok: null, err: null });
  const save = async <T,>(path: string, body: unknown, ok: string): Promise<T | null> => {
    setState({ busy: true, ok: null, err: null });
    try {
      const r = await api.put<T>(path, body);
      setState({ busy: false, ok, err: null });
      onSaved();
      return r;
    } catch (e) {
      setState({ busy: false, ok: null, err: isApiError(e) ? e : { status: 0, code: 'unknown', message: 'Could not save. Try again.' } });
      return null;
    }
  };
  return { ...state, save };
}

function Settings({ api, me, onSaved }: { api: AdminClient; me: Me; onSaved: () => void }) {
  const [s, setS] = useState<SettingsDto | null>(null);
  const reload = useCallback(() => void api.get<SettingsDto>('settings').then(setS), [api]);
  useEffect(reload, [reload]);
  if (!s) return <p className="fine">Loading…</p>;
  const saved = () => (reload(), onSaved());
  return (
    <div className="settings">
      <BrandingForm api={api} s={s} onSaved={saved} />
      <GateForm api={api} s={s} onSaved={saved} />
      <FeaturesForm api={api} onSaved={saved} />
      <RoutingForm api={api} s={s} me={me} onSaved={saved} />
      {me.can.manageTeam && <SuppliersPanel api={api} />}
      {me.can.manageTeam && <ApiKeysPanel api={api} />}
      {s.recentActivity.length > 0 && (
        <section className="settings-section">
          <h2 className="admin-h2">Recent changes</h2>
          <ul className="activity">
            {s.recentActivity.map((a, i) => (
              <li key={i}>
                <time dateTime={a.at}>{when(a.at)}</time> {ACTIVITY[a.action] ?? a.action}
                <span className="activity-by"> by {a.by}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const Status = ({ ok, err }: { ok: string | null; err: ApiError | null }) =>
  ok ? <p className="saved" role="status">{ok}</p> : err ? <p className="error" role="alert">{err.message}</p> : null;

function BrandingForm({ api, s, onSaved }: { api: AdminClient; s: SettingsDto; onSaved: () => void }) {
  const [b, setB] = useState(s.branding);
  const st = useSave(api, onSaved);
  const locked = !s.can.customBranding;
  const fe = st.err?.errors ?? {};
  return (
    <section className="settings-section">
      <h2 className="admin-h2">Storefront look</h2>
      {locked && <p className="note">Your plan shows BrandCanvas's default look. Upgrade to Starter to use your own name, colours and font.</p>}
      <form onSubmit={(e: { preventDefault(): void }) => (e.preventDefault(), void st.save('settings/branding', b, 'Saved. Your storefront now uses this look.'))}>
        <fieldset disabled={locked || st.busy}>
          <label htmlFor="b-name">Name on your storefront</label>
          <input id="b-name" value={b.displayName} onChange={(e: { target: HTMLInputElement }) => setB({ ...b, displayName: e.target.value })} aria-invalid={!!fe.displayName} />
          {fe.displayName && <span className="field-error">{fe.displayName}</span>}
          <div className="settings-pair">
            {(['primaryHex', 'secondaryHex'] as const).map((k) => (
              <div key={k}>
                <label htmlFor={`b-${k}`}>{k === 'primaryHex' ? 'Main colour' : 'Dark colour'}</label>
                <span className="swatch-row">
                  <input type="color" aria-label={`${k === 'primaryHex' ? 'Main' : 'Dark'} colour picker`} value={/^#[0-9a-f]{6}$/i.test(b[k]) ? b[k] : '#000000'} onChange={(e: { target: HTMLInputElement }) => setB({ ...b, [k]: e.target.value.toUpperCase() })} />
                  <input id={`b-${k}`} value={b[k]} onChange={(e: { target: HTMLInputElement }) => setB({ ...b, [k]: e.target.value })} aria-invalid={!!fe[k]} />
                </span>
                {fe[k] && <span className="field-error">{fe[k]}</span>}
              </div>
            ))}
          </div>
          <label htmlFor="b-font">Headline font</label>
          <select id="b-font" value={b.fontFamily} onChange={(e: { target: HTMLSelectElement }) => setB({ ...b, fontFamily: e.target.value })}>
            {s.fonts.map((f) => <option key={f}>{f}</option>)}
          </select>
          <p className="brand-preview" style={{ '--p': b.primaryHex, fontFamily: `"${b.fontFamily}", system-ui` } as React.CSSProperties}>
            {b.displayName || 'Your name'}
          </p>
          <button type="submit" className="btn-brand">{st.busy ? 'Saving…' : 'Save look'}</button>
        </fieldset>
      </form>
      <Status ok={st.ok} err={st.err && !st.err.errors ? st.err : null} />
    </section>
  );
}

function GateForm({ api, s, onSaved }: { api: AdminClient; s: SettingsDto; onSaved: () => void }) {
  const [g, setG] = useState(s.gate);
  const st = useSave(api, onSaved);
  const fe = st.err?.errors ?? {};
  const modes = [
    ['off', 'Off', 'Prospects see every product without giving an email.'],
    ['soft', 'Ask', 'After the free products, prospects are asked for an email but can skip.'],
    ['hard', 'Require', 'After the free products, an email is required to see more.'],
  ] as const;
  return (
    <section className="settings-section">
      <h2 className="admin-h2">Email gate</h2>
      <form onSubmit={(e: { preventDefault(): void }) => (e.preventDefault(), void st.save('settings/gate', { ...g, freeProducts: Number(g.freeProducts) }, 'Saved. The gate change is live.'))}>
        <fieldset disabled={st.busy}>
          <legend className="sr-only">When to ask for an email</legend>
          {modes.map(([k, label, help]) => (
            <label key={k} className="radio">
              <input type="radio" name="gate-mode" value={k} checked={g.mode === k} onChange={() => setG({ ...g, mode: k })} />
              <span><strong>{label}</strong> <span className="fine-inline">{help}</span></span>
            </label>
          ))}
          <label htmlFor="g-free">Free products before asking</label>
          <input id="g-free" type="number" min={0} max={20} inputMode="numeric" value={g.freeProducts} onChange={(e: { target: HTMLInputElement }) => setG({ ...g, freeProducts: Number(e.target.value) })} aria-invalid={!!fe.freeProducts} disabled={g.mode === 'off'} />
          {fe.freeProducts && <span className="field-error">{fe.freeProducts}</span>}
          <label htmlFor="g-contact">Who follows up <span className="optional">optional</span></label>
          <input id="g-contact" placeholder="e.g. Jordan at Demo Promo Co." value={g.contactName} onChange={(e: { target: HTMLInputElement }) => setG({ ...g, contactName: e.target.value })} aria-invalid={!!fe.contactName} />
          <p className="fine">Shown to prospects after they give their email.</p>
          <button type="submit" className="btn-brand">{st.busy ? 'Saving…' : 'Save gate'}</button>
        </fieldset>
      </form>
      <Status ok={st.ok} err={st.err && !st.err.errors ? st.err : null} />
    </section>
  );
}

interface FeatureDto {
  key: string;
  label: string;
  help: string;
  on: boolean;
  available: boolean;
  blockedBy: 'plan' | 'platform' | null;
  plan: string;
}

/** Storefront feature switches (ADR 0013). Owners edit; admins see the state. */
function FeaturesForm({ api, onSaved }: { api: AdminClient; onSaved: () => void }) {
  const [dto, setDto] = useState<{ canEdit: boolean; features: FeatureDto[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const load = useCallback(
    () =>
      void api.get<{ canEdit: boolean; features: FeatureDto[] }>('features').then((d) => {
        setDto(d);
        setDraft(Object.fromEntries(d.features.map((f) => [f.key, f.on])));
      }),
    [api],
  );
  useEffect(load, [load]);
  const st = useSave(api, () => (load(), onSaved()));
  if (!dto) return null;
  const changed = Object.fromEntries(dto.features.filter((f) => f.available && draft[f.key] !== f.on).map((f) => [f.key, draft[f.key]!]));
  const dirty = Object.keys(changed).length > 0;
  return (
    <section className="settings-section">
      <h2 className="admin-h2">Storefront features</h2>
      <p className="fine">Switch off anything you don't want prospects to see. Changes are live as soon as you save.</p>
      {!dto.canEdit && <p className="note">Only the account owner can change these.</p>}
      <form onSubmit={(e: { preventDefault(): void }) => (e.preventDefault(), void st.save('features', { features: changed }, 'Saved. Your storefront is updated.'))}>
        <fieldset disabled={!dto.canEdit || st.busy}>
          <legend className="sr-only">Storefront features</legend>
          {dto.features.map((f) => (
            <label key={f.key} className="check">
              <input
                type="checkbox"
                name={`feature-${f.key}`}
                checked={f.available ? !!draft[f.key] : false}
                disabled={!f.available}
                onChange={(e: { target: HTMLInputElement }) => setDraft({ ...draft, [f.key]: e.target.checked })}
              />
              <span>
                <strong>{f.label}</strong> <span className="fine-inline">{f.help}</span>
                {f.blockedBy === 'plan' && <span className="fine-inline feature-locked"> Available on the {f.plan} plan.</span>}
                {f.blockedBy === 'platform' && <span className="fine-inline feature-locked"> Temporarily unavailable for all sites.</span>}
              </span>
            </label>
          ))}
          {dto.canEdit && (
            <button type="submit" className="btn-brand" disabled={!dirty || st.busy}>
              {st.busy ? 'Saving…' : 'Save features'}
            </button>
          )}
        </fieldset>
      </form>
      <Status ok={st.ok} err={st.err} />
    </section>
  );
}

function RoutingForm({ api, s, me, onSaved }: { api: AdminClient; s: SettingsDto; me: Me; onSaved: () => void }) {
  const [provider, setProvider] = useState<'mock' | 'webhook'>(s.routing.provider);
  const [url, setUrl] = useState(s.routing.provider === 'webhook' ? s.routing.url : '');
  const [rotate, setRotate] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [test, setTest] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({ busy: false, msg: null, ok: false });
  const st = useSave(api, onSaved);
  const canWebhook = s.can.webhookRouting;
  const editable = s.isOwner;

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    setSecret(null);
    const r = await st.save<{ secret?: string }>('settings/routing', provider === 'webhook' ? { provider, url, rotateSecret: rotate } : { provider }, 'Saved.');
    if (r?.secret) setSecret(r.secret);
    setRotate(false);
  }
  async function sendTest() {
    setTest({ busy: true, msg: null, ok: false });
    try {
      const r = await api.post<{ ok: boolean; error?: string }>('settings/routing/test');
      setTest({ busy: false, ok: r.ok, msg: r.ok ? 'Test delivered. Your endpoint answered with a success status.' : `Test failed: ${r.error}` });
    } catch (x) {
      setTest({ busy: false, ok: false, msg: isApiError(x) ? x.message : 'Test failed.' });
    }
  }

  return (
    <section className="settings-section">
      <h2 className="admin-h2">Where leads go</h2>
      {!editable && <p className="note">Only the account owner can change this.</p>}
      <form onSubmit={save}>
        <fieldset disabled={!editable || st.busy}>
          <legend className="sr-only">Lead destination</legend>
          <label className="radio">
            <input type="radio" name="routing" checked={provider === 'mock'} onChange={() => setProvider('mock')} />
            <span><strong>This inbox only</strong> <span className="fine-inline">Leads are kept here. Export them as CSV any time.</span></span>
          </label>
          <label className="radio">
            <input type="radio" name="routing" checked={provider === 'webhook'} onChange={() => setProvider('webhook')} disabled={!canWebhook} />
            <span>
              <strong>This inbox and my CRM</strong>{' '}
              <span className="fine-inline">
                {canWebhook ? 'Each lead is also sent to your CRM, Zapier or Make through a signed webhook.' : 'Available on the Pro plan.'}
              </span>
            </span>
          </label>
          {provider === 'webhook' && (
            <>
              <label htmlFor="r-url">Webhook URL</label>
              <input id="r-url" type="url" inputMode="url" placeholder="https://hooks.zapier.com/…" value={url} onChange={(e: { target: HTMLInputElement }) => setUrl(e.target.value)} aria-invalid={!!st.err?.errors?.url} />
              {st.err?.errors?.url && <span className="field-error">{st.err.errors.url}</span>}
              {s.routing.provider === 'webhook' && (
                <label className="check">
                  <input type="checkbox" checked={rotate} onChange={(e: { target: HTMLInputElement }) => setRotate(e.target.checked)} />
                  Replace the signing secret (the old one stops working immediately)
                </label>
              )}
            </>
          )}
          <button type="submit" className="btn-brand">{st.busy ? 'Saving…' : 'Save destination'}</button>
        </fieldset>
      </form>
      <Status ok={st.ok} err={st.err && !st.err.errors ? st.err : null} />
      {secret && (
        <div className="secret-once" role="status">
          <p><strong>Copy your signing secret now.</strong> It won't be shown again. Add it to your receiver to verify that requests come from us.</p>
          <input readOnly value={secret} aria-label="Signing secret" onFocus={(e: { currentTarget: HTMLInputElement }) => e.currentTarget.select()} />
        </div>
      )}
      {editable && canWebhook && s.routing.provider === 'webhook' && (
        <p className="routing-test">
          <button type="button" className="btn-outline" onClick={sendTest} disabled={test.busy}>{test.busy ? 'Sending…' : 'Send a test'}</button>
          {test.msg && <span className={test.ok ? 'saved' : 'error'} role="status">{test.msg}</span>}
        </p>
      )}
      {me.routing === 'inbox' && s.routing.provider === 'webhook' && !canWebhook && (
        <p className="note">Your saved webhook is paused because your plan no longer includes CRM delivery. Leads are kept in this inbox.</p>
      )}
    </section>
  );
}
