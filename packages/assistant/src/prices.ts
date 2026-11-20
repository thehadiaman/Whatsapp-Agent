export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

/**
 * Prices per model, recorded with every turn as a cost in micro-dollars.
 *
 * The Claude figures are Anthropic's published list prices (Haiku 5.5: prompts
 * up to 100K tokens). Claude in Amazon Bedrock is billed by AWS: its global
 * endpoint, which Mumbai uses, carries no premium (Anthropic's Bedrock page),
 * but AWS's own price table did not show these models on 2026-11-20, so the
 * figures are unconfirmed against an AWS bill (D-095). The mock costs nothing.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  mock: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  // A model that cannot be called (kept for turns recorded before phase 7).
  unconfigured: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  'anthropic.claude-haiku-5-5': { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.5 },
  'anthropic.claude-haiku-4-5': { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 },
};

/**
 * Cost of one call in micro-dollars (millionths of a dollar), rounded up.
 * USD per million tokens times tokens is exactly micro-dollars. An unknown
 * model throws: an uncosted turn would silently understate the bill.
 */
export function costMicros(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error(`No price for model "${model}". Add it to MODEL_PRICES.`);
  return Math.ceil(
    usage.inputTokens * price.inputUsdPerMillionTokens +
      usage.outputTokens * price.outputUsdPerMillionTokens,
  );
}
