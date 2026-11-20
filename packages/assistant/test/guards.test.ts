import { describe, expect, it } from 'vitest';
import { costMicros } from '../src/prices.js';
import { figuresIn, ungroundedFigures } from '../src/figures.js';
import { detectLanguage } from '../src/language.js';
import { handoffNotice } from '../src/notices.js';

describe('detectLanguage', () => {
  it.each([
    ['Is the S24 in stock?', 'en'],
    ['هل وصل طلبي؟ رقم الطلب KB-2291', 'ar'],
    ['ശനിയാഴ്ചത്തെ കേക്ക് ഓർഡറിന്റെ തീയതി മാറ്റാമോ?', 'ml'],
    ['क्या आज डिलीवरी हो सकती है?', 'hi'],
    ['mera order kab aayega? KB-2417', 'hi-Latn'],
    ['bhai screen guard ka warranty kitna hai', 'hi-Latn'],
    ['', 'en'],
  ] as const)('%s → %s', (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it('one borrowed word does not flip an English sentence', () => {
    expect(detectLanguage('Please send the cake to St. Mary’s, Kaloor (കലൂർ) by 5:30')).toBe('en');
  });
});

describe('figuresIn', () => {
  it('normalises currency, grouping and decimals', () => {
    expect(figuresIn('₹1,299.00 or AED 12.50, 1,29,999 total')).toEqual(
      new Set(['1299', '12.5', '129999']),
    );
  });

  it('reads Arabic-Indic, Devanagari and Malayalam digits', () => {
    expect(figuresIn('السعر ١٢٩٩ درهم')).toEqual(new Set(['1299']));
    expect(figuresIn('कीमत ८५० रुपये')).toEqual(new Set(['850']));
    expect(figuresIn('വില ൮൫൦ രൂപ')).toEqual(new Set(['850']));
  });
});

describe('ungroundedFigures', () => {
  const passage = 'Eggless chocolate cake: ₹850 for 1 kg. Order by Thursday 6 pm.';

  it('accepts a reply whose figures all come from the evidence', () => {
    expect(ungroundedFigures('Yes, eggless chocolate is ₹850 for 1 kg.', [passage])).toEqual([]);
  });

  it('accepts the same figure written in another script', () => {
    expect(ungroundedFigures('الكيك بسعر ٨٥٠ روبية', [passage])).toEqual([]);
  });

  it('flags an invented price or date', () => {
    expect(ungroundedFigures('It is ₹799 and ready on the 22nd.', [passage])).toEqual([
      '799',
      '22',
    ]);
  });

  it('allows figures the customer wrote, such as their order number', () => {
    expect(ungroundedFigures('Order KB-2291 has shipped.', ['Where is KB-2291?'])).toEqual([]);
  });
});

describe('handoffNotice', () => {
  it("answers in the customer's language", () => {
    expect(handoffNotice('أريد التحدث مع شخص').language).toBe('ar');
    expect(handoffNotice('mujhe kisi insaan se baat karni hai').text).toContain('shukriya');
  });
});

describe('costMicros', () => {
  it('prices tokens in micro-dollars and rounds up', () => {
    // Haiku 5.5 list price: $0.10 in, $0.50 out per million tokens.
    expect(costMicros('anthropic.claude-haiku-5-5', { inputTokens: 2341, outputTokens: 118 })).toBe(
      Math.ceil(2341 * 0.1 + 118 * 0.5),
    );
    expect(costMicros('mock', { inputTokens: 5000, outputTokens: 500 })).toBe(0);
  });

  it('refuses to cost an unknown model rather than recording zero', () => {
    expect(() => costMicros('some-new-model', { inputTokens: 1, outputTokens: 1 })).toThrow(
      /No price/,
    );
  });
});
