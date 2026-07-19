import { A3AuthGate } from '@/components/a3/auth/a3-auth-gate';
import { A3Shell } from '@/components/a3/layout/a3-shell';
import { A3GuidedTourProvider } from '@/components/a3/guided-tour/guided-tour-provider';

export default function A3Layout({ children }: { children: React.ReactNode }) {
  return (
    <A3AuthGate>
      <A3GuidedTourProvider>
        <A3Shell>{children}</A3Shell>
      </A3GuidedTourProvider>
    </A3AuthGate>
  );
}
