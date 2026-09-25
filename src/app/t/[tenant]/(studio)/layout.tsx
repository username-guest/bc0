/** Storefront: the white-label shell with a presentation-only flag snapshot (§6). */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicTenantConfig } from '@/server/tenancy/context';
import { TenantShell } from '@/ui/TenantShell';
import { ctxFor } from '@/server/tenancy/page-context';

type Props = { children: React.ReactNode; params: Promise<{ tenant: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ctx = await ctxFor((await params).tenant);
  return ctx ? { title: `${ctx.tenant.branding.displayName}: logo studio` } : {};
}

export default async function StudioLayout({ children, params }: Props) {
  const ctx = await ctxFor((await params).tenant);
  if (!ctx) notFound();
  return <TenantShell config={publicTenantConfig(ctx)}>{children}</TenantShell>;
}
