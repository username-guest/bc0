/**
 * Supplier catalog syncs (ADR 0017), for deployments with SUPPLIER_WORKER=off:
 *   npm run jobs:suppliers            one pass: queued syncs + the daily refresh (cron / scheduler)
 *   npm run jobs:suppliers -- --watch a dedicated worker: a pass every SUPPLIER_WORKER_INTERVAL_MS
 * Several can run at once: each connection is claimed with a lock (its status), and a lock older
 * than 30 minutes (a crashed worker) can be taken over. One-pass mode exits 1 if a tenant errored.
 */
import { getRuntime } from '@/server/runtime';
import { getEnv } from '@/core/config/env';
import { runSupplierSyncs } from '@/server/suppliers/service';

const rt = await getRuntime({ worker: false });
const deps = { directory: rt.directory, service: rt.suppliers };

if (process.argv.includes('--watch')) {
  const every = getEnv().SUPPLIER_WORKER_INTERVAL_MS;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));
  while (!stop) {
    const r = await runSupplierSyncs(deps);
    if (r.runs || r.errors.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
    await new Promise((res) => setTimeout(res, every));
  }
  process.exit(0);
} else {
  const r = await runSupplierSyncs(deps);
  console.log(JSON.stringify(r));
  process.exit(r.errors.length ? 1 : 0);
}
