import { detectLanguage, type Language } from './language.js';

/**
 * Sent without a model when the assistant hands over on its own: a guard
 * stopped a reply, the business's daily budget is spent, or the model failed.
 * The customer always learns that a person will answer, in their language.
 */
const HANDOFF_NOTICE: Record<Language, string> = {
  en: 'Thanks for your message. A person from our team will reply here soon.',
  hi: 'आपके संदेश के लिए धन्यवाद। हमारी टीम का कोई व्यक्ति जल्द ही यहाँ जवाब देगा।',
  'hi-Latn': 'Message ke liye shukriya. Hamari team se koi jaldi hi yahan reply karega.',
  ml: 'നിങ്ങളുടെ സന്ദേശത്തിന് നന്ദി. ഞങ്ങളുടെ ടീമിലെ ഒരാൾ ഉടൻ ഇവിടെ മറുപടി നൽകും.',
  ar: 'شكرًا على رسالتك. سيرد عليك أحد أعضاء فريقنا هنا قريبًا.',
};

/**
 * Added to a handover outside opening hours, so the customer knows when a
 * person will actually read it. `when` is already formatted for the language.
 */
const OUTSIDE_HOURS: Record<Language, (when: string) => string> = {
  en: (when) => `We're closed now. A person from our team will reply when we open: ${when}.`,
  hi: (when) => `अभी दुकान बंद है। दुकान खुलने पर हमारी टीम का कोई व्यक्ति जवाब देगा: ${when}।`,
  'hi-Latn': (when) => `Abhi dukaan band hai. Khulne par hamari team se koi reply karega: ${when}.`,
  ml: (when) => `ഇപ്പോൾ കട അടച്ചിരിക്കുകയാണ്. തുറക്കുമ്പോൾ ഞങ്ങളുടെ ടീമിലെ ഒരാൾ മറുപടി നൽകും: ${when}.`,
  ar: (when) => `نحن مغلقون الآن. سيرد عليك أحد أعضاء فريقنا عند الافتتاح: ${when}.`,
};

/** Locale for formatting the reopening day and time in each language. */
export const NOTICE_LOCALES: Record<Language, string> = {
  en: 'en-GB',
  hi: 'hi-IN',
  'hi-Latn': 'en-IN',
  ml: 'ml-IN',
  ar: 'ar-AE',
};

export function outsideHoursLine(language: Language, when: string): string {
  return OUTSIDE_HOURS[language](when);
}

export function handoffNotice(customerText: string): { language: Language; text: string } {
  const language = detectLanguage(customerText);
  return { language, text: HANDOFF_NOTICE[language] };
}
