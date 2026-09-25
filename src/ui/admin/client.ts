/** Browser client for the admin API: JSON in/out, CSRF header on writes, typed errors. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  errors?: Record<string, string>;
  /** Per-field validation messages (422 invalid_body). */
  fields?: Record<string, string>;
}

export function adminClient(apiBase: string) {
  let csrf = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
    const r = await fetch(`${apiBase}/admin/${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: Omit<ApiError, 'status'> } & T;
    if (!r.ok) {
      const e = data.error ?? { code: 'unknown', message: 'Something went wrong. Try again.' };
      throw { status: r.status, ...e } as ApiError;
    }
    return data;
  }
  return {
    setCsrf: (t: string) => void (csrf = t),
    get: <T,>(p: string) => call<T>('GET', p),
    post: <T,>(p: string, b: unknown = {}) => call<T>('POST', p, b),
    put: <T,>(p: string, b: unknown) => call<T>('PUT', p, b),
    del: <T,>(p: string) => call<T>('DELETE', p),
    csvUrl: `${apiBase}/admin/leads.csv`,
  };
}

export type AdminClient = ReturnType<typeof adminClient>;

export const isApiError = (e: unknown): e is ApiError => typeof e === 'object' && e !== null && 'code' in e && 'status' in e;
