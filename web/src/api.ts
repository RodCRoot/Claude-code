// Thin fetch wrapper that attaches the JWT and unwraps JSON / errors.

const TOKEN_KEY = "vantage_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(method: string, path: string, body?: unknown, raw?: boolean): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  if (raw) headers["Content-Type"] = "text/csv";

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(typeof msg.error === "string" ? msg.error : "Request failed");
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
  postCsv: <T>(p: string, csv: string) => request<T>("POST", p, csv, true),
};
