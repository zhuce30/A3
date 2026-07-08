import { A3AuthGate } from '@/components/a3/auth/a3-auth-gate';
import { A3Shell } from '@/components/a3/layout/a3-shell';

export default function A3Layout({ children }: { children: React.ReactNode }) {
  return (
    <A3AuthGate>
      <A3Shell>{children}</A3Shell>
    </A3AuthGate>
  );
}
