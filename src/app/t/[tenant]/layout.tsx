/**
 * Tenant root: 404 for unknown tenants (or a custom domain the tenant isn't entitled to).
 * The storefront (studio) and admin each wrap themselves in the white-label shell.
 */
import { notFound } from 'next/navigation';
import { ctxFor } from '@/server/tenancy/page-context';

type Props = { children: React.ReactNode; params: Promise<{ tenant: string }> };

export default async function TenantRoot({ children, params }: Props) {
  if (!(await ctxFor((await params).tenant))) notFound();
  return children;
}
