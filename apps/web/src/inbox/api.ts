import {
  conversationDetailSchema,
  conversationListItemSchema,
  teamMemberSchema,
  type ConversationDetail,
  type ConversationListItem,
  type ReplyBody,
  type TeamMember,
} from '@app/shared';
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

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
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
const post = (path: string, body: unknown = {}) =>
  request(path, { method: 'POST', body: JSON.stringify(body) }, ok);

export const inboxApi = {
  list: (scope: 'open' | 'closed'): Promise<ConversationListItem[]> =>
    request(`/conversations?scope=${scope}`, {}, z.array(conversationListItemSchema)),
  detail: (id: string): Promise<ConversationDetail> =>
    request(`/conversations/${id}`, {}, conversationDetailSchema),
  team: (): Promise<TeamMember[]> => request('/team', {}, z.array(teamMemberSchema)),
  takeOver: (id: string) => post(`/conversations/${id}/take-over`),
  handBack: (id: string) => post(`/conversations/${id}/hand-back`),
  assign: (id: string, userId: string) => post(`/conversations/${id}/assign`, { userId }),
  close: (id: string) => post(`/conversations/${id}/close`),
  reply: (id: string, body: ReplyBody) => post(`/conversations/${id}/replies`, body),
  note: (id: string, text: string) => post(`/conversations/${id}/notes`, { text }),
  retry: (messageId: string) => post(`/messages/${messageId}/retry`),
};
