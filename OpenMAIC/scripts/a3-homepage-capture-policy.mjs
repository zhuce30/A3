const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_PATH = '/api/auth/login/';
const ALLOWED_INTERNAL_WRITE_PATHS = new Set(['/__nextjs_original-stack-frames']);

export function classifyCaptureRequest(method, url, { captureOrigin, loginOrigin } = {}) {
  const normalizedMethod = String(method).toUpperCase();
  if (READ_METHODS.has(normalizedMethod)) {
    return { action: 'continue', reason: 'read' };
  }

  if (normalizedMethod !== 'POST') {
    return { action: 'abort', reason: 'forbidden-write' };
  }

  const requestUrl = new URL(url);
  const pathname = requestUrl.pathname;
  const normalizedCaptureOrigin = captureOrigin ? new URL(captureOrigin).origin : '';
  const normalizedLoginOrigin = loginOrigin ? new URL(loginOrigin).origin : '';
  if (pathname === LOGIN_PATH && requestUrl.origin === normalizedLoginOrigin) {
    return { action: 'continue', reason: 'login' };
  }
  if (ALLOWED_INTERNAL_WRITE_PATHS.has(pathname) && requestUrl.origin === normalizedCaptureOrigin) {
    return { action: 'continue', reason: 'internal' };
  }
  return { action: 'abort', reason: 'forbidden-write' };
}

export async function installCaptureRequestPolicy(
  context,
  { captureOrigin, loginOrigin, onBlockedWrite },
) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const policy = classifyCaptureRequest(request.method(), request.url(), {
      captureOrigin,
      loginOrigin,
    });
    if (policy.action === 'abort') {
      onBlockedWrite({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
