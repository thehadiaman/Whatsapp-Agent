import { completeValidated, ModelUnavailableError, type ModelRequest } from '@app/assistant';
import { POLLY_VOICES, SynthesisError, TranscriptionError } from '@app/voice';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  BedrockChatModel,
  BedrockEmbedder,
  finalJson,
  PollyTextToSpeech,
  S3ObjectStorage,
  TranscribeSpeechToText,
  type MessagesClient,
  type Sender,
} from '../src/index.js';

/** Records each SDK command's class name and input, and answers from a script. */
function fake(answer: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const sender: Sender = {
    send: (command) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ name: c.constructor.name, input: c.input });
      try {
        return Promise.resolve(answer(c.constructor.name, c.input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { sender, calls };
}

const awsError = (name: string) => Object.assign(new Error(name), { name });
const bytes = (text: string) => new TextEncoder().encode(text);

describe('Claude on Bedrock', () => {
  const request: ModelRequest = {
    system: 'You are the assistant for Qamar Phone Corner.',
    maxTokens: 512,
    tools: [
      { name: 'lookup_order', description: 'Looks up an order.', inputSchema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Where is KB-2291?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'lookup_order', input: { order_number: 'KB-2291' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: '{"found":true}', isError: false },
        ],
      },
    ],
  };

  /** A fake client that answers `reply`, or fails with `error`. */
  function model(reply: unknown, error?: Error) {
    const sent: unknown[] = [];
    const client: MessagesClient = {
      messages: {
        create: (params) => {
          sent.push(params);
          return error ? Promise.reject(error) : Promise.resolve(reply);
        },
      },
    };
    return {
      model: new BedrockChatModel({
        model: 'global.anthropic.claude-haiku-5-5',
        region: 'ap-south-1',
        client,
      }),
      sent,
    };
  }

  it('sends the Messages API shape: system, tools with input_schema, tool results', async () => {
    const { model: m, sent } = model({
      content: [{ type: 'text', text: '{"reply":"It shipped with Aramex.","basis":"order"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2341, output_tokens: 118 },
    });
    const response = await completeValidated(m, request);
    expect(response).toEqual({
      model: 'global.anthropic.claude-haiku-5-5',
      usage: { inputTokens: 2341, outputTokens: 118 },
      result: { type: 'answer', answer: { reply: 'It shipped with Aramex.', basis: 'order' } },
    });
    expect(sent[0]).toMatchObject({
      model: 'global.anthropic.claude-haiku-5-5',
      max_tokens: 512,
      system: 'You are the assistant for Qamar Phone Corner.',
      tools: [{ name: 'lookup_order', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup_order' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] },
      ],
    });
  });

  it('returns tool calls when the model stops to use a tool', async () => {
    const { model: m } = model({
      content: [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup_order',
          input: { order_number: 'KB-2291' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect((await completeValidated(m, request)).result).toEqual({
      type: 'tool_calls',
      calls: [{ id: 'toolu_1', name: 'lookup_order', input: { order_number: 'KB-2291' } }],
    });
  });

  it('a reply with no JSON fails validation, so the turn hands over', async () => {
    const { model: m } = model({
      content: [{ type: 'text', text: 'I am not able to help with that.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(completeValidated(m, request)).rejects.toThrow();
  });

  it('no access or a wrong model hands over at once; throttling is retried', async () => {
    const denied = model(
      null,
      Object.assign(new Error('You do not have access to the model'), { status: 403 }),
    );
    await expect(denied.model.complete(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    const throttled = model(null, Object.assign(new Error('Too many requests'), { status: 429 }));
    const error: unknown = await throttled.model.complete(request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ModelUnavailableError);
  });

  it('finds the final JSON object after prose, and nothing when there is none', () => {
    expect(finalJson('Sure! {"reply":"Yes {really}","basis":"none"}')).toEqual({
      reply: 'Yes {really}',
      basis: 'none',
    });
    expect(finalJson('no json here')).toBeUndefined();
    expect(finalJson('{"a":1} then {"b":2}')).toEqual({ b: 2 });
  });
});

describe('Cohere embeddings on Bedrock', () => {
  it('embeds documents and queries differently, in batches of 96', async () => {
    const { sender, calls } = fake((_name, input) => {
      const body = JSON.parse(String(input['body'])) as { texts: string[] };
      return { body: bytes(JSON.stringify({ embeddings: body.texts.map(() => [0.1, 0.2]) })) };
    });
    const embedder = new BedrockEmbedder({
      model: 'cohere.embed-multilingual-v3',
      region: 'ap-south-1',
      client: sender,
    });
    const vectors = await embedder.embed(
      Array.from({ length: 100 }, (_, i) => `passage ${String(i)}`),
      'document',
    );
    expect(vectors).toHaveLength(100);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: 'InvokeModelCommand',
      input: { modelId: 'cohere.embed-multilingual-v3' },
    });
    expect(JSON.parse(String(calls[0]!.input['body']))).toMatchObject({
      input_type: 'search_document',
      truncate: 'END',
    });
    await embedder.embed(['where is my order'], 'query');
    expect(JSON.parse(String(calls[2]!.input['body']))).toMatchObject({
      input_type: 'search_query',
    });
  });
});

describe('S3 storage', () => {
  it('encrypts what it stores, and a missing object reads as null', async () => {
    const { sender, calls } = fake((name) => {
      if (name === 'GetObjectCommand') throw awsError('NoSuchKey');
      return {};
    });
    const storage = new S3ObjectStorage({
      bucket: 'desk-media',
      region: 'ap-south-1',
      client: sender,
    });
    await storage.put('tenants/x/media/y', bytes('hi'), 'image/png');
    expect(calls[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'desk-media',
        Key: 'tenants/x/media/y',
        ContentType: 'image/png',
        ServerSideEncryption: 'AES256',
      },
    });
    expect(await storage.get('tenants/x/media/z')).toBeNull();
  });

  it('signs a short-lived link that fixes the content type and disposition', async () => {
    // Signing is local: fake credentials, no network.
    const client = new S3Client({
      region: 'ap-south-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const storage = new S3ObjectStorage({ bucket: 'desk-media', region: 'ap-south-1', client });
    const inline = new URL(
      await storage.signedUrl('tenants/x/media/y', {
        contentType: 'audio/ogg; codecs=opus',
        inline: true,
        expiresIn: 300,
      }),
    );
    expect(inline.hostname).toBe('desk-media.s3.ap-south-1.amazonaws.com');
    expect(inline.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(inline.searchParams.get('response-content-disposition')).toBe('inline');
    const download = new URL(
      await storage.signedUrl('tenants/x/media/y', {
        contentType: 'text/html',
        inline: false,
        expiresIn: 300,
      }),
    );
    expect(download.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(download.searchParams.get('response-content-disposition')).toBe('attachment');
  });
});

describe('Amazon Transcribe', () => {
  const T = '0b5f0a3e-6f1e-4d3c-9a8b-0c1d2e3f4a5b';
  const M = '1c6e1b4f-7a2f-4e4d-8b9c-1d2e3f4a5b6c';
  const key = `tenants/${T}/media/${M}`;
  const input = (
    languages: ('en' | 'hi' | 'ml' | 'ar')[],
    mimeType = 'audio/ogg; codecs=opus',
  ) => ({
    audio: new Uint8Array(),
    mimeType,
    storageKey: key,
    languages,
  });

  function service(job: Record<string, unknown>[], transcript = 'Is the cake eggless?') {
    let polls = 0;
    const transcribe = fake((name) => {
      if (name === 'GetTranscriptionJobCommand')
        return { TranscriptionJob: job[Math.min(polls++, job.length - 1)] };
      return {};
    });
    const s3 = fake((name) =>
      name === 'GetObjectCommand'
        ? {
            Body: {
              transformToString: () =>
                Promise.resolve(JSON.stringify({ results: { transcripts: [{ transcript }] } })),
            },
          }
        : {},
    );
    const stt = new TranscribeSpeechToText({
      bucket: 'desk-media',
      region: 'ap-south-1',
      transcribe: transcribe.sender,
      s3: s3.sender,
      pollMs: 1,
      timeoutMs: 50,
      wait: () => Promise.resolve(),
    });
    return { stt, transcribe: transcribe.calls, s3: s3.calls };
  }

  it('identifies the language among the business languages, then reads and deletes the transcript', async () => {
    const { stt, transcribe, s3 } = service([
      { TranscriptionJobStatus: 'IN_PROGRESS' },
      { TranscriptionJobStatus: 'COMPLETED', LanguageCode: 'ml-IN', IdentifiedLanguageScore: 0.91 },
    ]);
    expect(await stt.transcribe(input(['en', 'ml']))).toEqual({
      text: 'Is the cake eggless?',
      language: 'ml',
      confidence: 0.91,
    });
    expect(transcribe[0]).toMatchObject({
      name: 'StartTranscriptionJobCommand',
      input: {
        TranscriptionJobName: `voice-${M}`,
        Media: { MediaFileUri: `s3://desk-media/${key}` },
        MediaFormat: 'ogg',
        IdentifyLanguage: true,
        LanguageOptions: ['en-IN', 'ml-IN'],
        OutputBucketName: 'desk-media',
        OutputKey: `tenants/${T}/transcripts/${M}.json`,
      },
    });
    expect(transcribe[0]!.input['LanguageCode']).toBeUndefined();
    expect(s3.map((c) => c.name)).toEqual(['GetObjectCommand', 'DeleteObjectCommand']);
    expect(transcribe.at(-1)?.name).toBe('DeleteTranscriptionJobCommand');
  });

  it('with one language, names it instead of identifying', async () => {
    const { stt, transcribe } = service([
      { TranscriptionJobStatus: 'COMPLETED', LanguageCode: 'en-IN' },
    ]);
    await stt.transcribe(input(['en']));
    expect(transcribe[0]!.input).toMatchObject({ LanguageCode: 'en-IN' });
    expect(transcribe[0]!.input['IdentifyLanguage']).toBeUndefined();
  });

  it('a failed job or an unsupported format fails for good; a slow job is retried later', async () => {
    const failed = service([{ TranscriptionJobStatus: 'FAILED', FailureReason: 'Invalid media' }]);
    await expect(failed.stt.transcribe(input(['en']))).rejects.toBeInstanceOf(TranscriptionError);
    await expect(service([]).stt.transcribe(input(['en'], 'audio/aac'))).rejects.toBeInstanceOf(
      TranscriptionError,
    );
    const slow = service([{ TranscriptionJobStatus: 'IN_PROGRESS' }]);
    const error: unknown = await slow.stt.transcribe(input(['en'])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TranscriptionError);
  });

  it('a retry finds the job already started and waits for it', async () => {
    let started = false;
    const transcribe = fake((name) => {
      if (name === 'StartTranscriptionJobCommand') {
        if (!started) throw awsError('ConflictException');
        started = true;
      }
      if (name === 'GetTranscriptionJobCommand')
        return { TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED', LanguageCode: 'hi-IN' } };
      return {};
    });
    const s3 = fake(() => ({
      Body: {
        transformToString: () =>
          Promise.resolve('{"results":{"transcripts":[{"transcript":"हाँ"}]}}'),
      },
    }));
    const stt = new TranscribeSpeechToText({
      bucket: 'b',
      region: 'ap-south-1',
      transcribe: transcribe.sender,
      s3: s3.sender,
      wait: () => Promise.resolve(),
    });
    expect(await stt.transcribe(input(['en', 'hi']))).toMatchObject({ text: 'हाँ', language: 'hi' });
  });
});

describe('Amazon Polly', () => {
  it('asks for ogg_opus at 48 kHz with the neural voice and its language', async () => {
    const { sender, calls } = fake(() => ({
      AudioStream: { transformToByteArray: () => Promise.resolve(bytes('OggS')) },
    }));
    const audio = await new PollyTextToSpeech({ region: 'ap-south-1', client: sender }).synthesize({
      text: 'Haan, bilkul.',
      voice: POLLY_VOICES.hi!,
    });
    expect(audio.mimeType).toBe('audio/ogg; codecs=opus');
    expect(calls[0]!.input).toEqual({
      Engine: 'neural',
      VoiceId: 'Kajal',
      LanguageCode: 'hi-IN',
      OutputFormat: 'ogg_opus',
      SampleRate: '48000',
      TextType: 'text',
      Text: 'Haan, bilkul.',
    });
  });

  it('a request Polly rejects becomes SynthesisError, so the reply goes as text', async () => {
    const { sender } = fake(() => {
      throw awsError('TextLengthExceededException');
    });
    await expect(
      new PollyTextToSpeech({ region: 'ap-south-1', client: sender }).synthesize({
        text: 'x',
        voice: POLLY_VOICES.en!,
      }),
    ).rejects.toBeInstanceOf(SynthesisError);
  });
});
