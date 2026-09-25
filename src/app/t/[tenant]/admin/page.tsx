import { AdminApp } from '@/ui/admin/AdminApp';

type Props = { params: Promise<{ tenant: string }> };

export default async function AdminHome({ params }: Props) {
  const { tenant } = await params;
  return <AdminApp apiBase={`/api/t/${encodeURIComponent(decodeURIComponent(tenant))}`} />;
}
