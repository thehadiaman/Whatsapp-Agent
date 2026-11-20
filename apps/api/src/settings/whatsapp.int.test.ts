import { randomBytes, randomInt } from 'node:crypto';
import { schema, type DbHandle } from '@app/db';
import { channelTokenContext, SecretBox } from '@app/pipeline';
import { whatsappNumbersSchema } from '@app/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrangeDb,
  call,
  createTestTenant,
  signIn,
  startApi,
  testConfig,
  type RunningApi,
  type TestTenant,
} from '../test/harness.js';

const KEY = randomBytes(32).toString('base64');
const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');
const TOKEN = `EAAG${'x'.repeat(40)}`;

let db: DbHandle;
let live: RunningApi;
let mock: RunningApi;
let a: TestTenant;
let b: TestTenant;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  db = arrangeDb();
  a = await createTestTenant(db, 'wa');
  b = await createTestTenant(db, 'wb');
  // Live mode, offline: the AWS and Anthropic clients are built but never called here.
  live = await startApi(
    testConfig({
      APP_MODE: 'live',
      CREDENTIALS_KEY: KEY,
      META_APP_SECRET: 'meta-app-secret',
      META_VERIFY_TOKEN: 'meta-verify',
    }),
  );
  mock = await startApi(testConfig());
  [cookies['ownerA'], cookies['agentA'], cookies['ownerB']] = await Promise.all([
    signIn(live, a.ownerEmail),
    signIn(live, a.agentEmail),
    signIn(live, b.ownerEmail),
  ]);
});

afterAll(async () => {
  await Promise.all([live.close(), mock.close()]);
  await db.close();
});

const connect = (api: RunningApi, cookie: string, body: Record<string, unknown>) =>
  call(api, '/api/settings/whatsapp', { method: 'PUT', cookie, body });

describe('connecting a WhatsApp number (P-04)', () => {
  const phoneNumberId = `1${digits(14)}`;

  it('stores the token sealed, never returns it, and audits without it', async () => {
    const saved = await connect(live, cookies['ownerA']!, {
      phoneNumberId,
      wabaId: `2${digits(14)}`,
      displayPhoneNumber: '+971 4 555 0199',
      accessToken: TOKEN,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain(TOKEN);
    const numbers = whatsappNumbersSchema.parse(saved.json);
    expect(numbers).toMatchObject({ mode: 'live', canConnect: true });
    expect(numbers.numbers).toContainEqual(
      expect.objectContaining({ provider: 'meta', phoneNumberId, tokenSaved: true }),
    );

    const [row] = await db.db
      .select()
      .from(schema.channels)
      .where(
        and(eq(schema.channels.provider, 'meta'), eq(schema.channels.phoneNumberId, phoneNumberId)),
      );
    expect(row!.accessTokenSealed).toMatch(/^v1\./);
    expect(row!.accessTokenSealed).not.toContain('EAAG');
    expect(
      SecretBox.fromBase64(KEY).open(row!.accessTokenSealed!, channelTokenContext(phoneNumberId)),
    ).toBe(TOKEN);

    const audit = await db.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.tenantId, a.id),
          eq(schema.auditLog.action, 'settings.whatsapp.updated'),
        ),
      );
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(audit[0]?.after).toMatchObject({ phoneNumberId, tokenChanged: true });
  });

  it('keeps the saved token when the form is saved without one', async () => {
    const [before] = await db.db
      .select({ sealed: schema.channels.accessTokenSealed })
      .from(schema.channels)
      .where(eq(schema.channels.phoneNumberId, phoneNumberId));
    expect(
      (
        await connect(live, cookies['ownerA']!, {
          phoneNumberId,
          wabaId: `2${digits(14)}`,
          displayPhoneNumber: '+971 4 555 0100',
        })
      ).status,
    ).toBe(200);
    const [after] = await db.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.phoneNumberId, phoneNumberId));
    expect(after).toMatchObject({
      accessTokenSealed: before!.sealed,
      displayPhoneNumber: '+971 4 555 0100',
    });
  });

  it("refuses another business's number, an agent, and mock mode", async () => {
    const taken = await connect(live, cookies['ownerB']!, {
      phoneNumberId,
      wabaId: `2${digits(14)}`,
      displayPhoneNumber: '+971 4 555 0199',
      accessToken: TOKEN,
    });
    expect(taken.status).toBe(409);
    expect(JSON.stringify(taken.json)).toContain('already connected to another business');
    // B sees no trace of A's number.
    const bNumbers = whatsappNumbersSchema.parse(
      (await call(live, '/api/settings/whatsapp', { cookie: cookies['ownerB']! })).json,
    );
    expect(bNumbers.numbers.some((n) => n.phoneNumberId === phoneNumberId)).toBe(false);

    expect(
      (
        await connect(live, cookies['agentA']!, {
          phoneNumberId,
          wabaId: '12345',
          displayPhoneNumber: '+971 4 1',
          accessToken: TOKEN,
        })
      ).status,
    ).toBe(403);

    const offline = await connect(mock, await signIn(mock, a.ownerEmail), {
      phoneNumberId: `1${digits(14)}`,
      wabaId: `2${digits(14)}`,
      displayPhoneNumber: '+971 4 555 0101',
      accessToken: TOKEN,
    });
    expect(offline.status).toBe(409);
    expect(JSON.stringify(offline.json)).toContain('mock mode');
  });
});
