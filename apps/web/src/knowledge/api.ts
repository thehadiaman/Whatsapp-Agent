import {
  knowledgeSourceDetailSchema,
  knowledgeSourceSchema,
  MAX_KNOWLEDGE_UPLOAD_MB,
  retrievedPassageSchema,
  type FaqBody,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type RetrievedPassageView,
} from '@app/shared';
import { z } from 'zod';
import { ApiRequestError, request } from '../lib/client-api';

const created = z.object({ id: z.uuid() });

export const knowledgeApi = {
  list: (): Promise<KnowledgeSource[]> =>
    request('/knowledge/sources', {}, z.array(knowledgeSourceSchema)),
  detail: (id: string): Promise<KnowledgeSourceDetail> =>
    request(`/knowledge/sources/${id}`, {}, knowledgeSourceDetailSchema),
  addFaq: (body: FaqBody) =>
    request('/knowledge/faqs', { method: 'POST', body: JSON.stringify(body) }, created),
  editFaq: (id: string, body: FaqBody) =>
    request(`/knowledge/faqs/${id}`, { method: 'PUT', body: JSON.stringify(body) }, created),
  remove: (id: string) => request(`/knowledge/sources/${id}`, { method: 'DELETE' }, z.unknown()),
  tryQuestion: (question: string): Promise<RetrievedPassageView[]> =>
    request(
      '/knowledge/try',
      { method: 'POST', body: JSON.stringify({ question }) },
      z.array(retrievedPassageSchema),
    ),
  upload: async (file: File): Promise<{ id: string }> => {
    const form = new FormData();
    form.append('file', file);
    try {
      return await request('/knowledge/files', { method: 'POST', body: form }, created);
    } catch (error) {
      // The size limit is enforced before the controller runs, with a terse message.
      if (error instanceof ApiRequestError && error.status === 413) {
        throw new ApiRequestError(
          413,
          `The file is over ${String(MAX_KNOWLEDGE_UPLOAD_MB)} MB. Split it into smaller files and upload them one at a time.`,
        );
      }
      throw error;
    }
  },
};
