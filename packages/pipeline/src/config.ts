import { MockChatModel, MockEmbedder, type ChatModel, type Embedder } from '@app/assistant';
import {
  BedrockChatModel,
  BedrockEmbedder,
  PollyTextToSpeech,
  S3ObjectStorage,
  TranscribeSpeechToText,
} from '@app/live';
import { appModeSchema, type AppMode } from '@app/shared';
import {
  MockSpeechToText,
  MockTextToSpeech,
  UnconfiguredSpeechToText,
  type SpeechToText,
  type TextToSpeech,
} from '@app/voice';
import { GraphClient } from '@app/whatsapp';
import { channelTokenContext, SecretBox } from './secrets.js';
import { LocalDiskStorage, type ObjectStorage } from './storage.js';
import { z } from 'zod';

export type Provider = 'meta' | 'simulator';

export interface ProviderSettings {
  baseUrl: string;
  graphVersion: string;
  /** The simulator's one token. Meta numbers carry their own, sealed, per business (P-04). */
  accessToken: string | null;
  appSecret: string;
  verifyToken: string;
}

/** The number a call is for: its provider and, for Meta, its sealed token. */
export interface ChannelCredentials {
  provider: Provider;
  phoneNumberId: string;
  accessTokenSealed: string | null;
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
  META_APP_SECRET: secret.optional(),
  META_VERIFY_TOKEN: secret.optional(),
  /** 32 random bytes, base64: seals each business's WhatsApp token (D-094). Live mode only. */
  CREDENTIALS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded')
    .optional(),
  /** How long a reply waits for the previous one's `delivered` status (P-02). */
  ORDER_HOLD_MS: z.coerce.number().int().min(0).default(10_000),
  OUTBOUND_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  OUTBOUND_BACKOFF_MS: z.coerce.number().int().min(1).default(1_000),
  MEDIA_STORAGE_DIR: z.string().default('.data/media'),
  // --- live mode. AWS credentials come from the instance role, never from here.
  AWS_REGION: z.string().default('ap-south-1'),
  /** S3 bucket for media and knowledge files. Unset: local disk, and voice notes go to a person. */
  MEDIA_BUCKET: z.string().min(3).optional(),
  /** How long a playback link to a stored file works. */
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /** Claude in Amazon Bedrock (bedrock-mantle), D-059. */
  BEDROCK_CHAT_MODEL: z.string().default('anthropic.claude-haiku-5-5'),
  /** Cohere Embed Multilingual v3, D-090. */
  BEDROCK_EMBED_MODEL: z.string().default('cohere.embed-multilingual-v3'),
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

  constructor(
    settings: Partial<Record<Provider, ProviderSettings>>,
    private readonly box: SecretBox | null = null,
  ) {
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
    if (allowsMeta(env.APP_MODE) && env.META_APP_SECRET && env.META_VERIFY_TOKEN) {
      settings.meta = {
        baseUrl: env.META_GRAPH_URL,
        graphVersion: env.WHATSAPP_GRAPH_VERSION,
        accessToken: null,
        appSecret: env.META_APP_SECRET,
        verifyToken: env.META_VERIFY_TOKEN,
      };
    }
    return new ProviderRegistry(
      settings,
      env.CREDENTIALS_KEY ? SecretBox.fromBase64(env.CREDENTIALS_KEY) : null,
    );
  }

  /** Seals and opens Meta tokens; null when no key is configured (mock mode). */
  get secrets(): SecretBox | null {
    return this.box;
  }

  get(provider: Provider): ProviderSettings | undefined {
    return this.settings[provider];
  }

  require(provider: Provider): ProviderSettings {
    const settings = this.settings[provider];
    if (!settings) throw new Error(`WhatsApp provider "${provider}" is not configured`);
    return settings;
  }

  /** A Graph API client for one number, with that number's token. */
  client(channel: ChannelCredentials): GraphClient {
    const s = this.require(channel.provider);
    let accessToken = s.accessToken;
    if (channel.provider === 'meta') {
      if (!channel.accessTokenSealed) {
        throw new Error('This WhatsApp number has no access token. Add one in settings.');
      }
      if (!this.box) throw new Error('CREDENTIALS_KEY is not configured');
      accessToken = this.box.open(
        channel.accessTokenSealed,
        channelTokenContext(channel.phoneNumberId),
      );
    }
    if (!accessToken)
      throw new Error(`WhatsApp provider "${channel.provider}" has no access token`);
    return new GraphClient({ baseUrl: s.baseUrl, version: s.graphVersion, accessToken });
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

/** Speech in and out, chosen by APP_MODE. */
export interface VoiceDeps {
  stt: SpeechToText;
  tts: TextToSpeech;
}

/**
 * Mock mode: the transcript the simulator attached, and the bundled clip.
 * Live mode: Amazon Transcribe (needs the S3 bucket) and Amazon Polly.
 */
export function voiceDeps(env: PipelineEnv): VoiceDeps {
  if (env.APP_MODE === 'mock') return { stt: new MockSpeechToText(), tts: new MockTextToSpeech() };
  return {
    // Transcribe reads the file from S3: without a bucket, voice notes go to a person.
    stt: env.MEDIA_BUCKET
      ? new TranscribeSpeechToText({ bucket: env.MEDIA_BUCKET, region: env.AWS_REGION })
      : new UnconfiguredSpeechToText(),
    tts: new PollyTextToSpeech({ region: env.AWS_REGION }),
  };
}

/** Where media and knowledge files live: S3 when a bucket is set in live mode, else local disk. */
export function storageFor(env: PipelineEnv): ObjectStorage {
  return env.APP_MODE === 'live' && env.MEDIA_BUCKET
    ? new S3ObjectStorage({ bucket: env.MEDIA_BUCKET, region: env.AWS_REGION })
    : new LocalDiskStorage(env.MEDIA_STORAGE_DIR);
}

/** The embedder alone, for the seed and the knowledge tools. */
export function embedderFor(env: PipelineEnv): Embedder {
  return env.APP_MODE === 'mock'
    ? new MockEmbedder()
    : new BedrockEmbedder({ model: env.BEDROCK_EMBED_MODEL, region: env.AWS_REGION });
}

/**
 * Mock mode: the scripted model and the hashed n-gram embedder, offline.
 * Live mode: Claude and Cohere embeddings in Amazon Bedrock. The mock never
 * answers a real customer: a mode is one or the other.
 */
export function assistantDeps(env: PipelineEnv): AssistantDeps {
  const settings = {
    enabled: env.ASSISTANT_ENABLED,
    debounceMs: env.ASSISTANT_DEBOUNCE_MS,
    maxOutputTokens: env.ASSISTANT_MAX_OUTPUT_TOKENS,
  };
  return env.APP_MODE === 'mock'
    ? { model: new MockChatModel(), embedder: new MockEmbedder(), settings }
    : {
        model: new BedrockChatModel({ model: env.BEDROCK_CHAT_MODEL, region: env.AWS_REGION }),
        embedder: embedderFor(env),
        settings,
      };
}
