'use client';
/**
 * Loads a proof via fetch (not a bare <img>) so it can read the renderer's notes from the
 * `x-proof-notes` header and handle 409 needs_placement / 429 honestly instead of a broken image.
 */
import { useEffect, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; src: string }
  | { kind: 'placement'; message: string }
  | { kind: 'error'; message: string };

export function ProofImage({ url, alt, onNotes }: { url: string; alt: string; onNotes?: (notes: string[]) => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    let objectUrl: string | null = null;
    let retried = false;

    const load = async (): Promise<void> => {
      const r = await fetch(url, { signal: ac.signal });
      if (r.status === 429 && !retried) {
        retried = true;
        const wait = Math.min(10, Number(r.headers.get('retry-after') ?? '2')) * 1000;
        await new Promise((ok) => setTimeout(ok, wait));
        return load();
      }
      if (r.status === 409) {
        const b = (await r.json()) as { error?: { message?: string } };
        setState({ kind: 'placement', message: b.error?.message ?? 'This product needs manual logo placement.' });
        return;
      }
      if (!r.ok) {
        setState({ kind: 'error', message: 'Preview unavailable right now.' });
        return;
      }
      const raw = r.headers.get('x-proof-notes');
      if (raw && onNotes) {
        try {
          onNotes(JSON.parse(decodeURIComponent(raw)) as string[]);
        } catch {
          /* notes are advisory */
        }
      }
      objectUrl = URL.createObjectURL(await r.blob());
      setState({ kind: 'ready', src: objectUrl });
    };

    setState({ kind: 'loading' });
    load().catch((e: Error) => {
      if (e.name !== 'AbortError') setState({ kind: 'error', message: 'Preview unavailable right now.' });
    });
    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, onNotes]);

  if (state.kind === 'ready') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="proof-img" src={state.src} alt={alt} />;
  }
  if (state.kind === 'loading') return <p className="proof-empty" aria-label="Rendering preview">Rendering your preview…</p>;
  return <p className="proof-empty">{state.message}</p>;
}
