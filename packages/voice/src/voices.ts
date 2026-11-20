/**
 * The spoken languages a business can choose (tenant settings) and how each
 * maps onto Amazon Transcribe and Amazon Polly. Checked against the AWS docs
 * on 2026-11-20 (Polly "Available voices" and "Bilingual voices"; Transcribe
 * "Supported languages"): see docs/DECISIONS.md D-072.
 */
export const SPOKEN_LANGUAGES = ['en', 'hi', 'ml', 'ar'] as const;
export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SpokenLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
  ml: 'Malayalam',
  ar: 'Arabic',
};

/**
 * Transcribe language codes (batch). One dialect per language: Indian
 * English, Hindi, Malayalam and Gulf Arabic, for shops in India and the Gulf.
 */
export const TRANSCRIBE_CODES: Record<SpokenLanguage, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  ml: 'ml-IN',
  ar: 'ar-AE',
};

export function fromTranscribeCode(code: string): SpokenLanguage | null {
  const entry = Object.entries(TRANSCRIBE_CODES).find(([, c]) => c === code);
  return entry ? (entry[0] as SpokenLanguage) : null;
}

export interface PollyVoice {
  voiceId: string;
  /** Sent as LanguageCode: Kajal is bilingual, and hi-IN makes her read numbers in Hindi. */
  languageCode: string;
  engine: 'neural';
}

/**
 * The voice for each language, or null when Polly has none (Malayalam): the
 * reply then goes as text (brief §4). Kajal reads Hindi in Devanagari and in
 * Latin script ("Romanagari"), so Hinglish replies use her too.
 */
export const POLLY_VOICES: Record<SpokenLanguage, PollyVoice | null> = {
  en: { voiceId: 'Kajal', languageCode: 'en-IN', engine: 'neural' },
  hi: { voiceId: 'Kajal', languageCode: 'hi-IN', engine: 'neural' },
  ar: { voiceId: 'Hala', languageCode: 'ar-AE', engine: 'neural' },
  ml: null,
};

/** The assistant's detected language (it tells Hinglish apart) as a spoken language. */
export function spokenLanguageOf(detected: string): SpokenLanguage | null {
  if (detected === 'hi-Latn') return 'hi';
  return (SPOKEN_LANGUAGES as readonly string[]).includes(detected)
    ? (detected as SpokenLanguage)
    : null;
}

/** Longer replies go as text: a voice note is for a short answer. */
export const VOICE_REPLY_MAX_CHARS = 1_000;
/** WhatsApp shows a play button only for voice notes up to 512 KB; larger ones download. */
export const VOICE_NOTE_PLAYABLE_BYTES = 512 * 1024;
/** WhatsApp's voice message format: OGG container, Opus codec, mono. */
export const VOICE_NOTE_MIME_TYPE = 'audio/ogg; codecs=opus';
