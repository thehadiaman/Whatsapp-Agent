/**
 * Languages the demo businesses serve. `hi-Latn` is Hindi written in Latin
 * letters (Hinglish), which customers in India and the Gulf type more often
 * than Devanagari.
 */
export const LANGUAGES = ['en', 'hi', 'hi-Latn', 'ml', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

const SCRIPTS: { language: Language; pattern: RegExp }[] = [
  { language: 'ar', pattern: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/gu },
  { language: 'ml', pattern: /[ഀ-ൿ]/gu },
  { language: 'hi', pattern: /[ऀ-ॿ]/gu },
];

// Common Hindi words in Latin letters that are not also English words.
const HINGLISH = new Set([
  'kya',
  'hai',
  'hain',
  'kab',
  'kitna',
  'kitne',
  'kitni',
  'mera',
  'meri',
  'mujhe',
  'aap',
  'aapka',
  'bhai',
  'nahi',
  'nahin',
  'aayega',
  'ayega',
  'chahiye',
  'kaise',
  'kahan',
  'kidhar',
  'abhi',
  'karo',
  'kar',
  'bata',
  'batao',
  'wala',
  'wali',
  'ka',
  'ki',
  'ke',
  'hoga',
  'milega',
  'theek',
  'acha',
  'accha',
]);

/**
 * Guesses the language of a customer message from its script, without a
 * model. Used where no model runs: fixed notices (handoff, budget) and the
 * mock model. The live model detects language itself.
 */
export function detectLanguage(text: string): Language {
  const letters = [...text.matchAll(/\p{L}/gu)].length;
  if (letters === 0) return 'en';
  let best: { language: Language; count: number } | null = null;
  for (const { language, pattern } of SCRIPTS) {
    const count = [...text.matchAll(pattern)].length;
    if (count > 0 && (!best || count > best.count)) best = { language, count };
  }
  // A script counts if it makes up a real share of the letters, so one
  // borrowed word does not flip an English message.
  if (best && best.count / letters >= 0.3) return best.language;

  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hinglish = words.filter((w) => HINGLISH.has(w)).length;
  if (hinglish >= 2 || (hinglish === 1 && words.length <= 3)) return 'hi-Latn';
  return 'en';
}
