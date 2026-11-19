import { describe, expect, it } from 'vitest';
import { GraphClient, messageBody } from '../src/client.js';
import { ERROR_CODES, GraphApiError, isRetryable } from '../src/errors.js';
import { signPayload, verifyHandshake, verifySignature } from '../src/signature.js';

describe('webhook signature', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

  it('accepts the HMAC of the exact raw body', () => {
    expect(verifySignature(body, signPayload(body, secret), secret)).toBe(true);
  });

  it('rejects a changed body, a wrong secret, a missing or malformed header', () => {
    const signature = signPayload(body, secret);
    expect(verifySignature(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
    expect(verifySignature(body, signature, 'other-secret')).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, signature.replace('sha256=', ''), secret)).toBe(false);
  });
});

describe('verification handshake', () => {
  it('echoes the challenge only for subscribe with the right token', () => {
    const ok = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'tok',
      'hub.challenge': '1158201444',
    };
    expect(verifyHandshake(ok, 'tok')).toBe('1158201444');
    expect(verifyHandshake({ ...ok, 'hub.verify_token': 'nope' }, 'tok')).toBeNull();
    expect(verifyHandshake({ ...ok, 'hub.mode': 'unsubscribe' }, 'tok')).toBeNull();
  });
});

describe('error classification', () => {
  it('retries rate limits and transient failures', () => {
    for (const code of [130429, 131056, 80007, 4, 131000, 131016, 1, 2]) {
      expect(isRetryable(400, code)).toBe(true);
    }
    expect(isRetryable(null, null)).toBe(true);
    expect(isRetryable(503, null)).toBe(true);
  });

  it('does not retry a closed window, bad parameters or an undeliverable recipient', () => {
    for (const code of [ERROR_CODES.windowClosed, 100, 131009, 131026]) {
      expect(isRetryable(400, code)).toBe(false);
    }
  });
});

describe('send body', () => {
  it('addresses by BSUID when known, by phone otherwise', () => {
    expect(messageBody({ bsuid: 'AE.123' }, { kind: 'text', body: 'Hi' })).toMatchObject({
      recipient: 'AE.123',
      type: 'text',
      text: { body: 'Hi' },
    });
    expect(messageBody({ phone: '971501234567' }, { kind: 'text', body: 'Hi' })).toMatchObject({
      to: '971501234567',
    });
  });

  it('sends voice replies as audio with voice: true', () => {
    expect(
      messageBody({ bsuid: 'AE.1' }, { kind: 'audio', mediaId: 'm1', voice: true }),
    ).toMatchObject({ type: 'audio', audio: { id: 'm1', voice: true } });
  });
});

describe('GraphClient', () => {
  it('returns the wamid and sends the bearer token', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const client = new GraphClient({
      baseUrl: 'http://graph.test',
      version: 'v26.0',
      accessToken: 'token-1',
      fetch: (input, init) => {
        seen = {
          url: input instanceof Request ? input.url : input.toString(),
          auth: new Headers(init?.headers).get('authorization'),
        };
        return Promise.resolve(Response.json({ messages: [{ id: 'wamid.X' }] }));
      },
    });
    await expect(
      client.sendMessage('123', { bsuid: 'AE.1' }, { kind: 'text', body: 'x' }),
    ).resolves.toBe('wamid.X');
    expect(seen).toEqual({ url: 'http://graph.test/v26.0/123/messages', auth: 'Bearer token-1' });
  });

  it("turns Meta's error body into a classified GraphApiError", async () => {
    const client = new GraphClient({
      baseUrl: 'http://graph.test',
      version: 'v26.0',
      accessToken: 't',
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: { message: '(#130429) Rate limit hit', type: 'OAuthException', code: 130429 },
            },
            { status: 400 },
          ),
        ),
    });
    const error = await client
      .sendMessage('1', { bsuid: 'AE.1' }, { kind: 'text', body: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(error).toMatchObject({ code: 130429, retryable: true, ambiguous: false });
  });

  it('marks a send that never got an answer as ambiguous', async () => {
    const client = new GraphClient({
      baseUrl: 'http://graph.test',
      version: 'v26.0',
      accessToken: 't',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = await client
      .sendMessage('1', { bsuid: 'AE.1' }, { kind: 'text', body: 'x' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true, ambiguous: true });
  });
});
