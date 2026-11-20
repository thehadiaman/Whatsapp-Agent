/**
 * Vector size of `knowledge_passages.embedding`. 1,024 is the default size of
 * Amazon Titan Text Embeddings V2 and of Cohere Embed Multilingual v3, the two
 * live candidates for phase 7, so either fits without a migration.
 */
export const EMBEDDING_DIMENSIONS = 1_024;

export type EmbeddingPurpose = 'document' | 'query';

/** Turns text into vectors. Live: Amazon Bedrock (phase 7). Mock: hashed n-grams. */
export interface Embedder {
  /** Stored with each passage, so a model change can find what must be re-embedded. */
  readonly model: string;
  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const words =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  for (const word of words) {
    weights.set(`w:${word}`, (weights.get(`w:${word}`) ?? 0) + 1);
    // Character trigrams make "warranty" close to "warranties" and survive typos.
    const padded = ` ${word} `;
    const chars = Array.from(padded); // code points, so Malayalam and Arabic letters stay whole
    for (let i = 0; i + 3 <= chars.length; i++) {
      const gram = `g:${chars.slice(i, i + 3).join('')}`;
      weights.set(gram, (weights.get(gram) ?? 0) + 0.5);
    }
  }
  return weights;
}

/**
 * Deterministic, offline embedder for mock mode and tests: the hashing trick
 * over words and character trigrams, L2-normalised. Texts that share words
 * are close; it knows no synonyms and no other language, which the live
 * embedder adds. Same input, same vector, on every machine.
 */
export class MockEmbedder implements Embedder {
  readonly model = 'mock-hashed-ngrams-v1';

  /** Documents and queries are embedded the same way here; live models may differ. */
  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.vector(text)));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const [feature, weight] of features(text)) {
      const hash = fnv1a(feature);
      const index = hash % EMBEDDING_DIMENSIONS;
      // A sign bit spreads collisions so they cancel instead of piling up.
      vector[index] = (vector[index] ?? 0) + (hash & 0x80000000 ? -weight : weight);
    }
    const norm = Math.hypot(...vector);
    // Cosine distance to a zero vector is undefined; give empty text a fixed direction.
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }
    return vector.map((v) => v / norm);
  }
}
