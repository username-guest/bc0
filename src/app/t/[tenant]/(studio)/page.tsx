import { Studio } from '@/ui/Studio';

type Props = { params: Promise<{ tenant: string }> };

export default async function TenantHome({ params }: Props) {
  const { tenant } = await params;
  return <Studio apiBase={`/api/t/${encodeURIComponent(decodeURIComponent(tenant))}`} />;
}
