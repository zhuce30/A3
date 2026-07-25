import { A3AuthGate } from '@/components/a3/auth/a3-auth-gate';
import { A3WorkspaceFrame } from '@/components/a3/layout/a3-workspace-frame';

export default function A3Layout({ children }: { children: React.ReactNode }) {
  return (
    <A3AuthGate>
      <A3WorkspaceFrame>{children}</A3WorkspaceFrame>
    </A3AuthGate>
  );
}
