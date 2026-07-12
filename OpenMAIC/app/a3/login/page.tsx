import { LoginPage } from '@/components/a3/auth/a3-auth-pages';
import { normalizeA3ReturnPath } from '@/lib/a3/auth-navigation';

type LoginSearchParams = Promise<{
  mode?: string;
  next?: string;
}>;

export default async function A3LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
  const { mode, next } = await searchParams;
  const reviewMode = mode === 'review';
  const returnTo = normalizeA3ReturnPath(next);

  return <LoginPage reviewMode={reviewMode} returnTo={returnTo} />;
}
