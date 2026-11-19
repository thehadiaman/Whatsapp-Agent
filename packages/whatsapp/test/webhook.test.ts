import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contactName,
  inboundContent,
  messagesValues,
  webhookTime,
  type MessagesValue,
} from '../src/webhook.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function onlyValue(name: string): MessagesValue {
  const values = messagesValues(fixture(name));
  expect(values).toHaveLength(1);
  return values[0] as MessagesValue;
}

describe("Meta's documented payloads parse", () => {
  it('inbound text, with BSUID and phone number', () => {
    const value = onlyValue('inbound-text');
    expect(value.metadata.phone_number_id).toBe('106540352242922');
    const message = value.messages?.[0];
    expect(message?.from_user_id).toBe('US.13491208655302741918');
    expect(inboundContent(message!)).toEqual({
      kind: 'text',
      body: 'Does it come in another color?',
    });
    expect(webhookTime(message!.timestamp).toISOString()).toBe('2025-06-08T20:59:43.000Z');
    expect(contactName(value, { bsuid: 'US.13491208655302741918', waId: null })).toBe(
      'Sheena Nelson',
    );
  });

  it('a voice note is type audio with voice: true', () => {
    const message = onlyValue('inbound-audio').messages?.[0];
    expect(inboundContent(message!)).toMatchObject({ kind: 'audio', voice: true });
  });

  it('a username-only customer has no phone number, only a BSUID', () => {
    const value = onlyValue('inbound-image-username-only');
    const message = value.messages?.[0];
    expect(message?.from).toBeUndefined();
    expect(message?.from_user_id).toBe('US.13491208655302741918');
    expect(inboundContent(message!)).toMatchObject({
      kind: 'image',
      media: { id: '1003383421387256', mimeType: 'image/jpeg', caption: 'Taj Mahal' },
    });
  });

  it('statuses, including a failed one with error details', () => {
    expect(onlyValue('status-delivered').statuses?.[0]?.status).toBe('delivered');
    const failed = onlyValue('status-failed').statuses?.[0];
    expect(failed?.status).toBe('failed');
    expect(failed?.errors?.[0]?.code).toBe(131049);
  });
});

describe('parsing is strict where it matters', () => {
  it('rejects payloads for other webhook objects', () => {
    expect(() => messagesValues({ object: 'page', entry: [] })).toThrow();
  });

  it('rejects a message with neither phone number nor BSUID', () => {
    const payload = fixture('inbound-text') as {
      entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
    };
    const message = payload.entry[0]!.changes[0]!.value.messages[0]!;
    delete message['from'];
    delete message['from_user_id'];
    expect(() => messagesValues(payload)).toThrow(/neither from nor from_user_id/);
  });

  it('ignores changes for other fields', () => {
    expect(
      messagesValues({
        object: 'whatsapp_business_account',
        entry: [{ id: '1', changes: [{ field: 'account_update', value: { anything: true } }] }],
      }),
    ).toEqual([]);
  });

  it('keeps unknown message types as unsupported instead of failing', () => {
    expect(
      inboundContent({ id: 'w', timestamp: '1', type: 'sticker', from_user_id: 'AE.1' }),
    ).toEqual({ kind: 'unsupported', type: 'sticker' });
  });
});
