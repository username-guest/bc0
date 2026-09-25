/**
 * Run background work once the response has gone (ADR 0018). On Vercel, Next's `after()` keeps
 * the function alive for it; outside a request (scripts, tests) it just runs in the background.
 */
import { after } from 'next/server';

export function afterResponse(task: () => Promise<unknown>, label: string, log: (m: string) => void = (m) => console.warn(m)): void {
  const safe = () => task().catch((e: unknown) => log(`${label}: ${(e as Error).message.slice(0, 200)}`));
  try {
    after(safe);
  } catch {
    void safe();
  }
}
