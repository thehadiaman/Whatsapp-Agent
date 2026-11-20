import { describe, expect, it } from 'vitest';
import {
  MockSpeechToText,
  MockTextToSpeech,
  mockVoiceNote,
  OggError,
  POLLY_VOICES,
  readMockVoiceNote,
  readOggOpus,
  spokenLanguageOf,
  TranscriptionError,
  UnconfiguredSpeechToText,
  UnconfiguredTextToSpeech,
  withComments,
} from '../src/index.js';
import { MOCK_CLIP_BASE64 as CLIP } from '../src/clip.js';

const clip = () => Uint8Array.from(Buffer.from(CLIP, 'base64'));

describe('Ogg Opus comments', () => {
  it('reads the bundled clip: Opus, about 1.2 s', () => {
    const info = readOggOpus(clip());
    expect(info.durationMs).toBeGreaterThan(1_100);
    expect(info.durationMs).toBeLessThan(1_300);
  });

  it('writes comments that read back, in any script, with valid checksums', () => {
    const words = 'ഓർഡർ എപ്പോൾ എത്തും? متى يصل الطلب؟ ऑर्डर कब आएगा?';
    const out = withComments(clip(), { TRANSCRIPT: words, language: 'ml-IN' });
    // readOggOpus verifies every page's CRC.
    const info = readOggOpus(out);
    expect(info.comments['TRANSCRIPT']).toBe(words);
    expect(info.comments['LANGUAGE']).toBe('ml-IN');
    expect(info.durationMs).toBe(readOggOpus(clip()).durationMs);
  });

  it('replaces an existing comment rather than adding a second', () => {
    const once = withComments(clip(), { TRANSCRIPT: 'first' });
    const twice = withComments(once, { transcript: 'second' });
    expect(readOggOpus(twice).comments['TRANSCRIPT']).toBe('second');
  });

  it('spreads a long comment header over several pages and keeps the audio intact', () => {
    const long = 'x'.repeat(70_000); // over one page's 65,025 bytes
    const out = withComments(clip(), { TRANSCRIPT: long });
    expect(readOggOpus(out).comments['TRANSCRIPT']).toBe(long);
    // Rewriting it back down gives the same audio pages as the original.
    const back = withComments(out, { TRANSCRIPT: 'short' });
    expect(readOggOpus(back).durationMs).toBe(readOggOpus(clip()).durationMs);
  });

  it('rejects files that are not Ogg Opus, or are corrupted', () => {
    expect(() => readOggOpus(new TextEncoder().encode('ID3 not an ogg'))).toThrow(OggError);
    const broken = clip();
    broken[200] = (broken[200] ?? 0) ^ 0xff;
    expect(() => readOggOpus(broken)).toThrow(/checksum/);
    expect(() => readOggOpus(clip().subarray(0, 100))).toThrow(OggError);
  });
});

describe('mock speech', () => {
  const stt = new MockSpeechToText();
  const input = (audio: Uint8Array, languages = ['en', 'ml'] as const) => ({
    audio,
    mimeType: 'audio/ogg; codecs=opus',
    storageKey: 'tenants/x/media/y',
    languages,
  });

  it('transcribes what the simulator attached', async () => {
    const note = mockVoiceNote({ text: '  കേക്ക് നാളെ കിട്ടുമോ? ', language: 'ml' });
    await expect(stt.transcribe(input(note))).resolves.toEqual({
      text: 'കേക്ക് നാളെ കിട്ടുമോ?',
      language: 'ml',
      confidence: null,
    });
  });

  it('answers only in one of the business languages, like Transcribe with language options', async () => {
    const note = mockVoiceNote({ text: 'متى يصل الطلب؟', language: 'ar' });
    await expect(stt.transcribe(input(note))).rejects.toThrow(/not one of this business/);
  });

  it('fails permanently for audio with no transcript, or no speech', async () => {
    await expect(stt.transcribe(input(clip()))).rejects.toBeInstanceOf(TranscriptionError);
    await expect(stt.transcribe(input(new Uint8Array([1, 2, 3])))).rejects.toBeInstanceOf(
      TranscriptionError,
    );
    const silent = mockVoiceNote({ text: '   ', language: 'en' });
    await expect(stt.transcribe(input(silent))).rejects.toThrow(/no speech/);
  });

  it('speaks a reply as a voice note that says the text', async () => {
    const voice = POLLY_VOICES.hi;
    if (!voice) throw new Error('Hindi has a voice');
    const audio = await new MockTextToSpeech().synthesize({ text: 'Haan, bilkul.', voice });
    expect(audio.mimeType).toBe('audio/ogg; codecs=opus');
    expect(readMockVoiceNote(audio.bytes)).toMatchObject({ text: 'Haan, bilkul.', language: 'hi' });
    expect(readOggOpus(audio.bytes).comments['VOICE']).toBe('Kajal');
  });

  it('live adapters are not configured yet, and say so', async () => {
    await expect(new UnconfiguredSpeechToText().transcribe()).rejects.toBeInstanceOf(
      TranscriptionError,
    );
    await expect(new UnconfiguredTextToSpeech().synthesize()).rejects.toThrow(/not configured/);
  });
});

describe('voices', () => {
  it('has a Polly voice for English, Hindi and Gulf Arabic, and none for Malayalam', () => {
    expect(POLLY_VOICES.en?.voiceId).toBe('Kajal');
    expect(POLLY_VOICES.hi).toEqual({ voiceId: 'Kajal', languageCode: 'hi-IN', engine: 'neural' });
    expect(POLLY_VOICES.ar?.languageCode).toBe('ar-AE');
    expect(POLLY_VOICES.ml).toBeNull();
  });

  it('maps the detected language, Hinglish included, onto a spoken language', () => {
    expect(spokenLanguageOf('hi-Latn')).toBe('hi');
    expect(spokenLanguageOf('ml')).toBe('ml');
    expect(spokenLanguageOf('fr')).toBeNull();
  });
});
