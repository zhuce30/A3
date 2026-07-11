const blockedReturnPaths = new Set([
  '/a3',
  '/a3/login',
  '/a3/register',
  '/a3/forgot-password',
]);

const returnPathBase = 'https://a3.local';

export function normalizeA3ReturnPath(value?: string | null): string | null {
  if (
    !value ||
    value !== value.trim() ||
    !value.startsWith('/a3/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, returnPathBase);
  } catch {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (
    parsed.origin !== returnPathBase ||
    !pathname.startsWith('/a3/') ||
    blockedReturnPaths.has(pathname)
  ) {
    return null;
  }

  return value;
}
