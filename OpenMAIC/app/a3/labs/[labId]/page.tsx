import { AlgorithmLabWorkbench } from '@/components/a3/features/algorithm-lab/algorithm-lab-workbench';

export default async function A3AlgorithmLabPage({
  params,
}: {
  params: Promise<{ labId: string }>;
}) {
  const { labId } = await params;
  return <AlgorithmLabWorkbench labId={labId} />;
}
