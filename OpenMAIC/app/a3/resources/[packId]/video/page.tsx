import { ResourceVideoView } from '@/components/a3/features/resource-video-view';

export default async function A3ResourceVideoPage({ params }: { params: Promise<{ packId: string }> }) {
  const { packId } = await params;
  return <ResourceVideoView packId={packId} />;
}
