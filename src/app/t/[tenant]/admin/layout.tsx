/** Tenant admin (ADR 0008): same white-label shell, labelled Admin, never indexed. */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicTenantConfig } from '@/server/tenancy/context';
import { TenantShell } from '@/ui/TenantShell';
import { ctxFor } from '@/server/tenancy/page-context';

type Props = { children: React.ReactNode; params: Promise<{ tenant: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await ctxFor((await params).tenant);
  return { title: ctx ? `${ctx.tenant.branding.displayName}: admin` : 'Admin', robots: { index: false, follow: false } };
}

export default async function AdminLayout({ children, params }: Props) {
  const ctx = await ctxFor((await params).tenant);
  if (!ctx) notFound();
  return (
    <TenantShell config={publicTenantConfig(ctx)} section="Admin">
      {children}
    </TenantShell>
  );
}
