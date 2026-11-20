import {
  conversationDetailSchema,
  conversationListItemSchema,
  teamMemberSchema,
  type ConversationDetail,
  type ConversationListItem,
  turnExplanationSchema,
  type ReplyBody,
  type TeamMember,
  type TurnExplanation,
} from '@app/shared';
import { z } from 'zod';
import { post, request } from '../lib/client-api';

export { ApiRequestError } from '../lib/client-api';

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
  explanation: (conversationId: string, turnId: string): Promise<TurnExplanation> =>
    request(`/conversations/${conversationId}/turns/${turnId}`, {}, turnExplanationSchema),
};
