/**
 * Grounding guard for figures. The brief forbids inventing prices, stock,
 * policies or delivery dates. The prompt asks for that; this check enforces it
 * for numbers: every figure in a reply must appear in the evidence the model
 * was given (passages, tool results, the customer's own messages).
 *
 * It fails safe: a false positive hands the conversation to a person, it does
 * not send a wrong answer. Numbers written as words ("five hundred") are not
 * caught; the prompt and the evals cover those.
 */

// Zero digits of the scripts customers here write in: ASCII, Arabic-Indic,
// Extended Arabic-Indic (Persian/Urdu), Devanagari and Malayalam.
const ZERO_DIGITS = [0x30, 0x660, 0x6f0, 0x966, 0xd66];

function asciiDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const zero = ZERO_DIGITS.find((z) => code >= z && code <= z + 9);
    if (zero !== undefined) out += String(code - zero);
    else if (char === '\u066B')
      out += '.'; // Arabic decimal separator
    else if (char === '\u066C')
      out += ','; // Arabic thousands separator
    else out += char;
  }
  return out;
}

// 1,299 or 12,345,678 (international) and 1,29,999 (Indian) grouping.
const GROUPED = /^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/;

function canonical(figure: string): string[] {
  if (GROUPED.test(figure)) return [String(Number(figure.replaceAll(',', '')))];
  // Anything else with commas is a list ("2,3") or a European decimal; treat
  // each part as its own figure, which is the stricter reading.
  return figure
    .split(',')
    .filter(Boolean)
    .map((part) => String(Number(part)));
}

/** Every number in the text, normalised: "₹1,299.00" and "١٢٩٩" both give "1299". */
export function figuresIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of asciiDigits(text).matchAll(/\d+(?:[.,]\d+)*/g)) {
    for (const value of canonical(match[0].replace(/\.$/, ''))) {
      if (value !== 'NaN') found.add(value);
    }
  }
  return found;
}

/** Figures in `reply` that appear nowhere in `evidence`. Empty means grounded. */
export function ungroundedFigures(reply: string, evidence: readonly string[]): string[] {
  const known = new Set<string>();
  for (const text of evidence) for (const figure of figuresIn(text)) known.add(figure);
  return [...figuresIn(reply)].filter((figure) => !known.has(figure));
}
