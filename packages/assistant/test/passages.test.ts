import { describe, expect, it } from 'vitest';
import { MockEmbedder, type Embedder } from '../src/embedder.js';
import {
  MAX_PASSAGE_CHARS,
  parseCsv,
  passageFromFaq,
  passagesFromCatalogue,
  passagesFromText,
} from '../src/passages.js';

describe('passagesFromText', () => {
  it('keeps headings with the paragraphs under them', () => {
    const passages = passagesFromText(
      '# Warranty\nAll phones carry a 12-month warranty.\n\n# Screen guards\nGuards are not covered.',
    );
    expect(passages).toEqual([
      { heading: 'Warranty', text: 'All phones carry a 12-month warranty.' },
      { heading: 'Screen guards', text: 'Guards are not covered.' },
    ]);
  });

  it('never makes a passage longer than the limit, splitting at sentence ends', () => {
    const sentence = 'Delivery inside Karama is free for orders above AED 200. ';
    const passages = passagesFromText(sentence.repeat(60));
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) {
      expect(p.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
      expect(p.text.endsWith('.')).toBe(true);
    }
  });

  it('splits Hindi at the danda and cuts unbroken text at a space', () => {
    const hindi = 'हम हर दिन सुबह नौ बजे खुलते हैं। '.repeat(80);
    for (const p of passagesFromText(hindi)) expect(p.text.length).toBeLessThanOrEqual(1200);
    const unbroken = 'word '.repeat(600);
    for (const p of passagesFromText(unbroken)) expect(p.text.length).toBeLessThanOrEqual(1200);
  });
});

describe('FAQ and catalogue', () => {
  it('an FAQ entry is one passage that carries its question', () => {
    expect(passageFromFaq(' Do you deliver on Fridays? ', 'Yes, after 2 pm.')).toEqual({
      heading: 'Do you deliver on Fridays?',
      text: 'Q: Do you deliver on Fridays?\nA: Yes, after 2 pm.',
    });
  });

  it('parses quoted fields, doubled quotes, commas and newlines inside quotes', () => {
    expect(parseCsv('\uFEFFname,note\r\n"Cake, 1 kg","Say ""Happy 40th""\nin gold"\n\n')).toEqual([
      ['name', 'note'],
      ['Cake, 1 kg', 'Say "Happy 40th"\nin gold'],
    ]);
    expect(() => parseCsv('a,"unclosed')).toThrow(/never closed/);
  });

  it('turns each product row into a passage headed by its name', () => {
    const passages = passagesFromCatalogue(
      'Product,Price (INR),Eggless\nChocolate truffle 1 kg,850,Yes\nRed velvet 1 kg,950,\n',
    );
    expect(passages).toEqual([
      {
        heading: 'Chocolate truffle 1 kg',
        text: 'Product: Chocolate truffle 1 kg. Price (INR): 850. Eggless: Yes.',
      },
      { heading: 'Red velvet 1 kg', text: 'Product: Red velvet 1 kg. Price (INR): 950.' },
    ]);
  });

  it('refuses a catalogue with no products, with a message saying what is needed', () => {
    expect(() => passagesFromCatalogue('Product,Price\n')).toThrow(/at least one product row/);
  });
});

describe('MockEmbedder', () => {
  const cosine = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

  it('is deterministic, 1,024-dimensional and normalised', async () => {
    const embedder: Embedder = new MockEmbedder();
    const [a] = await embedder.embed(['Screen guards are not covered'], 'document');
    const [b] = await embedder.embed(['Screen guards are not covered'], 'document');
    expect(a).toEqual(b);
    expect(a).toHaveLength(1024);
    expect(cosine(a!, a!)).toBeCloseTo(1, 6);
  });

  it('puts texts that share words closer than unrelated texts', async () => {
    const [warranty, question, unrelated] = await (new MockEmbedder() as Embedder).embed(
      [
        'All phones carry a 12-month manufacturer warranty.',
        'how long is the phone warranty',
        'Eggless chocolate cake for Saturday',
      ],
      'document',
    );
    expect(cosine(question!, warranty!)).toBeGreaterThan(cosine(question!, unrelated!));
  });

  it('gives empty text a usable vector, not zeros', async () => {
    const [empty] = await (new MockEmbedder() as Embedder).embed([''], 'query');
    expect(cosine(empty!, empty!)).toBeCloseTo(1, 6);
  });
});
