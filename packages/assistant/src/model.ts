import { z } from 'zod';

/**
 * The port between the assistant and a language model. Its shape mirrors the
 * Claude Messages API (text, tool_use and tool_result blocks), so the live
 * adapter for Claude in Amazon Bedrock (phase 7) is a thin mapping, and the
 * mock speaks the same protocol.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelContent[];
}

export interface ModelRequest {
  /** Stable per business, so the live adapter can cache it. */
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

/** What the assistant's final answer was based on; recorded per turn for analytics. */
export const ANSWER_BASES = ['knowledge', 'order', 'none', 'declined'] as const;
export type AnswerBasis = (typeof ANSWER_BASES)[number];

/** WhatsApp allows 4,096 characters; the assistant is told to keep it to three sentences. */
export const MAX_REPLY_CHARS = 1_000;

export const finalAnswerSchema = z.object({
  reply: z.string().trim().min(1).max(MAX_REPLY_CHARS),
  basis: z.enum(ANSWER_BASES),
});
export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

/** Validated at the boundary: whatever the adapter returns is parsed with this. */
export const modelResponseSchema = z.object({
  model: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  result: z.discriminatedUnion('type', [
    z.object({ type: z.literal('tool_calls'), calls: z.array(toolCallSchema).min(1) }),
    z.object({ type: z.literal('answer'), answer: finalAnswerSchema }),
  ]),
});
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface ChatModel {
  /** The model ID used for pricing, e.g. `global.anthropic.claude-haiku-5-5` or `mock`. */
  readonly name: string;
  complete(request: ModelRequest): Promise<unknown>;
}

/** Calls the model and validates what comes back; a malformed response throws. */
export async function completeValidated(
  model: ChatModel,
  request: ModelRequest,
): Promise<ModelResponse> {
  return modelResponseSchema.parse(await model.complete(request));
}

/** A model that cannot be used at all (not configured); the turn hands over at once. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * Live mode before the Bedrock adapter exists (phase 7): every turn hands the
 * conversation to a person instead of answering with the mock.
 */
export class UnconfiguredModel implements ChatModel {
  readonly name = 'unconfigured';
  complete(): Promise<never> {
    return Promise.reject(
      new ModelUnavailableError(
        'No live model is configured; the Bedrock adapter arrives in phase 7.',
      ),
    );
  }
}
