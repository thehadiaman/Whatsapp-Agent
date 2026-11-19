import { z } from 'zod';

/**
 * Fault controls (brief §5). All default to off. Rates are probabilities in
 * [0, 1], drawn from a seedable random source so tests are repeatable.
 */
export const faultSettingsSchema = z.object({
  /** Fixed extra delay before each webhook delivery. */
  delayMs: z.number().int().min(0).max(60_000).default(0),
  /** Chance a webhook is delivered a second time, later. */
  duplicateRate: z.number().min(0).max(1).default(0),
  /** Random extra delay up to this many ms per webhook, so later events overtake earlier ones. */
  reorderWindowMs: z.number().int().min(0).max(60_000).default(0),
  /** Chance a send call is answered with a server error (code 131000). */
  failSendRate: z.number().min(0).max(1).default(0),
  /** Chance a send call is answered with a rate-limit error (code 130429). */
  rateLimitRate: z.number().min(0).max(1).default(0),
  /** Chance an accepted message later gets a `failed` status instead of `delivered`. */
  failedStatusRate: z.number().min(0).max(1).default(0),
});
export type FaultSettings = z.infer<typeof faultSettingsSchema>;

export const NO_FAULTS: FaultSettings = faultSettingsSchema.parse({});

/** mulberry32: small, fast, seedable PRNG. Good enough for fault injection. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
