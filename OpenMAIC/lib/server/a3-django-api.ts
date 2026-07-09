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
  const csrfToken = extractCookie(cookieHeader, 'csrftoken');
  const response = await fetch(resolveA3DjangoEndpoint(path), {
    method: 'POST',
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
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

function extractCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return '';
  const prefix = `${name}=`;
  const item = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}
