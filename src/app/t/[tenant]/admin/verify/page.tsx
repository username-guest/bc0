import { AdminVerify } from '@/ui/admin/AdminVerify';

type Props = { params: Promise<{ tenant: string }> };

export default async function AdminVerifyPage({ params }: Props) {
  const { tenant } = await params;
  return <AdminVerify apiBase={`/api/t/${encodeURIComponent(decodeURIComponent(tenant))}`} />;
}
