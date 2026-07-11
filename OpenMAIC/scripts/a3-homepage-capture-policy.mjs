const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOGIN_PATH = '/api/auth/login/';
const ALLOWED_INTERNAL_WRITE_PATHS = new Set(['/__nextjs_original-stack-frames']);

export function classifyCaptureRequest(method, url, { allowedOrigin } = {}) {
  const normalizedMethod = String(method).toUpperCase();
  if (!WRITE_METHODS.has(normalizedMethod)) {
    return { action: 'continue', reason: 'read' };
  }

  const requestUrl = new URL(url);
  const normalizedAllowedOrigin = allowedOrigin ? new URL(allowedOrigin).origin : '';
  if (!normalizedAllowedOrigin || requestUrl.origin !== normalizedAllowedOrigin) {
    return { action: 'abort', reason: 'forbidden-write' };
  }

  const pathname = requestUrl.pathname;
  if (normalizedMethod === 'POST' && pathname === LOGIN_PATH) {
    return { action: 'continue', reason: 'login' };
  }
  if (normalizedMethod === 'POST' && ALLOWED_INTERNAL_WRITE_PATHS.has(pathname)) {
    return { action: 'continue', reason: 'internal' };
  }
  return { action: 'abort', reason: 'forbidden-write' };
}

export async function installCaptureRequestPolicy(context, { allowedOrigin, onBlockedWrite }) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const policy = classifyCaptureRequest(request.method(), request.url(), { allowedOrigin });
    if (policy.action === 'abort') {
      onBlockedWrite({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
