import { VideoCompositionView } from '@/components/a3/features/video-composition-view';

export default async function A3VideoCompositionPage({ params }: { params: Promise<{ packId: string }> }) {
  const { packId } = await params;
  return <VideoCompositionView packId={packId} />;
}
