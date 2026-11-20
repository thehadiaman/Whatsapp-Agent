import { MockChatModel, type ChatModel, type ModelRequest } from '@app/assistant';
import { schema } from '@app/db';
import {
  MockSpeechToText,
  readMockVoiceNote,
  SynthesisError,
  type SpeechToText,
  type SpokenLanguage,
  type TextToSpeech,
  type TranscribeInput,
  type Transcript,
} from '@app/voice';
import type { Job } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { VoiceDeps } from '../src/config.js';
import { enqueueKnowledge } from '../src/queues.js';
import { transcribeVoiceNote } from '../src/voice.js';
import { startHarness, waitFor, type Harness } from './harness.js';

let h: Harness;

afterEach(async () => {
  await h.close();
});

/** Records what the model was asked, and answers like the mock model. */
class RecordingModel implements ChatModel {
  readonly name = 'mock';
  readonly requests: ModelRequest[] = [];
  private readonly inner = new MockChatModel();
  complete(request: ModelRequest): Promise<unknown> {
    this.requests.push(request);
    return this.inner.complete(request);
  }
}

/** Speech to text that waits until the test lets it answer. */
class GatedSpeechToText implements SpeechToText {
  readonly engine = 'simulator' as const;
  calls = 0;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  private readonly inner = new MockSpeechToText();
  release(): void {
    this.open();
  }
  async transcribe(input: TranscribeInput): Promise<Transcript> {
    this.calls += 1;
    await this.gate;
    return this.inner.transcribe(input);
  }
}

async function start(
  options: {
    languages?: SpokenLanguage[];
    voiceReplies?: boolean;
    model?: ChatModel;
    voice?: Partial<VoiceDeps>;
  } = {},
) {
  h = await startHarness({
    sweepIntervalMs: 3_600_000,
    assistant: options.model ? { model: options.model } : {},
    ...(options.voice ? { voice: options.voice } : {}),
  });
  await h.migrator.db
    .update(schema.tenants)
    .set({
      name: 'Kayal Bakes',
      assistantSummary: 'A home bakery in Kochi: cakes, cupcakes and cookies to order.',
      languages: options.languages ?? ['en', 'ml'],
      voiceReplies: options.voiceReplies ?? true,
    })
    .where(eq(schema.tenants.id, h.tenant.id));
  const [faq] = await h.migrator.db
    .insert(schema.knowledgeSources)
    .values({
      tenantId: h.tenant.id,
      kind: 'faq',
      title: 'Do you make eggless cakes?',
      answer: 'Yes, every cake can be made eggless at no extra charge.',
    })
    .returning();
  await enqueueKnowledge(h.deps.queues, { tenantId: h.tenant.id, sourceId: faq!.id, version: 1 });
  await waitFor('faq read', async () => {
    const [s] = await h.migrator.db
      .select({ status: schema.knowledgeSources.status })
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, faq!.id));
    return s?.status === 'ready';
  });
}

function speak(text: string, language: SpokenLanguage, index = 0) {
  h.sim.sendInbound([{ customerId: h.customers[index]!.id, type: 'audio', text, language }]);
}

const phoneReplies = (index = 0) =>
  h.sim.state.thread(h.customers[index]!.id).filter((m) => m.direction === 'out');

async function messages() {
  return h.migrator.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.tenantId, h.tenant.id))
    .orderBy(asc(schema.messages.createdAt));
}

async function inbound() {
  return (await messages()).filter((m) => m.direction === 'inbound');
}

async function outbound() {
  return (await messages()).filter((m) => m.direction === 'outbound');
}

async function turns() {
  return h.migrator.db
    .select()
    .from(schema.assistantTurns)
    .where(eq(schema.assistantTurns.tenantId, h.tenant.id));
}

