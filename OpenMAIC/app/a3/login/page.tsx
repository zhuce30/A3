import { LoginPage } from '@/components/a3/auth/a3-auth-pages';
import { normalizeA3ReturnPath, normalizeA3WorkspaceRole } from '@/lib/a3/auth-navigation';

type LoginSearchParams = Promise<{
  mode?: string;
  next?: string;
  workspace?: string;
}>;

export default async function A3LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
  const { mode, next, workspace } = await searchParams;
  const reviewMode = mode === 'review';
  const returnTo = normalizeA3ReturnPath(next);
  const workspaceRole = normalizeA3WorkspaceRole(workspace);

  return <LoginPage reviewMode={reviewMode} returnTo={returnTo} workspace={workspaceRole} />;
}
