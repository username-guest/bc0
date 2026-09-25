/** Browser entry for the e2e harness: the real storefront components, mounted client-side. */
import { createRoot } from 'react-dom/client';
import { TenantShell } from '@/ui/TenantShell';
import { Studio } from '@/ui/Studio';
import type { PublicConfig } from '@/ui/flags';

const cfg = (window as unknown as { __BC_CONFIG__: PublicConfig }).__BC_CONFIG__;
createRoot(document.getElementById('root')!).render(
  <TenantShell config={cfg}>
    <Studio apiBase={`/api/t/${encodeURIComponent(cfg.ref)}`} />
  </TenantShell>,
);
