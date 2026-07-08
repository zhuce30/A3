import { ResourcePackDetailView } from '@/components/a3/features/resource-pack-detail-view';

export default async function A3ResourcePackDetailPage({ params }: { params: Promise<{ packId: string }> }) {
  const { packId } = await params;
  return <ResourcePackDetailView packId={packId} />;
}
