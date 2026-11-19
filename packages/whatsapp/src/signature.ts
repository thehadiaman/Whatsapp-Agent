import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook POST: `X-Hub-Signature-256: sha256=<hex>`, an
 * HMAC-SHA256 of the exact raw request body keyed with the app secret.
 * Verification must use the raw bytes; re-serialised JSON will not match.
 */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

export function signPayload(rawBody: Uint8Array | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function verifySignature(
  rawBody: Uint8Array,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(signPayload(rawBody, appSecret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Webhook verification handshake (GET): Meta sends hub.mode=subscribe,
 * hub.verify_token and hub.challenge; we echo the challenge if the token matches.
 */
export function verifyHandshake(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') {
    return null;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}
