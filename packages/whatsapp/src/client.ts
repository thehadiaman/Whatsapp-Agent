import { z } from 'zod';
import { GraphApiError } from './errors.js';

/**
 * The four Graph API calls the product makes. One implementation for both
 * modes: in mock mode `baseUrl` points at the simulator, in live mode at
 * https://graph.facebook.com. Nothing else differs (brief §5).
 */
export interface GraphClientOptions {
  baseUrl: string;
  /** Graph API version, e.g. `v26.0`. */
  version: string;
  accessToken: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Who to send to: the business-scoped user ID when known, else the phone number. */
export type Recipient = { bsuid: string } | { phone: string };

export type OutboundContent =
  | { kind: 'text'; body: string }
  | { kind: 'template'; name: string; languageCode: string }
  | { kind: 'audio'; mediaId: string; voice: boolean };

const sendResponseSchema = z
  .object({
    messages: z.array(z.object({ id: z.string() }).loose()).min(1),
  })
  .loose();

const mediaInfoSchema = z
  .object({
    url: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    file_size: z.union([z.number(), z.string()]).optional(),
    id: z.string(),
  })
  .loose();
export type MediaInfo = z.infer<typeof mediaInfoSchema>;

const errorBodySchema = z
  .object({ error: z.object({ message: z.string().optional(), code: z.number() }).loose() })
  .loose();

/** Builds a Cloud API send-message body. */
export function messageBody(
  recipient: Recipient,
  content: OutboundContent,
): Record<string, unknown> {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Since July 2026 Meta accepts a BSUID in `recipient` (and then no `to`).
    ...('bsuid' in recipient ? { recipient: recipient.bsuid } : { to: recipient.phone }),
  };
  switch (content.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: content.body, preview_url: false } };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: { name: content.name, language: { code: content.languageCode } },
      };
    case 'audio':
      return { ...base, type: 'audio', audio: { id: content.mediaId, voice: content.voice } };
  }
}

export class GraphClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GraphClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/${this.options.version}/${path}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.options.accessToken}`);
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GraphApiError({
        message: `Graph API unreachable: ${error instanceof Error ? error.name : 'error'}`,
        httpStatus: null,
        code: null,
        ambiguous: init.method === 'POST',
      });
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const parsed = errorBodySchema.safeParse(body);
      throw new GraphApiError({
        message: parsed.success
          ? `Graph API error ${String(parsed.data.error.code)}: ${parsed.data.error.message ?? ''}`
          : `Graph API HTTP ${String(response.status)}`,
        httpStatus: response.status,
        code: parsed.success ? parsed.data.error.code : null,
      });
    }
    return response;
  }

  /** POST /{phone-number-id}/messages. Returns the WhatsApp message ID (wamid). */
  async sendMessage(
    phoneNumberId: string,
    recipient: Recipient,
    content: OutboundContent,
  ): Promise<string> {
    const response = await this.request(this.url(`${phoneNumberId}/messages`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageBody(recipient, content)),
    });
    const parsed = sendResponseSchema.parse(await response.json());
    const first = parsed.messages[0];
    if (!first) throw new Error('unreachable: schema requires one message');
    return first.id;
  }

  /** POST /{phone-number-id}/media (multipart). Returns the media ID. */
  async uploadMedia(
    phoneNumberId: string,
    file: { bytes: Uint8Array; mimeType: string; filename: string },
  ): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', file.mimeType);
    form.set('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);
    const response = await this.request(this.url(`${phoneNumberId}/media`), {
      method: 'POST',
      body: form,
    });
    return z
      .object({ id: z.string() })
      .loose()
      .parse(await response.json()).id;
  }

  /** GET /{media-id}: a short-lived download URL (Meta: valid 5 minutes) and metadata. */
  async getMedia(mediaId: string): Promise<MediaInfo> {
    const response = await this.request(this.url(mediaId), { method: 'GET' });
    return mediaInfoSchema.parse(await response.json());
  }

  /** GET the URL from getMedia, with the access token. */
  async downloadMedia(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.request(url, { method: 'GET' });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}
