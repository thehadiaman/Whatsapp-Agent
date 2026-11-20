import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals secrets stored in the database (P-04: each business's WhatsApp access
 * token) with AES-256-GCM (D-094). The key comes from SSM Parameter Store in
 * production (CREDENTIALS_KEY), never from the database. Each value is bound
 * to its row by additional authenticated data, so a sealed token copied onto
 * another number does not open.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes (base64-encoded)');
    this.key = key;
  }

  static fromBase64(value: string): SecretBox {
    return new SecretBox(Buffer.from(value, 'base64'));
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Throws if the value was changed, sealed with another key, or for another row. */
  open(sealed: string, context: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
      throw new Error('sealed secret: unknown format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** The context a channel's token is sealed under: its provider and phone number ID. */
export const channelTokenContext = (phoneNumberId: string) => `channel:meta:${phoneNumberId}`;
