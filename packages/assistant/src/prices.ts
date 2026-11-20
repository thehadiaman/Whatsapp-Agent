export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

/**
 * Prices per model, recorded with every turn as a cost in micro-dollars.
 *
 * The Claude figures are Anthropic's published list prices (Haiku 5.5: prompts
 * up to 100K tokens). Claude in Amazon Bedrock is billed by AWS, and its price
 * could not be confirmed on 2026-11-20; phase 7 checks the AWS pricing page and
 * updates this table before any live turn is costed. The mock costs nothing.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  mock: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  // Live mode before phase 7: no model is called, so nothing is spent.
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
