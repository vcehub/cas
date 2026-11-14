/**
 * Authenticated fetch against the FastAPI backend.
 *
 * Signed-in backend routes (the essay writer, the calendar) require a
 * Supabase JWT, so every caller needs the same three things: attach the
 * session token, survive a stale one, and stay quiet when there is no
 * session at all.
 *
 * The refresh-and-retry is the part worth keeping in one place. supabase-js
 * pauses its auto-refresh ticker in hidden tabs, so a student returning to an
 * overnight tab holds an expired access token and the first call 401s. One
 * refresh, one retry — a second hand-rolled copy of that would drift.
 */

import { createClient } from "@/shared/lib/supabase/client";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export async function authHeader(): Promise<Record<string, string>> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return {};
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function refreshedAuthHeader(): Promise<Record<string, string> | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return null;
  const supabase = createClient();
  const { data, error } = await supabase.auth.refreshSession();
  const token = data.session?.access_token;
  return !error && token ? { Authorization: `Bearer ${token}` } : null;
}

/** Runs the request, and once more with a refreshed token on a 401. Exported
 * for callers that need their own fetch wrapper (the Test Maker's timeout). */
export async function withRetry(
  send: (auth: Record<string, string>) => Promise<Response>,
): Promise<Response> {
  let res = await send(await authHeader());
  if (res.status === 401) {
    const refreshed = await refreshedAuthHeader();
    if (refreshed) res = await send(refreshed);
  }
  return res;
}

export type BackendMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Any method, with an optional JSON body. Content-Type is only set when there
 * is a body, so a bodyless GET or DELETE stays a simple request.
 */
export async function fetchWithAuth(
  url: string,
  {
    method = "GET",
    body,
    signal,
  }: { method?: BackendMethod; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const hasBody = body !== undefined;
  return withRetry((auth) =>
    fetch(url, {
      method,
      headers: hasBody ? { "Content-Type": "application/json", ...auth } : auth,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal,
    }),
  );
}

export async function postWithAuth(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithAuth(url, { method: "POST", body, signal });
}

export async function getWithAuth(
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithAuth(url, { signal });
}
