'use client';
/**
 * Landing page for the emailed sign-in link. The token is in the URL fragment (never sent to
 * the server by the browser), and signing in takes a click, so email link-scanners that open the
 * page can't use up the link (ADR 0008).
 */
import { useEffect, useState } from 'react';
import { adminClient, isApiError } from './client';

export function AdminVerify({ apiBase }: { apiBase: string }) {
  // undefined = not read yet (server render / first paint); null = no token in the link.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [back, setBack] = useState('.');
  const [state, setState] = useState<'ready' | 'busy' | 'error'>('ready');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t);
    setBack(window.location.pathname.replace(/\/verify\/?$/, ''));
    // Drop the token from the address bar and history once it's in memory.
    if (t) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function go() {
    if (!token) return;
    setState('busy');
    try {
      const r = await adminClient(apiBase).post<{ redirect: string }>('verify', { token });
      window.location.assign(new URL(r.redirect).pathname);
    } catch (e) {
      setState('error');
      setMsg(isApiError(e) ? e.message : 'Could not sign in. Request a new link.');
    }
  }

  return (
    <main className="admin-narrow">
      <h1 className="admin-h1">Sign in</h1>
      {token === undefined ? null : !token ? (
        <p>This page needs the link from your sign-in email. <a href={back}>Request a new link</a>.</p>
      ) : state === 'error' ? (
        <>
          <p className="error" role="alert">{msg}</p>
          <p><a href={back}>Request a new link</a></p>
        </>
      ) : (
        <>
          <p>Continue to your admin. The link works once.</p>
          <button type="button" className="btn-brand" onClick={go} disabled={state === 'busy'}>
            {state === 'busy' ? 'Signing in…' : 'Sign in'}
          </button>
        </>
      )}
    </main>
  );
}
