import { QueryClient, QueryFunction } from "@tanstack/react-query";

// __PORT_5000__ is rewritten to the proxy path at deploy time.
// The startsWith guard makes it work locally too (empty string = relative).
export const API_BASE = ("__PORT_5000__" as string).startsWith("__") ? "" : "__PORT_5000__";

// ── Token store ───────────────────────────────────────────────────────────────
// Stored on window so it survives module re-evaluation inside sandboxed iframes.
declare global { interface Window { __bss_token?: string | null; } }

export function setAuthToken(token: string | null) {
  window.__bss_token = token;
}

export function getAuthToken(): string | null {
  return window.__bss_token ?? null;
}

function getToken(): string | null {
  return window.__bss_token ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Every request automatically attaches the current JWT token
export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  await throwIfResNotOk(res);
  return res;
}

// ── Default query function — attaches token to all GET queries ────────────────
type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const path = queryKey[0] as string;
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { headers });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
