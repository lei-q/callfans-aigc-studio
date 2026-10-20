/* 和本机服务通信：写操作带上客户端标识头（服务端据此防 CSRF） */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-aigc-client': '1',
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    ...init,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = (data || {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, d.error || `请求失败（HTTP ${res.status}）`, d.detail, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, form),
};

/** 持续接收服务端事件；断线自动重连 */
export function subscribe(onEvent: (e: unknown) => void, onState?: (ok: boolean) => void) {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const open = () => {
    es = new EventSource('/api/events');
    es.onopen = () => onState?.(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* 忽略坏消息 */
      }
    };
    es.onerror = () => {
      onState?.(false);
      es?.close();
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}
