import { MOCK_CLIP_BASE64 } from './clip.js';
import { OggError, readOggOpus, withComments } from './ogg.js';
import {
  fromTranscribeCode,
  TRANSCRIBE_CODES,
  VOICE_NOTE_MIME_TYPE,
  type PollyVoice,
  type SpokenLanguage,
} from './voices.js';

export interface Transcript {
  text: string;
  language: SpokenLanguage;
  /** Language identification confidence, 0 to 1, when the engine gives one. */
  confidence: number | null;
}

export interface TranscribeInput {
  audio: Uint8Array;
  mimeType: string;
  /** Where the file is in object storage: Transcribe reads it from S3 there. */
  storageKey: string;
  /** The business's languages: language identification picks only among these. */
  languages: readonly SpokenLanguage[];
}

/** Speech to text. Live: Amazon Transcribe. Mock: the transcript the simulator attached. */
export interface SpeechToText {
  /** Shown in the inbox: "Transcribed by Amazon Transcribe" or "Transcript from simulator". */
  readonly engine: 'transcribe' | 'simulator' | 'none';
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

/** Retrying will not help (unreadable audio, no speech, not configured). */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export interface SpeechAudio {
  bytes: Uint8Array;
  mimeType: string;
}

/** Text to speech. Live: Amazon Polly, `ogg_opus`. Mock: the bundled clip. */
export interface TextToSpeech {
  readonly engine: 'polly' | 'mock' | 'none';
  synthesize(input: { text: string; voice: PollyVoice }): Promise<SpeechAudio>;
}

/** Retrying will not help; the reply goes as text instead. */
export class SynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesisError';
  }
}

/** Comment keys that carry speech through a mock voice note (OpusTags). */
export const SPEECH_COMMENTS = {
  transcript: 'TRANSCRIPT',
  language: 'LANGUAGE',
  voice: 'VOICE',
} as const;

const clip = (): Uint8Array => Uint8Array.from(Buffer.from(MOCK_CLIP_BASE64, 'base64'));

/**
 * A mock voice note: the bundled clip carrying the words and language in its
 * comments. The simulator makes the customer's notes with it, and the mock
 * text-to-speech makes the business's.
 */
export function mockVoiceNote(input: {
  text: string;
  language: SpokenLanguage;
  voiceId?: string;
}): Uint8Array {
  return withComments(clip(), {
    [SPEECH_COMMENTS.transcript]: input.text,
    [SPEECH_COMMENTS.language]: TRANSCRIBE_CODES[input.language],
    ...(input.voiceId ? { [SPEECH_COMMENTS.voice]: input.voiceId } : {}),
  });
}

/** What a mock voice note says, or null if it carries no words. */
export function readMockVoiceNote(
  bytes: Uint8Array,
): { text: string; language: SpokenLanguage | null; durationMs: number } | null {
  try {
    const info = readOggOpus(bytes);
    const text = info.comments[SPEECH_COMMENTS.transcript];
    if (text === undefined) return null;
    const code = info.comments[SPEECH_COMMENTS.language];
    return {
      text,
      language: code ? fromTranscribeCode(code) : null,
      durationMs: info.durationMs,
    };
  } catch (error) {
    if (error instanceof OggError) return null;
    throw error;
  }
}

/**
 * Mock speech to text: reads the transcript the simulator wrote into the
 * voice note. Like Transcribe with language options, it can only answer in
 * one of the business's languages.
 */
export class MockSpeechToText implements SpeechToText {
  readonly engine = 'simulator' as const;

  transcribe(input: TranscribeInput): Promise<Transcript> {
    const note = readMockVoiceNote(input.audio);
    if (!note) {
      return Promise.reject(
        new TranscriptionError('no transcript attached (not a simulator voice note)'),
      );
    }
    if (!note.text.trim()) return Promise.reject(new TranscriptionError('no speech in the note'));
    if (!note.language || !input.languages.includes(note.language)) {
      return Promise.reject(
        new TranscriptionError(
          `spoken language ${note.language ?? 'unknown'} is not one of this business's languages`,
        ),
      );
    }
    return Promise.resolve({ text: note.text.trim(), language: note.language, confidence: null });
  }
}

/** Mock text to speech: the bundled clip, with the spoken words in its comments. */
export class MockTextToSpeech implements TextToSpeech {
  readonly engine = 'mock' as const;

  synthesize(input: { text: string; voice: PollyVoice }): Promise<SpeechAudio> {
    const language = fromTranscribeCode(input.voice.languageCode) ?? 'en';
    return Promise.resolve({
      bytes: mockVoiceNote({ text: input.text, language, voiceId: input.voice.voiceId }),
      mimeType: VOICE_NOTE_MIME_TYPE,
    });
  }
}

/** Live mode until the Transcribe adapter lands (phase 7): every note goes to a person. */
export class UnconfiguredSpeechToText implements SpeechToText {
  readonly engine = 'none' as const;

  transcribe(): Promise<Transcript> {
    return Promise.reject(new TranscriptionError('speech to text is not configured'));
  }
}

/** Live mode until the Polly adapter lands (phase 7): replies go as text. */
export class UnconfiguredTextToSpeech implements TextToSpeech {
  readonly engine = 'none' as const;

  synthesize(): Promise<SpeechAudio> {
    return Promise.reject(new SynthesisError('text to speech is not configured'));
  }
}
