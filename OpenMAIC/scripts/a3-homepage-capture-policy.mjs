const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOGIN_PATH = '/api/auth/login/';
const ALLOWED_INTERNAL_WRITE_PATHS = new Set(['/__nextjs_original-stack-frames']);

export function classifyCaptureRequest(method, url) {
  const normalizedMethod = String(method).toUpperCase();
  if (!WRITE_METHODS.has(normalizedMethod)) {
    return { action: 'continue', reason: 'read' };
  }

  const pathname = new URL(url).pathname;
  if (normalizedMethod === 'POST' && pathname === LOGIN_PATH) {
    return { action: 'continue', reason: 'login' };
  }
  if (normalizedMethod === 'POST' && ALLOWED_INTERNAL_WRITE_PATHS.has(pathname)) {
    return { action: 'continue', reason: 'internal' };
  }
  return { action: 'abort', reason: 'forbidden-write' };
}

export async function installCaptureRequestPolicy(context, { onBlockedWrite }) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const policy = classifyCaptureRequest(request.method(), request.url());
    if (policy.action === 'abort') {
      onBlockedWrite({ method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
