'use client';
/**
 * Analytics tab (ADR 0014): funnel totals, a daily chart and results per tracked link, plus link
 * management. The server enforces plan gating, validation and CSRF; this UI mirrors it.
 */
import { useCallback, useEffect, useState } from 'react';
import { isApiError, type AdminClient, type ApiError } from './client';

type Channel = 'email' | 'print' | 'social' | 'event' | 'other';
interface Link {
  id: string;
  code: string;
  label: string;
  channel: Channel;
  archived: boolean;
  createdAt: string;
  url: string;
}
interface LinksDto {
  links: Link[];
  canCreate: boolean;
  upgradeable: boolean;
  maxActive: number;
}
type Stages = { visit: number; proof: number; lead: number };
interface Summary {
  range: { from: string; to: string; days: number };
  totals: Stages;
  byDay: ({ day: string } & Stages)[];
  byLink: ({ linkId: string | null; code: string | null; label: string; channel: Channel | null; archived: boolean } & Stages)[];
}

const CHANNEL: Record<Channel, string> = {
  email: 'Email',
  print: 'Print / QR code',
  social: 'Social media',
  event: 'Event / trade show',
  other: 'Other',
};
const RANGES = [7, 30, 90, 365] as const;
const asError = (e: unknown): ApiError => (isApiError(e) ? e : { status: 0, code: 'unknown', message: 'Something went wrong. Try again.' });
const fieldsOf = (e: unknown): Record<string, string> => (isApiError(e) ? ((e as ApiError & { fields?: Record<string, string> }).fields ?? {}) : {});
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '–');
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function AnalyticsPanel({ api, dashboard }: { api: AdminClient; dashboard: { can: boolean; upgradeable: boolean } }) {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryErr, setSummaryErr] = useState<ApiError | null>(null);
  const [links, setLinks] = useState<LinksDto | null>(null);
  const [linksErr, setLinksErr] = useState<ApiError | null>(null);

  const loadSummary = useCallback(
    (d: number) =>
      api
        .get<{ summary: Summary }>(`analytics?days=${d}`)
        .then((r) => (setSummary(r.summary), setSummaryErr(null)))
        .catch((e) => (setSummary(null), setSummaryErr(asError(e)))),
    [api],
  );
  const loadLinks = useCallback(
    () =>
      api
        .get<LinksDto>('links')
        .then((r) => (setLinks(r), setLinksErr(null)))
        .catch((e) => setLinksErr(asError(e))),
    [api],
  );
  // Don't ask for a dashboard the plan doesn't include; the server would refuse it anyway.
  useEffect(() => void (dashboard.can && loadSummary(days)), [loadSummary, days, dashboard.can]);
  useEffect(() => void loadLinks(), [loadLinks]);
  const refresh = () => Promise.all([loadLinks(), dashboard.can ? loadSummary(days) : null]);

  return (
    <div className="settings analytics">
      <section className="settings-section" aria-labelledby="an-h">
        <div className="an-head">
          <h2 className="admin-h2" id="an-h">How prospects find you</h2>
          {dashboard.can && <label className="an-range">
            <span>Period</span>
            <select value={days} onChange={(e: { target: HTMLSelectElement }) => setDays(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r} value={r}>
                  {r === 365 ? 'Last 12 months' : `Last ${r} days`}
                </option>
              ))}
            </select>
          </label>}
        </div>
        {!dashboard.can ? (
          <p className="note">
            {dashboard.upgradeable
              ? 'The analytics dashboard is available on the Pro plan. Visits are already being counted, so your history will be here when you upgrade.'
              : 'The analytics dashboard is turned off for this workspace.'}
          </p>
        ) : summaryErr ? (
          <p className="error" role="alert">{summaryErr.message}</p>
        ) : !summary ? (
          <p className="fine">Loading…</p>
        ) : (
          <Overview s={summary} />
        )}
      </section>

      {summary && summary.byLink.length > 0 && (
        <section className="settings-section" aria-labelledby="an-links-h">
          <h2 className="admin-h2" id="an-links-h">Results by link</h2>
          <div className="table-scroll">
            <table className="an-table">
              <thead>
                <tr>
                  <th scope="col">Link</th>
                  <th scope="col">Visitors</th>
                  <th scope="col">Saw a proof</th>
                  <th scope="col">Leads</th>
                  <th scope="col">Lead rate</th>
                </tr>
              </thead>
              <tbody>
                {summary.byLink.map((r) => (
                  <tr key={r.linkId ?? 'direct'}>
                    <th scope="row">
                      {r.label}
                      {r.archived && <span className="tag">Archived</span>}
                      {r.channel && <span className="fine an-channel">{CHANNEL[r.channel]}</span>}
                    </th>
                    <td>{r.visit}</td>
                    <td>{r.proof}</td>
                    <td>{r.lead}</td>
                    <td>{pct(r.lead, r.visit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <LinksSection api={api} links={links} err={linksErr} onChanged={refresh} />
    </div>
  );
}

function Overview({ s }: { s: Summary }) {
  const { visit, proof, lead } = s.totals;
  const max = Math.max(1, ...s.byDay.map((d) => d.visit));
  const W = 600;
  const H = 120;
  const n = s.byDay.length;
  const bw = W / n;
  const label = `${visit} visitors, ${proof} saw a proof, ${lead} became leads, ${shortDay(s.range.from)} to ${shortDay(s.range.to)}.`;
  return (
    <>
      <dl className="an-totals">
        <div>
          <dt>Visitors</dt>
          <dd>{visit}</dd>
        </div>
        <div>
          <dt>Saw a proof</dt>
          <dd>
            {proof} <span className="fine-inline">{pct(proof, visit)}</span>
          </dd>
        </div>
        <div>
          <dt>Became leads</dt>
          <dd>
            {lead} <span className="fine-inline">{pct(lead, visit)}</span>
          </dd>
        </div>
      </dl>
      <figure className="an-chart">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Visitors per day. ${label}`}>
          {s.byDay.map((d, i) => {
            const h = (d.visit / max) * (H - 4);
            return (
              <g key={d.day}>
                <rect x={i * bw + bw * 0.12} y={H - h} width={Math.max(1, bw * 0.76)} height={h} className="an-bar">
                  <title>{`${shortDay(d.day)}: ${d.visit} visitors, ${d.lead} leads`}</title>
                </rect>
                {d.lead > 0 && <rect x={i * bw + bw * 0.12} y={H - 3} width={Math.max(1, bw * 0.76)} height={3} className="an-lead" />}
              </g>
            );
          })}
        </svg>
        <figcaption className="fine an-axis">
          <span>{shortDay(s.range.from)}</span>
          <span>Visitors per day (days with a lead are marked) · UTC</span>
          <span>{shortDay(s.range.to)}</span>
        </figcaption>
      </figure>
      <p className="fine">Each visitor counts once per day. A visitor comes from a link when they first arrived through it.</p>
    </>
  );
}

function LinksSection({ api, links, err, onChanged }: { api: AdminClient; links: LinksDto | null; err: ApiError | null; onChanged: () => Promise<unknown> }) {
  const [label, setLabel] = useState('');
  const [channel, setChannel] = useState<Channel>('email');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string; at: string } | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (err) return <p className="error" role="alert">{err.message}</p>;
  if (!links) return null;

  async function run(key: string, action: () => Promise<string | void>) {
    setBusy(key);
    setMsg(null);
    setFieldErr({});
    let result: { ok?: string; err?: string; at: string } | null = null;
    try {
      const ok = await action();
      if (ok) result = { ok, at: key };
    } catch (e) {
      setFieldErr(fieldsOf(e));
      result = { err: asError(e).message, at: key };
    }
    await onChanged();
    setBusy(null);
    if (result) setMsg(result);
  }

  const create = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void run('create', async () => {
      const r = await api.post<{ link: Link }>('links', { label, channel });
      setLabel('');
      return `Created “${r.link.label}”. Copy its link below.`;
    });
  };
  const copy = async (l: Link) => {
    try {
      await navigator.clipboard.writeText(l.url);
      setMsg({ ok: `Copied the link for “${l.label}”.`, at: l.id });
    } catch {
      setMsg({ err: 'Your browser blocked copying. Select the link and copy it yourself.', at: l.id });
    }
  };

  const active = links.links.filter((l) => !l.archived);
  const archived = links.links.filter((l) => l.archived);
  const shown = showArchived ? links.links : active;
  const full = active.length >= links.maxActive;

  return (
    <section className="settings-section" aria-labelledby="an-manage-h">
      <h2 className="admin-h2" id="an-manage-h">Tracked links</h2>
      <p className="fine">Give each place you share your storefront its own link: a salesperson’s emails, a trade-show QR code, a social post. Visitors who arrive through it are credited to it.</p>

      {links.canCreate ? (
        <form onSubmit={create} className="an-create">
          <fieldset disabled={busy !== null || full}>
            <label htmlFor="l-label">Name</label>
            <input id="l-label" required maxLength={80} placeholder="e.g. Spring trade show" value={label} aria-invalid={fieldErr.label ? true : undefined} aria-describedby={fieldErr.label ? 'l-label-err' : undefined} onChange={(e: { target: HTMLInputElement }) => setLabel(e.target.value)} />
            {fieldErr.label && <p className="error" id="l-label-err">{fieldErr.label}</p>}
            <label htmlFor="l-channel">Where you’ll share it</label>
            <select id="l-channel" value={channel} onChange={(e: { target: HTMLSelectElement }) => setChannel(e.target.value as Channel)}>
              {(Object.keys(CHANNEL) as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL[c]}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-brand">{busy === 'create' ? 'Creating…' : 'Create link'}</button>
          </fieldset>
          {full && <p className="fine">You have {links.maxActive} active links, the most allowed. Archive one to make another.</p>}
          {msg?.at === 'create' && msg.ok && <p className="saved" role="status">{msg.ok}</p>}
          {msg?.at === 'create' && msg.err && <p className="error" role="alert">{msg.err}</p>}
        </form>
      ) : (
        <p className="note">
          {links.upgradeable ? 'Tracked links are available on the Pro plan.' : 'Tracked links are turned off for this workspace.'}
          {active.length > 0 ? ' Existing links keep working until you archive them.' : ''}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="an-link-list">
          {shown.map((l) => (
            <li key={l.id} className="an-link" aria-busy={busy === l.id || undefined}>
              <div className="an-link-who">
                <span className="team-email">{l.label}</span>
                {l.archived && <span className="tag">Archived</span>}
                <span className="fine an-channel">{CHANNEL[l.channel]}</span>
              </div>
              {!l.archived && (
                <div className="an-url">
                  <label className="sr-only" htmlFor={`url-${l.id}`}>Link for {l.label}</label>
                  <input id={`url-${l.id}`} readOnly value={l.url} onFocus={(e: { target: HTMLInputElement }) => e.target.select()} />
                  <button type="button" className="btn-quiet" onClick={() => void copy(l)}>Copy</button>
                </div>
              )}
              {renaming?.id === l.id ? (
                <form
                  className="an-rename"
                  onSubmit={(e: { preventDefault(): void }) => {
                    e.preventDefault();
                    void run(l.id, async () => {
                      await api.put(`links/${l.id}`, { label: renaming.label });
                      setRenaming(null);
                      return 'Renamed.';
                    });
                  }}
                >
                  <label className="sr-only" htmlFor={`rn-${l.id}`}>New name for {l.label}</label>
                  <input id={`rn-${l.id}`} required maxLength={80} value={renaming.label} onChange={(e: { target: HTMLInputElement }) => setRenaming({ id: l.id, label: e.target.value })} />
                  <button type="submit" className="btn-quiet" disabled={busy !== null}>Save</button>
                  <button type="button" className="btn-quiet" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <div className="team-actions">
                  {links.canCreate && !l.archived && (
                    <button type="button" className="btn-quiet" disabled={busy !== null} onClick={() => setRenaming({ id: l.id, label: l.label })}>Rename</button>
                  )}
                  {l.archived ? (
                    links.canCreate && (
                      <button type="button" className="btn-quiet" disabled={busy !== null || full} onClick={() => void run(l.id, async () => (await api.put(`links/${l.id}`, { archived: false }), `Restored “${l.label}”. Its link works again.`))}>
                        Restore
                      </button>
                    )
                  ) : (
                    <button type="button" className="btn-quiet btn-danger-quiet" disabled={busy !== null} onClick={() => void run(l.id, async () => (await api.put(`links/${l.id}`, { archived: true }), `Archived “${l.label}”. New visitors through it now count as direct; its results stay.`))}>
                      Archive
                    </button>
                  )}
                </div>
              )}
              {msg?.at === l.id && msg.ok && <p className="saved" role="status">{msg.ok}</p>}
              {msg?.at === l.id && msg.err && <p className="error" role="alert">{msg.err}</p>}
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <button type="button" className="btn-quiet" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived links' : `Show ${archived.length} archived`}
        </button>
      )}
    </section>
  );
}
