import type { Embedder, EmbeddingPurpose } from '@app/assistant';
import {
  fromTranscribeCode,
  SynthesisError,
  TRANSCRIBE_CODES,
  TranscriptionError,
  VOICE_NOTE_MIME_TYPE,
  type PollyVoice,
  type SpeechAudio,
  type SpeechToText,
  type TextToSpeech,
  type TranscribeInput,
  type Transcript,
} from '@app/voice';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  PollyClient,
  SynthesizeSpeechCommand,
  type LanguageCode as PollyLanguage,
  type VoiceId,
} from '@aws-sdk/client-polly';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type LanguageCode as TranscribeLanguage,
  type MediaFormat,
} from '@aws-sdk/client-transcribe';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

/** What every AWS SDK v3 client has; tests pass fakes with the same method. */
export interface Sender {
  send(command: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Embeddings: Cohere Embed Multilingual v3 on Bedrock (D-090)

const cohereResponseSchema = z.object({ embeddings: z.array(z.array(z.number())) });

/** Cohere takes at most 96 texts per call. */
const COHERE_BATCH = 96;

export class BedrockEmbedder implements Embedder {
  readonly model: string;
  /**
   * Cosine similarity below which a passage counts as unrelated. A starting
   * value: the retrieval evals (phase 8) set it from measurements.
   */
  readonly relevanceFloor = 0.25;
  private readonly client: Sender;

  constructor(options: { model: string; region: string; client?: Sender }) {
    this.model = options.model;
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  }

  async embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += COHERE_BATCH) {
      const response = (await this.client.send(
        new InvokeModelCommand({
          modelId: this.model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            texts: texts.slice(i, i + COHERE_BATCH),
            // Cohere embeds a question and a passage differently, for search.
            input_type: purpose === 'query' ? 'search_query' : 'search_document',
            truncate: 'END',
          }),
        }),
      )) as { body: Uint8Array };
      const parsed = cohereResponseSchema.parse(
        JSON.parse(new TextDecoder().decode(response.body)),
      );
      out.push(...parsed.embeddings);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Object storage: S3, encrypted at rest, with short-lived links for playback

export class S3ObjectStorage {
  readonly bucket: string;
  private readonly client: Sender;

  constructor(options: { bucket: string; region: string; client?: Sender }) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // SSE-S3; the bucket also encrypts by default (Terraform, phase 9).
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string };
      if (!response.Body) return null;
      return {
        bytes: await response.Body.transformToByteArray(),
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey')
        return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * A presigned GET for the browser, valid for `expiresIn` seconds. Content
   * type and disposition are fixed in the signature, so a customer's HTML or
   * SVG downloads instead of rendering.
   */
  signedUrl(
    key: string,
    options: { contentType: string; inline: boolean; expiresIn: number },
  ): Promise<string> {
    return getSignedUrl(
      // The presigner needs the real client type; tests pass an S3Client too.
      this.client as unknown as S3Client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.inline ? options.contentType : 'application/octet-stream',
        ResponseContentDisposition: options.inline ? 'inline' : 'attachment',
      }),
      { expiresIn: options.expiresIn },
    );
  }
}

// ---------------------------------------------------------------------------
// Speech to text: Amazon Transcribe batch, reading our S3 copy (D-091)

const FORMATS: Record<string, MediaFormat> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

