/**
 * Proof pre-rendering (ADR 0015), for deployments with PROOF_WORKER=off:
 *   npm run jobs:proofs            one pass over every tenant's due renders (cron / scheduler)
 *   npm run jobs:proofs -- --watch a dedicated worker process: a pass every PROOF_WORKER_INTERVAL_MS
 * Several can run at once: jobs are claimed with a lease (FOR UPDATE SKIP LOCKED).
 * One-pass mode exits 1 if any tenant errored, so the scheduler can alert.
 */
import { getRuntime } from '@/server/runtime';
import { getEnv } from '@/core/config/env';
import { runProofJobs } from '@/server/jobs/proofs';

const rt = await getRuntime({ worker: false });
const deps = { directory: rt.directory, queue: rt.api.proofQueue, budgetMs: 60_000 };

if (process.argv.includes('--watch')) {
  const every = getEnv().PROOF_WORKER_INTERVAL_MS;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));
  while (!stop) {
    const r = await runProofJobs(deps);
    if (r.claimed || r.errors.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
    // Straight on while there was work; otherwise wait for the next interval.
    if (!r.claimed) await new Promise((res) => setTimeout(res, every));
  }
  process.exit(0);
} else {
  const r = await runProofJobs(deps);
  console.log(JSON.stringify(r));
  process.exit(r.errors.length ? 1 : 0);
}
