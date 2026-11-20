/** A retrievable piece of a knowledge source. */
export interface PassageDraft {
  /** Section heading, product name or FAQ question; shown in "Explain this reply". */
  heading: string | null;
  text: string;
}

/** Long enough for a policy paragraph, short enough to keep retrieval precise. */
export const MAX_PASSAGE_CHARS = 1_200;
/** Catalogues larger than this are refused with a clear error, not truncated. */
export const MAX_CATALOGUE_ROWS = 5_000;

// Sentence ends in the scripts we serve: Latin and Malayalam ". ? !", Devanagari
// danda "।", Arabic question mark "؟" and Urdu full stop "۔".
const SENTENCE_END = /(?<=[.?!।؟۔])\s+/u;

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_END)) {
    if (current && current.length + sentence.length + 1 > max) {
      parts.push(current);
      current = '';
    }
    if (sentence.length > max) {
      // One enormous "sentence" (a table dump, say): cut at a space near the limit.
      for (let rest = sentence; rest.length > 0;) {
        const cut = rest.length <= max ? rest.length : rest.lastIndexOf(' ', max) || max;
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      continue;
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Splits a document into passages: paragraphs are packed together up to
 * MAX_PASSAGE_CHARS, never across a heading. Markdown `#` lines become the
 * heading of the passages under them.
 */
export function passagesFromText(text: string, max = MAX_PASSAGE_CHARS): PassageDraft[] {
  const passages: PassageDraft[] = [];
  let heading: string | null = null;
  let current = '';
  const flush = () => {
    if (current.trim()) passages.push({ heading, text: current.trim() });
    current = '';
  };

  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    // A heading line may be followed directly by its paragraph.
    for (
      let first = lines[0];
      first !== undefined && /^#{1,6}\s+\S/.test(first);
      first = lines[0]
    ) {
      flush();
      lines.shift();
      heading = first.replace(/^#{1,6}\s+/, '').trim();
    }
    const paragraph = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!paragraph) continue;
    for (const piece of splitLong(paragraph, max)) {
      if (current && current.length + piece.length + 2 > max) flush();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();
  return passages;
}

/** One FAQ entry is one passage, so a retrieved answer always carries its question. */
export function passageFromFaq(question: string, answer: string): PassageDraft {
  return { heading: question.trim(), text: `Q: ${question.trim()}\nA: ${answer.trim()}` };
}

/** Parses CSV (RFC 4180: quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, ''); // Excel writes a byte-order mark
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('A quoted field is never closed.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * A product catalogue: the first row names the columns, every other row is a
 * product and becomes one passage ("Name: …. Price: …."), headed by its first
 * column. One passage per product means a price is retrieved with its product.
 */
export function passagesFromCatalogue(csv: string): PassageDraft[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header || rows.length === 0) {
    throw new Error(
      'The file has no products: it needs a header row and at least one product row.',
    );
  }
  if (rows.length > MAX_CATALOGUE_ROWS) {
    throw new Error(
      `The file has ${String(rows.length)} products; the limit is ${String(MAX_CATALOGUE_ROWS)}. Split it into smaller files.`,
    );
  }
  const columns = header.map((c) => c.trim());
  return rows.map((cells) => {
    const pairs = columns
      .map((column, i) => [column, (cells[i] ?? '').trim()] as const)
      .filter(([column, value]) => column && value);
    return {
      heading: (cells[0] ?? '').trim() || null,
      text: pairs.map(([column, value]) => `${column}: ${value}.`).join(' '),
    };
  });
}
