import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channelTokenContext, SecretBox } from './secrets.js';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));
  const context = channelTokenContext('100000000000009');

  it('opens what it sealed, and never stores the plain text', () => {
    const sealed = box.seal('EAAG-system-user-token', context);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('EAAG');
    expect(box.open(sealed, context)).toBe('EAAG-system-user-token');
    // A fresh IV each time: the same token seals differently.
    expect(box.seal('EAAG-system-user-token', context)).not.toBe(sealed);
  });

  it('refuses a changed value, another key, or another number', () => {
    const sealed = box.seal('token', context);
    const parts = sealed.split('.');
    const tampered = [...parts.slice(0, 3), Buffer.from('tokeX').toString('base64url')].join('.');
    expect(() => box.open(tampered, context)).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(sealed, context)).toThrow();
    expect(() => box.open(sealed, channelTokenContext('100000000000001'))).toThrow();
    expect(() => box.open('plain-text', context)).toThrow(/unknown format/);
  });

  it('wants a 32-byte key', () => {
    expect(() => SecretBox.fromBase64(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
