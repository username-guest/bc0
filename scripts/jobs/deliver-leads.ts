/**
 * One pass of CRM delivery retries, for cron / a scheduler (DELIVERY_WORKER=off):
 *   npm run jobs:deliveries
 * Exit code 1 if any tenant errored, so the scheduler can alert.
 */
import { getRuntime } from '@/server/runtime';
import { runDeliveryRetries } from '@/server/jobs/deliveries';

const rt = await getRuntime({ worker: false });
const r = await runDeliveryRetries({ directory: rt.directory, delivery: rt.api.delivery });
console.log(JSON.stringify(r));
process.exit(r.errors.length ? 1 : 0);
