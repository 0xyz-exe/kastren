let csrfToken: string | undefined;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const custom = window.localStorage.getItem('kastren_api_url');
    if (custom) return custom.trim().replace(/\/+$/, '');
  }
  const envUrl = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
  return envUrl;
}

export function setApiBase(url: string): void {
  if (typeof window !== 'undefined') {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      window.localStorage.removeItem('kastren_api_url');
    } else {
      window.localStorage.setItem('kastren_api_url', trimmed);
    }
    csrfToken = undefined;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getApiBase();
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  if (typeof window !== 'undefined') {
    const savedToken = window.localStorage.getItem('kastren_session_token');
    if (savedToken && !headers.has('authorization')) headers.set('authorization', `Bearer ${savedToken}`);
  }

  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    if (!csrfToken) {
      try {
        const csrfRes = await fetch(`${base}/auth/csrf`, { credentials: 'include' });
        if (!csrfRes.ok) throw new Error(`CSRF fetch failed (${csrfRes.status})`);
        const json = await csrfRes.json() as { csrfToken: string };
        csrfToken = json.csrfToken;
      } catch (err) {
        throw new ApiError(0, `Cannot reach API at ${base || 'relative origin'}: ${err instanceof Error ? err.message : 'Network error'}. Check server URL.`);
      }
    }
    headers.set('x-csrf-token', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...options, headers, credentials: 'include' });
  } catch (err) {
    throw new ApiError(0, `Failed to connect to ${base || 'API'}: ${err instanceof Error ? err.message : 'Network error'}`);
  }

  if (response.status === 204) {
    if (path === '/auth/logout' && typeof window !== 'undefined') window.localStorage.removeItem('kastren_session_token');
    return undefined as T;
  }
  const result = await response.json().catch(() => ({})) as { error?: string; token?: string; csrfToken?: string };
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.localStorage.removeItem('kastren_session_token');
    throw new ApiError(response.status, result.error ?? 'Request failed.');
  }
  if (result.token && typeof result.token === 'string' && typeof window !== 'undefined') {
    window.localStorage.setItem('kastren_session_token', result.token);
  }
  if ('csrfToken' in result && typeof result.csrfToken === 'string') csrfToken = result.csrfToken;
  return result as T;
}
