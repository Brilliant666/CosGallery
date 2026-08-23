export const AUTH_REQUIRED_EVENT = 'foldergram:auth-required';
const AUTH_REQUIRED_HEADER = 'x-foldergram-auth-required';

export class RequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const isSafeRead = method === 'GET' || method === 'HEAD';

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers.set('x-foldergram-intent', '1');
  }

  const response = await fetch(input, {
    ...init,
    cache: init?.cache ?? (isSafeRead ? 'no-store' : undefined),
    credentials: 'same-origin',
    headers
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;

    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        message = payload.message;
      }
    } catch {
      const error = new RequestError(message, response.status);
      if (response.status === 401 && response.headers.get(AUTH_REQUIRED_HEADER) === '1' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      }
      return Promise.reject(error);
    }

    const error = new RequestError(message, response.status);
    if (response.status === 401 && response.headers.get(AUTH_REQUIRED_HEADER) === '1' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw error;
  }

  return (await response.json()) as T;
}
