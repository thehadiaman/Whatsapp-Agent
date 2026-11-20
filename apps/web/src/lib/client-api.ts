import { z } from 'zod';

/** An API error with the server's own sentence, which is written for staff. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** The server's message, or a plain one when there is none. */
export function messageOf(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
}

/**
 * Calls the API on the same origin and validates the answer. A JSON body is
 * sent as JSON; FormData (uploads) is sent as multipart by the browser.
 */
export async function request<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiRequestError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  if (response.status === 401) {
    // A full page load: the session is gone, so no client state is worth keeping.
    window.location.assign(new URL('/sign-in', window.location.origin).href);
    throw new ApiRequestError(401, 'Your session has ended. Sign in to continue.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `The server answered ${String(response.status)}. Try again.`;
    throw new ApiRequestError(response.status, message);
  }
  return schema.parse(body);
}

const ok = z.unknown();

export const post = (path: string, body: unknown = {}) =>
  request(path, { method: 'POST', body: JSON.stringify(body) }, ok);
