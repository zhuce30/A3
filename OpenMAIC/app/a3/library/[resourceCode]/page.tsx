import { SystemResourceDetailView } from '@/components/a3/features/system-resource-detail-view';

export default async function A3SystemResourceDetailPage({ params }: { params: Promise<{ resourceCode: string }> }) {
  const { resourceCode } = await params;
  return <SystemResourceDetailView resourceCode={resourceCode} />;
}
