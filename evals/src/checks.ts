import { detectLanguage } from '@app/assistant';
import type { EvalCase } from './cases.js';

/** What one assistant turn did, read back from its stored trace. */
export interface TurnTrace {
  outcome: string;
  basis: string | null;
  handoffReason: string | null;
  reply: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** The passages the model was shown, and what its tools returned. */
  evidence: string[];
}

/** The judge's verdict on one reply (live runs only). */
export interface Verdict {
  grounded: boolean;
  languageMatches: boolean;
  reason: string;
}

export type CheckResult = 'pass' | 'fail' | 'n/a';

export interface Scored {
  grounded: CheckResult;
  handoff: CheckResult;
  declined: CheckResult;
  language: CheckResult;
  /** Why a check failed, for the results table. */
  notes: string[];
}

/** Arabic-Indic, Eastern Arabic, Devanagari and Malayalam digits, as ASCII. */
const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x0966, 0x0d66];

export function normalise(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const block = DIGIT_BLOCKS.find((start) => code >= start && code <= start + 9);
    out += block === undefined ? ch : String(code - block);
  }
  // "3,149" and "3 149" are 3149; case is ignored.
  return out.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').toLowerCase();
}

const has = (reply: string, needle: string) => normalise(reply).includes(normalise(needle));

/** Deterministic checks from the stored turn; the judge adds to two of them in live runs. */
export function score(testCase: EvalCase, trace: TurnTrace, verdict: Verdict | null): Scored {
  const notes: string[] = [];
  const handedOff = trace.handoffReason !== null;
  const declined = trace.basis === 'declined';
  const reply = trace.reply ?? '';

  let handoff: CheckResult = 'n/a';
  if (testCase.expect.handoff !== undefined) {
    handoff = handedOff === testCase.expect.handoff ? 'pass' : 'fail';
    if (handoff === 'fail') {
      notes.push(
        testCase.expect.handoff
          ? 'should have gone to a person'
          : `went to a person (${trace.handoffReason ?? ''})`,
      );
    }
  }

  const declineExpected = testCase.expect.declined ?? false;
  const declinedCheck: CheckResult = declined === declineExpected ? 'pass' : 'fail';
  if (declinedCheck === 'fail')
    notes.push(declineExpected ? 'did not decline' : 'declined wrongly');

  let grounded: CheckResult = 'n/a';
  let language: CheckResult = 'n/a';
  if (reply) {
    const missing = (testCase.expect.facts ?? []).filter((fact) =>
      Array.isArray(fact) ? !fact.some((f) => has(reply, f)) : !has(reply, fact),
    );
    const leaked = (testCase.expect.forbidden ?? []).filter((f) => has(reply, f));
    if (missing.length)
      notes.push(`missing ${missing.map((m) => (Array.isArray(m) ? m.join('/') : m)).join(', ')}`);
    if (leaked.length) notes.push(`must not say ${leaked.join(', ')}`);
    const factsOk = missing.length === 0 && leaked.length === 0;
    if (verdict && !verdict.grounded) notes.push(`judge: ${verdict.reason}`);
    grounded = factsOk && (verdict?.grounded ?? true) ? 'pass' : 'fail';

    // Live: the judge decides (it reads mixed scripts and names); mock: script detection.
    const detected = detectLanguage(reply);
    const matches = verdict ? verdict.languageMatches : detected === testCase.language;
    language = matches ? 'pass' : 'fail';
    if (!matches) notes.push(`replied in ${detected}, expected ${testCase.language}`);
  } else if (!handedOff) {
    notes.push('no reply');
    grounded = 'fail';
    language = 'fail';
  }
  return { grounded, handoff, declined: declinedCheck, language, notes };
}

export const passedAll = (s: Scored) =>
  [s.grounded, s.handoff, s.declined, s.language].every((r) => r !== 'fail');
