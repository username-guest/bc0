/** Browser entry for the admin e2e harness: the real admin components in the real shell. */
import { createRoot } from 'react-dom/client';
import { TenantShell } from '@/ui/TenantShell';
import { AdminApp } from '@/ui/admin/AdminApp';
import { AdminVerify } from '@/ui/admin/AdminVerify';
import type { PublicConfig } from '@/ui/flags';

const cfg = (window as unknown as { __BC_CONFIG__: PublicConfig }).__BC_CONFIG__;
const apiBase = `/api/t/${encodeURIComponent(cfg.ref)}`;
createRoot(document.getElementById('root')!).render(
  <TenantShell config={cfg} section="Admin">
    {/\/verify\/?$/.test(window.location.pathname) ? <AdminVerify apiBase={apiBase} /> : <AdminApp apiBase={apiBase} />}
  </TenantShell>,
);
