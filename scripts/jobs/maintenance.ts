/**
 * One maintenance pass, for cron / a scheduler (DELIVERY_WORKER=off, or several instances):
 *   npm run jobs:maintenance
 * Exit code 1 if any part errored, so the scheduler can alert.
 */
import { getRuntime } from '@/server/runtime';
import { runMaintenance } from '@/server/jobs/maintenance';

const rt = await getRuntime({ worker: false });
const r = await runMaintenance(rt.maintenance);
console.log(JSON.stringify(r));
process.exit(r.errors.length ? 1 : 0);
