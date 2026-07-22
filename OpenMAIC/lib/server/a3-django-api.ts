const DEFAULT_A3_API_BASE_URL = 'http://localhost:8000';

type DjangoJsonResponse<T> = T & {
  success?: boolean;
  error?: string;
};

export async function fetchA3DjangoJson<T>(
  path: string,
  cookieHeader: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<DjangoJsonResponse<T>> {
  const response = await fetch(resolveA3DjangoEndpoint(path), {
    method: 'GET',
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal: options.signal,
  });

  const data = await response.json().catch(() => ({})) as DjangoJsonResponse<T>;
  if (!response.ok) {
    return {
      ...data,
      success: false,
      error: data.error || `Django API 请求失败：${response.status}`,
    };
  }
  return data;
}

export async function postA3DjangoJson<T>(
  path: string,
  cookieHeader: string | null,
  body: unknown,
): Promise<DjangoJsonResponse<T>> {
  let csrf = await resolveCsrfForServerPost(cookieHeader);
  let response = await postA3Django(path, cookieHeader, body, csrf);
  if (response.status === 403) {
    csrf = await resolveCsrfForServerPost(cookieHeader, true);
    response = await postA3Django(path, csrf.cookieHeader, body, csrf);
  }

  const responseText = await response.text();
  const data = parseJsonResponse<T>(responseText);
  if (!response.ok) {
    const upstreamError = data.error || djangoErrorMessage(response.status, responseText);
    console.error('[A3_DJANGO_POST_FAILED]', {
      path,
      status: response.status,
      error: upstreamError,
      bodyPreview: responseText.slice(0, 800),
    });
    return {
      ...data,
      success: false,
      error: upstreamError,
    };
  }
  return data;
}

export async function patchA3DjangoJson<T>(
  path: string,
  cookieHeader: string | null,
  body: unknown,
): Promise<DjangoJsonResponse<T>> {
  let csrf = await resolveCsrfForServerPost(cookieHeader);
  let response = await patchA3Django(path, body, csrf);
  if (response.status === 403) {
    csrf = await resolveCsrfForServerPost(cookieHeader, true);
    response = await patchA3Django(path, body, csrf);
  }
  const responseText = await response.text();
  const data = parseJsonResponse<T>(responseText);
  if (!response.ok) {
    return {
      ...data,
      success: false,
      error: data.error || djangoErrorMessage(response.status, responseText),
    };
  }
  return data;
}

function parseJsonResponse<T>(text: string): DjangoJsonResponse<T> {
  try {
    return JSON.parse(text || '{}') as DjangoJsonResponse<T>;
  } catch {
    return {} as DjangoJsonResponse<T>;
  }
}

function djangoErrorMessage(status: number, responseText: string) {
  const title = responseText.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const exception = responseText.match(/<pre class="exception_value">([\s\S]*?)<\/pre>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const detail = exception || title || responseText.replace(/\s+/g, ' ').trim().slice(0, 160);
  return detail ? `Django API 请求失败：${status}，${detail}` : `Django API 请求失败：${status}`;
}

async function postA3Django(
  path: string,
  cookieHeader: string | null,
  body: unknown,
  csrf: { token: string; cookieHeader: string | null },
) {
  return fetch(resolveA3DjangoEndpoint(path), {
    method: 'POST',
    headers: {
      ...(csrf.cookieHeader ? { Cookie: csrf.cookieHeader } : {}),
      ...(csrf.token ? { 'X-CSRFToken': csrf.token } : {}),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
}

async function patchA3Django(
  path: string,
  body: unknown,
  csrf: { token: string; cookieHeader: string | null },
) {
  return fetch(resolveA3DjangoEndpoint(path), {
    method: 'PATCH',
    headers: {
      ...(csrf.cookieHeader ? { Cookie: csrf.cookieHeader } : {}),
      ...(csrf.token ? { 'X-CSRFToken': csrf.token } : {}),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
}

async function resolveCsrfForServerPost(cookieHeader: string | null, forceRefresh = false) {
  const existing = forceRefresh ? '' : extractCookie(cookieHeader, 'csrftoken');
  if (existing) return { token: existing, cookieHeader };
  const response = await fetch(resolveA3DjangoEndpoint('/api/auth/csrf/'), {
    method: 'GET',
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({})) as { csrfToken?: string };
  const token = data.csrfToken || extractCookie(response.headers.get('set-cookie'), 'csrftoken');
  return {
    token,
    cookieHeader: token ? upsertCookie(cookieHeader, 'csrftoken', token) : cookieHeader,
  };
}

function upsertCookie(cookieHeader: string | null, name: string, value: string) {
  const encoded = encodeURIComponent(value);
  const parts = (cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith(`${name}=`));
  parts.push(`${name}=${encoded}`);
  return parts.join('; ');
}

function extractCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return '';
  const prefix = `${name}=`;
  const item = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (item) {
    return decodeURIComponent(item.slice(prefix.length));
  }
  const setCookieMatch = cookieHeader.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
  return setCookieMatch ? decodeURIComponent(setCookieMatch[1]) : '';
}

export async function fetchA3DjangoBinaryAsDataUrl(
  path: string,
  cookieHeader: string | null,
  maxBytes = 4 * 1024 * 1024,
): Promise<{ success: boolean; dataUrl?: string; contentType?: string; error?: string }> {
  const response = await fetch(resolveA3DjangoEndpoint(path), {
    method: 'GET',
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      Accept: 'image/*',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    return { success: false, error: `Django asset preview request failed: ${response.status}` };
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return { success: false, error: `Unsupported asset content type: ${contentType}` };
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    return { success: false, error: 'Knowledge-base visual evidence image is too large for vision input' };
  }
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return { success: true, dataUrl: `data:${contentType};base64,${base64}`, contentType };
}

export function resolveA3DjangoEndpoint(path: string) {
  const baseUrl = process.env.A3_API_BASE_URL || process.env.NEXT_PUBLIC_A3_API_BASE_URL || DEFAULT_A3_API_BASE_URL;
  return new URL(path, baseUrl).toString();
}

export function resolveA3InternalFrontendEndpoint(path: string, requestOrigin: string) {
  const baseUrl = process.env.A3_INTERNAL_FRONTEND_BASE_URL?.trim() || requestOrigin;
  return new URL(path, baseUrl).toString();
}
