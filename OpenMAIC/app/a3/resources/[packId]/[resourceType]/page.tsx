import { ResourceStandaloneView } from '@/components/a3/features/resource-standalone-view';

export default async function A3ResourceStandalonePage({ params }: { params: Promise<{ packId: string; resourceType: string }> }) {
  const { packId, resourceType } = await params;
  return <ResourceStandaloneView packId={packId} resourceType={resourceType} />;
}
