import { cookies } from 'next/headers';
import type { z } from 'zod';

/** Where the Next.js server reaches the API. Browsers never use this; they go through /api. */
const API_INTERNAL_URL = process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

/**
 * GET from the API on behalf of the signed-in user (server components only).
 * Forwards the session cookie and validates the response shape: the web app
 * trusts the API's types only after zod has checked them.
 */
export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<ApiResult<z.output<S>>> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${API_INTERNAL_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, data: schema.parse(await response.json()) };
}
