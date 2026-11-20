import {
  MockChatModel,
  MockEmbedder,
  UnconfiguredEmbedder,
  UnconfiguredModel,
  type ChatModel,
  type Embedder,
} from '@app/assistant';
import { appModeSchema, type AppMode } from '@app/shared';
import { GraphClient } from '@app/whatsapp';
import { z } from 'zod';

export type Provider = 'meta' | 'simulator';

export interface ProviderSettings {
  baseUrl: string;
  graphVersion: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

const secret = z.string().min(8);

export const pipelineEnvSchema = z.object({
  APP_MODE: appModeSchema.default('mock'),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v26.0'),
  SIMULATOR_GRAPH_URL: z.url().optional(),
  SIMULATOR_ACCESS_TOKEN: secret.optional(),
  SIMULATOR_APP_SECRET: secret.optional(),
  SIMULATOR_VERIFY_TOKEN: secret.optional(),
  META_GRAPH_URL: z.url().default('https://graph.facebook.com'),
  META_ACCESS_TOKEN: secret.optional(),
  META_APP_SECRET: secret.optional(),
  META_VERIFY_TOKEN: secret.optional(),
  /** How long a reply waits for the previous one's `delivered` status (P-02). */
  ORDER_HOLD_MS: z.coerce.number().int().min(0).default(10_000),
  OUTBOUND_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  OUTBOUND_BACKOFF_MS: z.coerce.number().int().min(1).default(1_000),
  MEDIA_STORAGE_DIR: z.string().default('.data/media'),
  /** Kill switch: false stops new assistant turns; conversations wait for a person. */
  ASSISTANT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Wait after a customer message before answering, so a burst of messages gets one reply. */
  ASSISTANT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1_500),
  ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(1_024),
  /** BullMQ key prefix; the API and worker must agree. Tests use their own. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('bull'),
});
export type PipelineEnv = z.infer<typeof pipelineEnvSchema>;

/**
 * The WhatsApp APIs this process may talk to. In mock mode only the simulator
 * exists, so no setting can make a mock-mode process call Meta. In live mode
 * both may exist: real numbers on Meta, demo numbers on the simulator (P-01).
 */
export class ProviderRegistry {
  private readonly settings: Partial<Record<Provider, ProviderSettings>>;

  constructor(settings: Partial<Record<Provider, ProviderSettings>>) {
    this.settings = settings;
  }

  static fromEnv(env: PipelineEnv): ProviderRegistry {
    const settings: Partial<Record<Provider, ProviderSettings>> = {};
    if (
      env.SIMULATOR_GRAPH_URL &&
      env.SIMULATOR_ACCESS_TOKEN &&
      env.SIMULATOR_APP_SECRET &&
      env.SIMULATOR_VERIFY_TOKEN
    ) {
      settings.simulator = {
        baseUrl: env.SIMULATOR_GRAPH_URL,
        graphVersion: env.WHATSAPP_GRAPH_VERSION,
        accessToken: env.SIMULATOR_ACCESS_TOKEN,
        appSecret: env.SIMULATOR_APP_SECRET,
        verifyToken: env.SIMULATOR_VERIFY_TOKEN,
      };
    }
    if (
      allowsMeta(env.APP_MODE) &&
      env.META_ACCESS_TOKEN &&
      env.META_APP_SECRET &&
      env.META_VERIFY_TOKEN
    ) {
      settings.meta = {
        baseUrl: env.META_GRAPH_URL,
        graphVersion: env.WHATSAPP_GRAPH_VERSION,
        accessToken: env.META_ACCESS_TOKEN,
        appSecret: env.META_APP_SECRET,
        verifyToken: env.META_VERIFY_TOKEN,
      };
    }
    return new ProviderRegistry(settings);
  }

  get(provider: Provider): ProviderSettings | undefined {
    return this.settings[provider];
  }

  require(provider: Provider): ProviderSettings {
    const settings = this.settings[provider];
    if (!settings) throw new Error(`WhatsApp provider "${provider}" is not configured`);
    return settings;
  }

  client(provider: Provider): GraphClient {
    const s = this.require(provider);
    return new GraphClient({
      baseUrl: s.baseUrl,
      version: s.graphVersion,
      accessToken: s.accessToken,
    });
  }
}

function allowsMeta(mode: AppMode): boolean {
  return mode === 'live';
}

export interface PipelineSettings {
  orderHoldMs: number;
  outboundAttempts: number;
  outboundBackoffMs: number;
}

export function pipelineSettings(env: PipelineEnv): PipelineSettings {
  return {
    orderHoldMs: env.ORDER_HOLD_MS,
    outboundAttempts: env.OUTBOUND_ATTEMPTS,
    outboundBackoffMs: env.OUTBOUND_BACKOFF_MS,
  };
}

export interface AssistantSettings {
  /** When false, customer messages queue no assistant turn. */
  enabled: boolean;
  debounceMs: number;
  maxOutputTokens: number;
}

/** The model and embedder behind the assistant, chosen by APP_MODE. */
export interface AssistantDeps {
  model: ChatModel;
  embedder: Embedder;
  settings: AssistantSettings;
}

/**
 * Mock mode: the scripted model and the hashed n-gram embedder, offline.
 * Live mode: the Bedrock adapters arrive in phase 7; until then every turn
 * hands over to a person, so a real customer is never answered by the mock.
 */
export function assistantDeps(env: PipelineEnv): AssistantDeps {
  const settings = {
    enabled: env.ASSISTANT_ENABLED,
    debounceMs: env.ASSISTANT_DEBOUNCE_MS,
    maxOutputTokens: env.ASSISTANT_MAX_OUTPUT_TOKENS,
  };
  return env.APP_MODE === 'mock'
    ? { model: new MockChatModel(), embedder: new MockEmbedder(), settings }
    : { model: new UnconfiguredModel(), embedder: new UnconfiguredEmbedder(), settings };
}
