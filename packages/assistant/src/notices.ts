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

export function handoffNotice(customerText: string): { language: Language; text: string } {
  const language = detectLanguage(customerText);
  return { language, text: HANDOFF_NOTICE[language] };
}
