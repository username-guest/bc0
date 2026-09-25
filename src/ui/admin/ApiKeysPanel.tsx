'use client';
/**
 * API keys (ADR 0016), in Settings, for owners. The full key is shown once, right after creating
 * it; after that only its first characters. The server enforces owner-only, plan, CSRF and caps.
 */
import { useCallback, useEffect, useState } from 'react';
import { isApiError, type AdminClient, type ApiError } from './client';

type Scope = 'leads:read' | 'catalog:read' | 'analytics:read';
interface Key {
  id: string;
  name: string;
  hint: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}
interface KeysDto {
  keys: Key[];
  canCreate: boolean;
  upgradeable: boolean;
  maxActive: number;
  baseUrl: string;
}

const SCOPE: Record<Scope, string> = {
  'leads:read': 'Leads and their history',
  'catalog:read': 'Products and estimated prices',
  'analytics:read': 'Visitor and lead analytics',
};
const asError = (e: unknown): ApiError => (isApiError(e) ? e : { status: 0, code: 'unknown', message: 'Something went wrong. Try again.' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function ApiKeysPanel({ api }: { api: AdminClient }) {
  const [dto, setDto] = useState<KeysDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['leads:read']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string } | null>(null);
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api
        .get<KeysDto>('api-keys')
        .then((d) => (setDto(d), setErr(null)))
        .catch((e) => setErr(asError(e).message)),
    [api],
  );
  useEffect(() => void reload(), [reload]);

  if (err) return <section className="settings-section"><h2 className="admin-h2">API keys</h2><p className="error" role="alert">{err}</p></section>;
  if (!dto) return null;

  const active = dto.keys.filter((k) => !k.revoked);
  const full = active.length >= dto.maxActive;

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

  const create = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ key: Key; secret: string }>('api-keys', { name, scopes });
      setFresh({ name: r.key.name, secret: r.secret });
      setName('');
      return `Created “${r.key.name}”.`;
    });
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
      setMsg({ err: 'Your browser blocked copying. Select the text and copy it yourself.' });
    }
  };

  return (
    <section className="settings-section api-keys" aria-labelledby="keys-h">
      <h2 className="admin-h2" id="keys-h">API keys</h2>
      <p className="fine">
        Let your own systems read leads, products and analytics. Keys are for servers only: never put one in a web page or an app.
        The API lives at <code className="api-base">{dto.baseUrl}</code>.
      </p>

      {fresh && (
        <div className="secret-once" role="status">
          <p>
            <strong>Copy the key for “{fresh.name}” now.</strong> For your security it won’t be shown again. If you lose it, revoke it and create a new one.
          </p>
          <div className="an-url">
            <label className="sr-only" htmlFor="fresh-key">New API key</label>
            <input id="fresh-key" readOnly value={fresh.secret} onFocus={(e: { target: HTMLInputElement }) => e.target.select()} />
            <button type="button" className="btn-quiet" onClick={() => void copy(fresh.secret, 'fresh')}>{copied === 'fresh' ? 'Copied' : 'Copy'}</button>
          </div>
          <button type="button" className="btn-quiet" onClick={() => (setFresh(null), setCopied(null))}>I’ve saved it</button>
        </div>
      )}

      {dto.canCreate ? (
        <form onSubmit={create} className="an-create">
          <fieldset disabled={busy || full}>
            <label htmlFor="k-name">What will use it</label>
            <input id="k-name" required maxLength={80} placeholder="e.g. Salesforce sync" value={name} onChange={(e: { target: HTMLInputElement }) => setName(e.target.value)} />
            <fieldset className="team-roles">
              <legend className="fine-inline">It can read</legend>
              {(Object.keys(SCOPE) as Scope[]).map((s) => (
                <label key={s} className="radio">
                  <input
                    type="checkbox"
                    name="key-scope"
                    value={s}
                    checked={scopes.includes(s)}
                    onChange={(e: { target: HTMLInputElement }) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  />
                  <span>{SCOPE[s]}</span>
                </label>
              ))}
            </fieldset>
            <button type="submit" className="btn-brand" disabled={!scopes.length}>{busy ? 'Creating…' : 'Create key'}</button>
          </fieldset>
          {full && <p className="fine">You have {dto.maxActive} active keys, the most allowed. Revoke one to create another.</p>}
        </form>
      ) : (
        <p className="note">
          {dto.upgradeable ? 'API access is available on the Enterprise plan.' : 'API access is turned off for this workspace.'}
          {active.length ? ' Existing keys stop working until it is back on; you can still revoke them.' : ''}
        </p>
      )}
      {msg?.ok && <p className="saved" role="status">{msg.ok}</p>}
      {msg?.err && <p className="error" role="alert">{msg.err}</p>}

      {dto.keys.length > 0 && (
        <ul className="an-link-list">
          {dto.keys.map((k) => (
            <li key={k.id} className="an-link">
              <div className="an-link-who">
                <span className="team-email">{k.name}</span>
                {k.revoked && <span className="tag">Revoked</span>}
                <span className="fine an-channel">
                  <code>{k.hint}</code> · {k.scopes.map((s) => SCOPE[s]).join(', ')}
                </span>
                <span className="fine an-channel">
                  {k.revoked ? `Revoked ${day(k.revokedAt!)}` : k.lastUsedAt ? `Last used ${day(k.lastUsedAt)}` : 'Never used'} · created {day(k.createdAt)}
                </span>
              </div>
              {!k.revoked && confirming !== k.id && (
                <div className="team-actions">
                  <button type="button" className="btn-quiet btn-danger-quiet" disabled={busy} onClick={() => setConfirming(k.id)}>Revoke</button>
                </div>
              )}
              {confirming === k.id && (
                <div className="team-confirm" role="group" aria-label={`Confirm revoking ${k.name}`}>
                  <p>Revoke “{k.name}”? Anything using it stops working immediately.</p>
                  <button type="button" className="btn-danger" onClick={() => (setConfirming(null), void run(async () => (await api.post(`api-keys/${k.id}/revoke`), `Revoked “${k.name}”.`)))}>Revoke</button>
                  <button type="button" className="btn-quiet" onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
