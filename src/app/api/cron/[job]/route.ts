/**
 * Scheduled jobs for serverless hosting (ADR 0018): GET /api/cron/<job>, called by Vercel Cron
 * with the CRON_SECRET bearer token. Behaviour lives in handleCron (unit-tested).
 * Excluded from the tenant-routing middleware so it answers on any host.
 */
import { getEnv } from '@/core/config/env';
import { getRuntime } from '@/server/runtime';
import { handleCron } from '@/server/jobs/cron';
import { runDeliveryRetries } from '@/server/jobs/deliveries';
import { runProofJobs } from '@/server/jobs/proofs';
import { runMaintenance } from '@/server/jobs/maintenance';
import { runSupplierSyncs } from '@/server/suppliers/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Hobby allows up to 60 s. Proof rendering keeps a margin below it; a very large supplier sync
// can still run over, in which case its lock expires and the next run takes it over.
export const maxDuration = 60;

type Ctx = { params: Promise<{ job: string }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { job } = await params;
  return handleCron(req, job, getEnv().CRON_SECRET, async (j) => {
    const rt = await getRuntime({ worker: false });
    switch (j) {
      case 'deliveries':
        return runDeliveryRetries({ directory: rt.directory, delivery: rt.api.delivery });
      case 'proofs':
        return runProofJobs({ directory: rt.directory, queue: rt.api.proofQueue, budgetMs: 45_000 });
      case 'suppliers':
        return runSupplierSyncs({ directory: rt.directory, service: rt.suppliers });
      case 'maintenance':
        return runMaintenance(rt.maintenance);
    }
  });
}
