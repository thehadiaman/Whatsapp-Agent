import { describe, expect, it } from 'vitest';
import { CASES, type EvalCase } from '../src/cases.js';
import { normalise, passedAll, score, type TurnTrace } from '../src/checks.js';
import { percentile, rate } from '../src/report.js';

const trace = (over: Partial<TurnTrace>): TurnTrace => ({
  outcome: 'replied',
  basis: 'knowledge',
  handoffReason: null,
  reply: null,
  latencyMs: 1_000,
  inputTokens: 100,
  outputTokens: 10,
  costMicros: 0,
  evidence: [],
  ...over,
});

const priceCase: EvalCase = {
  id: 't',
  business: 'qamar-phone-corner',
  language: 'en',
  about: 'price',
  messages: ['How much is the S24?'],
  expect: { handoff: false, facts: ['3149', ['Onyx', 'Marble']], forbidden: ['50%'] },
};

describe('scoring', () => {
  it('passes a grounded reply in the right language, with figures written any way', () => {
    const s = score(
      priceCase,
      trace({ reply: 'The Galaxy S24 256 GB is AED 3,149, in Onyx Black.' }),
      null,
    );
    expect(s).toMatchObject({
      grounded: 'pass',
      handoff: 'pass',
      declined: 'pass',
      language: 'pass',
    });
    expect(passedAll(s)).toBe(true);
  });

  it('fails a missing fact, a forbidden one, and a wrong handoff, and says why', () => {
    const s = score(
      priceCase,
      trace({ reply: 'It is 50% off today!', handoffReason: 'asked_for_person' }),
      null,
    );
    expect(s.grounded).toBe('fail');
    expect(s.handoff).toBe('fail');
    expect(s.notes).toEqual([
      'went to a person (asked_for_person)',
      'missing 3149, Onyx/Marble',
      'must not say 50%',
    ]);
  });

  it('lets the judge veto groundedness and decide the language in live runs', () => {
    const verdict = { grounded: false, languageMatches: true, reason: 'claims free delivery' };
    const s = score(priceCase, trace({ reply: 'AED 3149, Onyx. Delivery is free.' }), verdict);
    expect(s.grounded).toBe('fail');
    expect(s.language).toBe('pass');
  });

  it('does not score handoff where either answer is acceptable', () => {
    const open: EvalCase = { ...priceCase, expect: {} };
    expect(
      score(
        open,
        trace({ reply: 'We do not stock that.', handoffReason: 'not_in_knowledge' }),
        null,
      ).handoff,
    ).toBe('n/a');
  });

  it('reads Arabic-Indic, Devanagari and Malayalam digits as numbers', () => {
    expect(normalise('١٤ يومًا')).toBe('14 يومًا');
    expect(normalise('₹९५०')).toBe('₹950');
    expect(normalise('൨൪ മണിക്കൂർ')).toBe('24 മണിക്കൂർ');
  });
});

describe('the cases', () => {
  it('has about fifty, in all five languages, with unique IDs', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(new Set(CASES.map((c) => c.language))).toEqual(
      new Set(['en', 'hi', 'hi-Latn', 'ml', 'ar']),
    );
  });
});

describe('report helpers', () => {
  it('rates only scored checks, and interpolates percentiles', () => {
    expect(rate(['pass', 'fail', 'n/a', 'pass'])).toBe('2/3 (67%)');
    expect(rate(['n/a'])).toBe('–');
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
  });
});
