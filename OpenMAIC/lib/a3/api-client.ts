const DEFAULT_A3_API_BASE_URL = 'http://localhost:8000';
const SESSION_MUTATION_PATHS = new Set([
  '/api/auth/login/',
  '/api/auth/register/',
  '/api/auth/token/',
  '/api/auth/logout/',
]);

export async function a3GetJson<T>(url: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  try {
    const response = await fetch(resolveA3Endpoint(url), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
    });
    return readJsonResponse<T>(response);
  } catch (error) {
    return requestFailure<T>(error);
  }
}

export async function a3PostJson<T>(url: string, body: unknown): Promise<T> {
  return a3JsonRequest('POST', url, body);
}

export async function a3PatchJson<T>(url: string, body: unknown): Promise<T> {
  return a3JsonRequest('PATCH', url, body);
}

export async function a3DeleteJson<T>(url: string): Promise<T> {
  try {
    const response = await a3CsrfFetch(url, {
      method: 'DELETE',
      credentials: 'include',
    });
    return readJsonResponse<T>(response);
  } catch (error) {
    return requestFailure<T>(error);
  }
}

export async function a3UploadFiles<T>(url: string, files: File[], fields?: Record<string, string>): Promise<T> {
  try {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    Object.entries(fields ?? {}).forEach(([key, value]) => formData.append(key, value));
    const response = await a3CsrfFetch(url, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    return readJsonResponse<T>(response);
  } catch (error) {
    return requestFailure<T>(error);
  }
}

export async function a3DownloadFile(url: string, fileName: string) {
  const response = await fetch(resolveA3Endpoint(url), { credentials: 'include' });
  if (!response.ok) throw new Error('文件下载失败');
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

export async function a3PostDownload(
  url: string,
  body: unknown,
  fallbackFileName: string,
): Promise<{ fileName: string }> {
  const response = await a3CsrfFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = await response.json() as { error?: string };
      throw new Error(payload.error || '文件生成失败');
    }
    throw new Error('文件生成失败（' + response.status + '）');
  }
  const fileName = responseFileName(response.headers.get('Content-Disposition')) || fallbackFileName;
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
  return { fileName };
}

function responseFileName(contentDisposition: string | null) {
  if (!contentDisposition) return '';
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return contentDisposition.match(/filename="?([^";]+)"?/i)?.[1] ?? '';
}

async function a3JsonRequest<T>(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<T> {
  try {
    const response = await a3CsrfFetch(url, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result = await readJsonResponse<T>(response);
    if (response.ok && isSessionMutation(url)) {
      csrfTokenPromise = null;
    }
    return result;
  } catch (error) {
    return requestFailure<T>(error);
  }
}

function isSessionMutation(url: string) {
  try {
    return SESSION_MUTATION_PATHS.has(new URL(url, DEFAULT_A3_API_BASE_URL).pathname);
  } catch {
    return false;
  }
}

async function a3CsrfFetch(url: string, init: RequestInit, retry = true): Promise<Response> {
  const csrfToken = await getA3CsrfToken();
  const response = await fetch(resolveA3Endpoint(url), {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.headers ?? {}),
      ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
    },
  });
  if (retry && (await isA3CsrfFailure(response))) {
    csrfTokenPromise = null;
    return a3CsrfFetch(url, init, false);
  }
  return response;
}

async function isA3CsrfFailure(response: Response) {
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().text();
    return /\bcsrf\b|跨站请求伪造/i.test(body);
  } catch {
    return false;
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const payload = await response.json() as T;
    if (!response.ok && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { ...payload, status: response.status } as T;
    }
    return payload;
  }
  return {
    success: false,
    error: response.ok ? '请求返回了无法识别的数据' : `请求失败（${response.status}）`,
    ...(!response.ok ? { status: response.status } : {}),
  } as T;
}

function requestFailure<T>(_error: unknown): T {
  return {
    success: false,
    error: '暂时无法连接 A3 后端服务，请检查网络连接后刷新页面或重试。',
  } as T;
}

export function resolveA3Endpoint(url: string) {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_A3_API_BASE_URL ?? DEFAULT_A3_API_BASE_URL;
  return new URL(url, localizeLoopbackBaseUrl(configuredBaseUrl)).toString();
}

function localizeLoopbackBaseUrl(baseUrl: string) {
  if (typeof window === 'undefined') return baseUrl;
  const pageHostname = window.location.hostname;
  if (!isLoopbackHost(pageHostname)) return baseUrl;
  try {
    const parsed = new URL(baseUrl);
    if (isLoopbackHost(parsed.hostname) && parsed.hostname !== pageHostname) {
      parsed.hostname = pageHostname;
      return parsed.toString();
    }
  } catch {
    return baseUrl;
  }
  return baseUrl;
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

let csrfTokenPromise: Promise<string> | null = null;

async function getA3CsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch(resolveA3Endpoint('/api/auth/csrf/'), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
      .then((response) => response.json() as Promise<{ csrfToken?: string }>)
      .then((data) => data.csrfToken ?? '')
      .catch(() => {
        csrfTokenPromise = null;
        return '';
      });
  }
  return csrfTokenPromise;
}
