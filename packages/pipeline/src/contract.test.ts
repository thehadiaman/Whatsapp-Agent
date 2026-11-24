import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRequest,
  completeValidated,
  MockChatModel,
  MockEmbedder,
  type ChatModel,
  type Embedder,
} from '@app/assistant';
import {
  BedrockChatModel,
  BedrockEmbedder,
  PollyTextToSpeech,
  S3ObjectStorage,
  TranscribeSpeechToText,
} from '@app/live';
import {
  MockSpeechToText,
  MockTextToSpeech,
  POLLY_VOICES,
  readOggOpus,
  type SpeechToText,
  type TextToSpeech,
} from '@app/voice';
import { describe, expect, it } from 'vitest';
import { LocalDiskStorage, mediaKey, type ObjectStorage } from './storage.js';

/**
 * One contract, two kinds of adapter (brief §5). The mock adapters run in
 * every `make check`. The live ones call Amazon Bedrock, S3, Transcribe and
 * Polly, which costs money, so they run only when asked:
 *
 *   LIVE_CONTRACT=1 AWS_REGION=ap-south-1 MEDIA_BUCKET=<a test bucket> \
 *     pnpm --filter @app/pipeline run contract:live
 *
 * with AWS credentials in the environment. CI never sets LIVE_CONTRACT.
 */
const LIVE = process.env['LIVE_CONTRACT'] === '1';
const region = process.env['AWS_REGION'] ?? 'ap-south-1';
const bucket = process.env['MEDIA_BUCKET'] ?? '';

interface Adapters {
  model: ChatModel;
  embedder: Embedder;
  storage: ObjectStorage;
  stt: SpeechToText;
  tts: TextToSpeech;
}

const suites: [string, () => Adapters, boolean][] = [
  [
    'mock',
    () => ({
      model: new MockChatModel(),
      embedder: new MockEmbedder(),
      storage: new LocalDiskStorage(mkdtempSync(join(tmpdir(), 'contract-'))),
      stt: new MockSpeechToText(),
      tts: new MockTextToSpeech(),
    }),
    true,
  ],
  [
    'live',
    () => ({
      model: new BedrockChatModel({
        model: process.env['BEDROCK_CHAT_MODEL'] ?? 'global.anthropic.claude-haiku-5-5',
        region,
      }),
      embedder: new BedrockEmbedder({
        model: process.env['BEDROCK_EMBED_MODEL'] ?? 'cohere.embed-multilingual-v3',
        region,
      }),
      storage: new S3ObjectStorage({ bucket, region }),
      stt: new TranscribeSpeechToText({ bucket, region }),
      tts: new PollyTextToSpeech({ region }),
    }),
    LIVE,
  ],
];

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  return dot / Math.sqrt(na * nb);
};

for (const [name, make, enabled] of suites) {
  describe.skipIf(!enabled)(`${name} adapters`, () => {
    const a = enabled ? make() : (null as unknown as Adapters);
    const tenant = randomUUID();

    it('the model answers a grounded question in the agreed shape', async () => {
      const request = buildRequest({
        business: {
          name: 'Qamar Phone Corner',
          summary: 'A phone shop in Karama, Dubai.',
          timezone: 'Asia/Dubai',
        },
        history: [],
        pending: ['Is the screen guard covered by the warranty?'],
        passages: [
          {
            id: 'p1',
            sourceId: 's1',
            sourceTitle: 'Warranty',
            heading: null,
            text: 'Screen guards are not covered by the warranty.',
            score: 0.9,
          },
        ],
        today: '2026-11-20',
        maxTokens: 512,
      });
      const response = await completeValidated(a.model, request);
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      if (response.result.type === 'answer')
        expect(response.result.answer.reply.length).toBeGreaterThan(0);
    }, 60_000);

    it('embeddings have 1,024 dimensions, and a question is nearer its answer', async () => {
      const [question] = await a.embedder.embed(
        ['is the screen guard covered by warranty'],
        'query',
      );
      const [answer, other] = await a.embedder.embed(
        [
          'Screen guards are not covered by the warranty.',
          'We deliver birthday cakes across Kochi.',
        ],
        'document',
      );
      expect(question).toHaveLength(1024);
      expect(cosine(question!, answer!)).toBeGreaterThan(cosine(question!, other!));
    }, 60_000);

    it('storage keeps, returns and forgets an object', async () => {
      const key = mediaKey(tenant, randomUUID());
      await a.storage.put(key, new TextEncoder().encode('hello'), 'text/plain');
      const back = await a.storage.get(key);
      expect(new TextDecoder().decode(back!.bytes)).toBe('hello');
      await a.storage.delete(key);
      expect(await a.storage.get(key)).toBeNull();
    }, 60_000);

    it('speech goes out as a playable Ogg Opus voice note, and comes back as words', async () => {
      const audio = await a.tts.synthesize({
        text: 'Your phone is ready for pickup.',
        voice: POLLY_VOICES.en!,
      });
      expect(audio.mimeType).toBe('audio/ogg; codecs=opus');
      expect(readOggOpus(audio.bytes).durationMs).toBeGreaterThan(500);
      expect(audio.bytes.byteLength).toBeLessThan(512 * 1024);

      // The same path as a customer's note: stored first, then transcribed.
      const key = mediaKey(tenant, randomUUID());
      await a.storage.put(key, audio.bytes, audio.mimeType);
      try {
        const transcript = await a.stt.transcribe({
          audio: audio.bytes,
          mimeType: audio.mimeType,
          storageKey: key,
          languages: ['en', 'hi'],
        });
        expect(transcript.language).toBe('en');
        expect(transcript.text.toLowerCase()).toContain('ready');
      } finally {
        await a.storage.delete(key);
      }
    }, 180_000);
  });
}
