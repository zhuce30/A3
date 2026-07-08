import { CourseMaterialPreviewView } from '@/components/a3/features/course-material-preview-view';

export default async function A3CourseMaterialPreviewPage({ params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params;
  return <CourseMaterialPreviewView resourceId={resourceId} />;
}