const transcriptFileSchema = z.object({
  results: z.object({
    transcripts: z.array(z.object({ transcript: z.string() })),
  }),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TranscribeSpeechToText implements SpeechToText {
  readonly engine = 'transcribe' as const;
  private readonly jobs: Sender;
  private readonly s3: Sender;
  private readonly bucket: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly wait: (ms: number) => Promise<unknown>;

  constructor(options: {
    bucket: string;
    region: string;
    transcribe?: Sender;
    s3?: Sender;
    pollMs?: number;
    timeoutMs?: number;
    wait?: (ms: number) => Promise<unknown>;
  }) {
    this.bucket = options.bucket;
    this.jobs = options.transcribe ?? new TranscribeClient({ region: options.region });
    this.s3 = options.s3 ?? new S3Client({ region: options.region });
    this.pollMs = options.pollMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.wait = options.wait ?? sleep;
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    const match = /^tenants\/([0-9a-f-]{36})\/media\/([0-9a-f-]{36})$/.exec(input.storageKey);
    if (!match) throw new TranscriptionError('voice note is not in media storage');
    const [, tenantId, messageId] = match;
    const format = FORMATS[input.mimeType.split(';')[0]?.trim() ?? ''];
    if (!format) throw new TranscriptionError(`audio format ${input.mimeType} is not supported`);
    // One job per voice note: a retry finds the job already running and waits for it.
    const jobName = `voice-${messageId ?? ''}`;
    const outputKey = `tenants/${tenantId ?? ''}/transcripts/${messageId ?? ''}.json`;
    const codes = input.languages.map((l) => TRANSCRIBE_CODES[l] as TranscribeLanguage);

    try {
      await this.jobs.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          Media: { MediaFileUri: `s3://${this.bucket}/${input.storageKey}` },
          MediaFormat: format,
          // One language: no identification. Several: identify among them only.
          ...(codes.length === 1
            ? { LanguageCode: codes[0] }
            : { IdentifyLanguage: true, LanguageOptions: codes }),
          OutputBucketName: this.bucket,
          OutputKey: outputKey,
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConflictException') throw error;
    }

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const { TranscriptionJob: job } = (await this.jobs.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
      )) as {
        TranscriptionJob?: {
          TranscriptionJobStatus?: string;
          LanguageCode?: string;
          IdentifiedLanguageScore?: number;
          FailureReason?: string;
        };
      };
      const status = job?.TranscriptionJobStatus;
      if (status === 'FAILED') {
        await this.cleanUp(jobName, outputKey);
        throw new TranscriptionError(
          `Transcribe failed: ${job?.FailureReason ?? 'no reason given'}`,
        );
      }
      if (status === 'COMPLETED') {
        const text = await this.readTranscript(outputKey);
        await this.cleanUp(jobName, outputKey);
        const language = job?.LanguageCode ? fromTranscribeCode(job.LanguageCode) : null;
        if (!language)
          throw new TranscriptionError(`unexpected language ${job?.LanguageCode ?? 'none'}`);
        if (!text.trim()) throw new TranscriptionError('no speech in the note');
        return { text: text.trim(), language, confidence: job?.IdentifiedLanguageScore ?? null };
      }
      // Still queued or in progress: the job is retried later and finds it again.
      if (Date.now() > deadline)
        throw new Error(`transcription ${jobName} still ${status ?? 'unknown'}`);
      await this.wait(this.pollMs);
    }
  }

  private async readTranscript(key: string): Promise<string> {
    const response = (await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: { transformToString(): Promise<string> } };
    if (!response.Body) throw new Error('transcript file is empty');
    const file = transcriptFileSchema.parse(JSON.parse(await response.Body.transformToString()));
    return file.results.transcripts.map((t) => t.transcript).join(' ');
  }

  /** The transcript is stored on the message; the file and job are not kept. */
  private async cleanUp(jobName: string, key: string): Promise<void> {
    await Promise.allSettled([
      this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
      this.jobs.send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Text to speech: Amazon Polly, ogg_opus at 48 kHz (D-072)

/** Polly errors a retry cannot fix; the reply then goes as text. */
const POLLY_PERMANENT = new Set([
  'ValidationException',
  'TextLengthExceededException',
  'LanguageNotSupportedException',
  'EngineNotSupportedException',
  'InvalidSampleRateException',
  'AccessDeniedException',
]);

export class PollyTextToSpeech implements TextToSpeech {
  readonly engine = 'polly' as const;
  private readonly client: Sender;

  constructor(options: { region: string; client?: Sender }) {
    this.client = options.client ?? new PollyClient({ region: options.region });
  }

  async synthesize(input: { text: string; voice: PollyVoice }): Promise<SpeechAudio> {
    try {
      const response = (await this.client.send(
        new SynthesizeSpeechCommand({
          Engine: input.voice.engine,
          VoiceId: input.voice.voiceId as VoiceId,
          LanguageCode: input.voice.languageCode as PollyLanguage,
          OutputFormat: 'ogg_opus',
          SampleRate: '48000',
          TextType: 'text',
          Text: input.text,
        }),
      )) as { AudioStream?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!response.AudioStream) throw new SynthesisError('Polly returned no audio');
      return {
        bytes: await response.AudioStream.transformToByteArray(),
        mimeType: VOICE_NOTE_MIME_TYPE,
      };
    } catch (error) {
      const name = (error as { name?: string }).name ?? '';
      if (POLLY_PERMANENT.has(name)) throw new SynthesisError(`Polly: ${name}`);
      throw error;
    }
  }
}
