import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import {
  ModelUnavailableError,
  type ChatModel,
  type ModelContent,
  type ModelRequest,
} from '@app/assistant';

type CreateParams = Parameters<AnthropicBedrock['messages']['create']>[0];

/** The part of the SDK client the adapter uses; tests pass a fake. */
export interface MessagesClient {
  messages: { create(params: CreateParams, options?: { timeout?: number }): Promise<unknown> };
}

interface ApiMessage {
  content: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: string }
  )[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function toBlock(block: ModelContent) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'tool_use':
      return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result' as const,
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

/**
 * The JSON object the prompt asks the model to finish with. Prose around it
 * is ignored; nothing found means the response fails validation and the
 * conversation goes to a person (D-059).
 */
export function finalJson(text: string): unknown {
  const end = text.lastIndexOf('}');
  if (end < 0) return undefined;
  for (
    let start = text.lastIndexOf('{', end);
    start >= 0;
    start = text.lastIndexOf('{', start - 1)
  ) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      // Not a whole object yet: widen to the previous brace.
    }
    if (start === 0) break;
  }
  return undefined;
}

/** HTTP statuses retrying cannot fix: bad request, no access, no such model. */
const PERMANENT = new Set([400, 401, 403, 404, 422]);

function statusOf(error: unknown): number | null {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : null;
}

/**
 * Claude in Amazon Bedrock through the Messages API on bedrock-runtime
 * (InvokeModel), named by an inference profile such as
 * `global.anthropic.claude-haiku-5-5` (D-109; Mumbai has no in-Region Haiku).
 * Credentials come from the default AWS chain: the instance role on EC2.
 */
export class BedrockChatModel implements ChatModel {
  readonly name: string;
  private readonly client: MessagesClient;
  private readonly timeoutMs: number;

  constructor(options: {
    model: string;
    region: string;
    timeoutMs?: number;
    client?: MessagesClient;
  }) {
    this.name = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.client =
      options.client ??
      // apiKey null: always sign with AWS credentials, never a Bedrock API key from the environment.
      new AnthropicBedrock({ awsRegion: options.region, apiKey: null, maxRetries: 2 });
  }

  async complete(request: ModelRequest): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await this.client.messages.create(
        {
          model: this.name,
          max_tokens: request.maxTokens,
          system: request.system,
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as { type: 'object'; [key: string]: unknown },
          })),
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content.map(toBlock),
          })),
        },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      const status = statusOf(error);
      if (status !== null && PERMANENT.has(status)) {
        // Not retried: no access to the model, a wrong ID, or a request it rejects.
        throw new ModelUnavailableError(
          `Bedrock refused the request (HTTP ${String(status)}): ${error instanceof Error ? error.message.slice(0, 200) : ''}`,
        );
      }
      throw error; // throttling, timeouts, 5xx: the assistant job retries
    }

    const message = raw as ApiMessage;
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
    const calls = message.content.flatMap((b) =>
      b.type === 'tool_use' && 'id' in b ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    if (message.stop_reason === 'tool_use' && calls.length > 0) {
      return { model: this.name, usage, result: { type: 'tool_calls', calls } };
    }
    const text = message.content
      .flatMap((b) => (b.type === 'text' && 'text' in b ? [b.text] : []))
      .join('\n');
    // Validated by the caller (completeValidated): no JSON, a refusal or a
    // truncated reply fails there and the turn hands over.
    return {
      model: this.name,
      usage,
      result: { type: 'answer', answer: finalJson(text) },
    };
  }
}
