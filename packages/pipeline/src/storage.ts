import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Object storage for media. Keys are always `tenants/{tenantId}/...` (brief §4).
 * Mock mode: local disk. Live mode: S3 (phase 7), behind the same interface.
 */
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Removes the object if it exists. */
  delete(key: string): Promise<void>;
}

const KEY = /^tenants\/[0-9a-f-]{36}\/[a-z]+\/[0-9a-f-]{36}$/;

export function knowledgeObjectKey(tenantId: string, sourceId: string): string {
  const key = `tenants/${tenantId}/knowledge/${sourceId}`;
  assertKey(key);
  return key;
}

export function mediaKey(tenantId: string, messageId: string): string {
  const key = `tenants/${tenantId}/media/${messageId}`;
  assertKey(key);
  return key;
}

function assertKey(key: string): void {
  // Rejects traversal (`..`), absolute paths and anything outside a tenant prefix.
  if (!KEY.test(key)) throw new Error('storage: invalid object key');
}

export class LocalDiskStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.type`, contentType);
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const path = this.path(key);
    try {
      const [bytes, contentType] = await Promise.all([
        readFile(path),
        readFile(`${path}.type`, 'utf8'),
      ]);
      return { bytes: new Uint8Array(bytes), contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.path(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }
}