describe('voice notes in', () => {
  it('copies, transcribes and answers a voice note, and speaks the reply back', async () => {
    await start();
    speak('Do you make eggless cakes?', 'en');

    await waitFor('a reply on the phone', () =>
      Promise.resolve(phoneReplies().some((m) => m.status === 'delivered')),
    );
    const [note] = await inbound();
    expect(note).toMatchObject({ kind: 'audio', body: null });
    expect(note!.media).toMatchObject({ voice: true, mimeType: 'audio/ogg; codecs=opus' });
    expect(note!.media!.storageKey).toMatch(/^tenants\/.+\/media\//);
    // Its length is read from the file, so the inbox can show it before playing.
    expect(note!.media!.durationMs).toBeGreaterThan(1_000);
    expect(note!.transcript).toEqual({
      status: 'done',
      text: 'Do you make eggless cakes?',
      language: 'en',
      engine: 'simulator',
      confidence: null,
    });

    // The customer hears the answer: a voice note (OGG/Opus, voice: true) that says it.
    const [heard] = phoneReplies();
    expect(heard).toMatchObject({ type: 'audio' });
    expect(heard!.text).toBe('Yes, every cake can be made eggless at no extra charge.');

    // Our copy keeps the text, the voice and the audio (brief §4: always store the text).
    const [reply] = await outbound();
    expect(reply).toMatchObject({
      kind: 'audio',
      senderType: 'assistant',
      body: 'Yes, every cake can be made eggless at no extra charge.',
    });
    expect(reply!.speech).toMatchObject({
      language: 'en',
      voiceId: 'Kajal',
      fallback: null,
      engine: 'mock',
    });
    expect(reply!.speech!.durationMs).toBeGreaterThan(1_000);
    const audio = await h.deps.storage.get(reply!.media!.storageKey!);
    expect(readMockVoiceNote(audio!.bytes)?.text).toBe(reply!.body);
    expect((await turns())[0]).toMatchObject({ outcome: 'replied', basis: 'knowledge' });
  });

  it('answers Malayalam in text: Polly has no Malayalam voice', async () => {
    await start();
    speak('ഈ കേക്കിൽ മുട്ട ഉണ്ടോ?', 'ml');
    await waitFor('a reply', async () => (await outbound()).length === 1);
    const [reply] = await outbound();
    expect(reply).toMatchObject({ kind: 'text' });
    expect(reply!.speech).toEqual({ language: 'ml', voiceId: null, fallback: 'no_voice' });
    expect(reply!.media).toBeNull();
    await waitFor('sent', () => Promise.resolve(phoneReplies().length === 1));
    expect(phoneReplies()[0]).toMatchObject({ type: 'text' });
  });

  it('replies in text when the business has voice replies off', async () => {
    await start({ voiceReplies: false });
    speak('Do you make eggless cakes?', 'en');
    await waitFor('a reply', async () => (await outbound()).length === 1);
    expect((await outbound())[0]).toMatchObject({ kind: 'text', speech: null });
  });

  it('hands a note it cannot transcribe to a person, without guessing what was said', async () => {
    // Arabic is not one of this business's languages, so it is not identified.
    await start({ languages: ['en', 'ml'] });
    speak('هل الكعكة بدون بيض؟', 'ar');
    await waitFor('a turn', async () => (await turns()).length === 1);
    const [note] = await inbound();
    expect(note!.transcript).toMatchObject({ status: 'failed' });
    expect((note!.transcript as { reason: string }).reason).toMatch(/not one of this business/);
    const [turn] = await turns();
    expect(turn).toMatchObject({ outcome: 'handed_off', modelCalls: 0 });
    const [conversation] = await h.migrator.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.tenantId, h.tenant.id));
    expect(conversation!.state).toBe('waiting_for_human');
    // The notice is written, not spoken: nothing was understood to speak back to.
    expect((await outbound())[0]).toMatchObject({ kind: 'text', speech: null });
  });

  it('waits for the transcript when text follows a voice note, then answers both once', async () => {
    const stt = new GatedSpeechToText();
    const model = new RecordingModel();
    await start({ voice: { stt }, model });
    speak('Do you make eggless cakes?', 'en');
    await waitFor('transcription started', () => Promise.resolve(stt.calls === 1));
    h.sim.sendInbound([{ customerId: h.customers[0]!.id, type: 'text', text: 'for Saturday' }]);
    await waitFor('both stored', async () => (await inbound()).length === 2);
    // The text's own turn finds the note still pending and stands aside.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await turns()).toHaveLength(0);

    stt.release();
    await waitFor('one turn', async () => (await turns()).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = await turns();
    expect(all).toHaveLength(1);
    const [, text] = await inbound();
    expect(all[0]!.triggerMessageId).toBe(text!.id);
    const asked = JSON.stringify(model.requests[0]!.messages);
    expect(asked).toContain('[Voice note] Do you make eggless cakes?');
    expect(asked).toContain('for Saturday');
    // The newest message was typed, so the reply is typed too.
    expect((await outbound())[0]).toMatchObject({ kind: 'text' });
  });

  it('retries a transcription that failed for a passing reason', async () => {
    let calls = 0;
    const inner = new MockSpeechToText();
    const flaky: SpeechToText = {
      engine: 'simulator',
      transcribe: (input) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('socket hang up')) : inner.transcribe(input);
      },
    };
    await start({ voice: { stt: flaky } });
    speak('Do you make eggless cakes?', 'en');
    await waitFor('transcribed', async () => (await inbound())[0]?.transcript?.status === 'done');
    expect(calls).toBe(2);
  });
});

describe('voice replies out', () => {
  it('sends the reply as text when speech cannot be made', async () => {
    const broken: TextToSpeech = {
      engine: 'polly',
      synthesize: () => Promise.reject(new SynthesisError('voice unavailable')),
    };
    await start({ voice: { tts: broken } });
    speak('Do you make eggless cakes?', 'en');
    await waitFor('delivered', () =>
      Promise.resolve(phoneReplies().some((m) => m.status === 'delivered')),
    );
    expect(phoneReplies()[0]).toMatchObject({
      type: 'text',
      text: 'Yes, every cake can be made eggless at no extra charge.',
    });
    expect((await outbound())[0]).toMatchObject({
      kind: 'text',
      speech: { language: 'en', voiceId: 'Kajal', fallback: 'synthesis_failed' },
    });
  });
});

describe('tenant isolation', () => {
  it("a transcription job naming another tenant's voice note does nothing", async () => {
    const stt = new GatedSpeechToText();
    await start({ voice: { stt } });
    speak('Do you make eggless cakes?', 'en');
    await waitFor('transcription started', () => Promise.resolve(stt.calls === 1));
    const [note] = await inbound();
    const other = await h.createTenant();

    const job = {
      data: { tenantId: other.id, messageId: note!.id },
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as unknown as Job;
    await transcribeVoiceNote(h.deps, job);
    // Row-level security hid the note: no transcription ran, nothing changed.
    expect(stt.calls).toBe(1);
    const [still] = await h.migrator.db
      .select({ transcript: schema.messages.transcript })
      .from(schema.messages)
      .where(and(eq(schema.messages.id, note!.id)));
    expect(still!.transcript).toEqual({ status: 'pending' });

    stt.release();
    await waitFor('transcribed', async () => (await inbound())[0]?.transcript?.status === 'done');
  });
});
