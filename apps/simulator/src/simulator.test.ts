import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphClient, messagesValues, verifySignature } from '@app/whatsapp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seededRandom } from './faults.js';
import { createSimulator, type Simulator } from './simulator.js';

const SECRET = 'simulator-secret';
const TOKEN = 'simulator-token';
const QAMAR = '100000000000001';
const FATIMA = 'AE.40000000000000000001';
const AISHA_USERNAME_ONLY = 'AE.40000000000000000004';

interface Received {
  body: string;
  signature: string | undefined;
}

// A stand-in for the product's webhook endpoint.
let received: Received[] = [];
let receiverStatus = 200;
const receiver = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x');
      res.end(
        url.searchParams.get('hub.verify_token') === 'verify-me'
          ? url.searchParams.get('hub.challenge')
          : 'no',
      );
      return;
    }
    received.push({
      body: Buffer.concat(chunks).toString(),
      signature: req.headers['x-hub-signature-256'] as string,
    });
    res.statusCode = receiverStatus;
    res.end();
  });
});
let webhookUrl = '';

let sim: Simulator;
let close: () => Promise<void>;
let graph: GraphClient;

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  webhookUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    receiver.close(() => {
      resolve();
    });
  });
});

async function start(options: Partial<Parameters<typeof createSimulator>[0]> = {}) {
  sim = createSimulator({
    webhookUrl,
    appSecret: SECRET,
    accessToken: TOKEN,
    publicUrl: 'http://placeholder',
    random: seededRandom(42),
    statusStepMs: 5,
    ...options,
  });
  const server = await sim.listen(0);
  close = server.close;
  graph = new GraphClient({ baseUrl: server.url, version: 'v26.0', accessToken: TOKEN });
  return server.url;
}

afterEach(async () => {
  // Let scheduled statuses and webhooks finish, so none leak into the next test.
  receiverStatus = 200;
  await sim.idle();
  await close();
  received = [];
  receiverStatus = 200;
});

function keys(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

describe("payloads match Meta's documented shape", () => {
  it('an inbound text has the same keys as Meta’s example and is signed', async () => {
    await start();
    sim.sendInbound([{ customerId: FATIMA, type: 'text', text: 'هل وصل طلبي؟' }]);
    await sim.idle();

    expect(received).toHaveLength(1);
    const { body, signature } = received[0]!;
    expect(verifySignature(Buffer.from(body), signature, SECRET)).toBe(true);

    const ours = JSON.parse(body) as {
      entry: { changes: { value: Record<string, unknown[]> }[] }[];
    };
    const meta = JSON.parse(
      readFileSync(
        new URL('../../../packages/whatsapp/test/fixtures/inbound-text.json', import.meta.url),
        'utf8',
      ),
    ) as typeof ours;
    const ourValue = ours.entry[0]!.changes[0]!.value;
    const metaValue = meta.entry[0]!.changes[0]!.value;
    expect(keys(ourValue)).toEqual(keys(metaValue));
    expect(keys(ourValue['messages']![0])).toEqual(keys(metaValue['messages']![0]));
    expect(keys(ourValue['contacts']![0])).toEqual(keys(metaValue['contacts']![0]));
    expect(messagesValues(ours)[0]?.messages?.[0]?.text?.body).toBe('هل وصل طلبي؟');
  });

  it('a username-only customer arrives with a BSUID and no phone number', async () => {
    await start();
    sim.sendInbound([
      { customerId: AISHA_USERNAME_ONLY, type: 'text', text: 'Is the S24 in stock?' },
    ]);
    await sim.idle();
    const message = messagesValues(JSON.parse(received[0]!.body))[0]?.messages?.[0];
    expect(message?.from).toBeUndefined();
    expect(message?.from_user_id).toBe(AISHA_USERNAME_ONLY);
  });

  it('several messages to one business are batched into one payload, as Meta does', async () => {
    await start();
    sim.sendInbound([
      { customerId: FATIMA, type: 'text', text: 'one' },
      { customerId: 'AE.40000000000000000002', type: 'text', text: 'two' },
    ]);
    await sim.idle();
    expect(received).toHaveLength(1);
    expect(messagesValues(JSON.parse(received[0]!.body))[0]?.messages).toHaveLength(2);
  });
});

describe('Graph API subset', () => {
  it('rejects calls without the access token', async () => {
    const url = await start();
    const response = await fetch(`${url}/v26.0/${QAMAR}/messages`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(190);
  });

  it('accepts a reply inside the window and reports sent then delivered', async () => {
    await start();
    sim.sendInbound([{ customerId: FATIMA, type: 'text', text: 'hi' }]);
    const wamid = await graph.sendMessage(
      QAMAR,
      { bsuid: FATIMA },
      { kind: 'text', body: 'Hello' },
    );
    expect(wamid).toMatch(/^wamid\./);
    await sim.idle();
    const statuses = received
      .flatMap((r) => messagesValues(JSON.parse(r.body)))
      .flatMap((v) => v.statuses ?? [])
      .filter((s) => s.id === wamid)
      .map((s) => s.status);
    expect(statuses).toEqual(['sent', 'delivered']);
  });

  it('refuses free text outside the 24-hour window with code 131047, but allows a template', async () => {
    await start();
    sim.sendInbound([
      { customerId: FATIMA, type: 'text', text: 'old', ageMs: 25 * 60 * 60 * 1000 },
    ]);
    await expect(
      graph.sendMessage(QAMAR, { bsuid: FATIMA }, { kind: 'text', body: 'late' }),
    ).rejects.toMatchObject({ code: 131047, retryable: false });
    await expect(
      graph.sendMessage(
        QAMAR,
        { bsuid: FATIMA },
        { kind: 'template', name: 'reopen', languageCode: 'en' },
      ),
    ).resolves.toMatch(/^wamid\./);
  });

  it('round-trips media: upload, look up, download with the token', async () => {
    const url = await start({ publicUrl: '' });
    sim.state.businesses.get(QAMAR); // ensure seeded
    const bytes = new TextEncoder().encode('%PDF-1.7 price list');
    const id = await graph.uploadMedia(QAMAR, {
      bytes,
      mimeType: 'application/pdf',
      filename: 'prices.pdf',
    });
    // The simulator hands out URLs on its public address; point it at the test server.
    const info = await graph.getMedia(id);
    const download = await graph.downloadMedia(`${url}${new URL(info.url, url).pathname}`);
    expect(new TextDecoder().decode(download.bytes)).toBe('%PDF-1.7 price list');
    expect(info.mime_type).toBe('application/pdf');
  });
});

describe('faults', () => {
  it('duplicate delivery sends every webhook twice', async () => {
    await start({ faults: { duplicateRate: 1 } });
    sim.sendInbound([{ customerId: FATIMA, type: 'text', text: 'dup' }]);
    await sim.idle();
    expect(received).toHaveLength(2);
    expect(received[0]!.body).toBe(received[1]!.body);
  });

  it('failed sends and rate limits answer with Meta’s error codes', async () => {
    await start({ faults: { failSendRate: 1 } });
    sim.sendInbound([{ customerId: FATIMA, type: 'text', text: 'x' }]);
    await expect(
      graph.sendMessage(QAMAR, { bsuid: FATIMA }, { kind: 'text', body: 'y' }),
    ).rejects.toMatchObject({ code: 131000, retryable: true });

    sim.setFaults({ failSendRate: 0, rateLimitRate: 1 });
    await expect(
      graph.sendMessage(QAMAR, { bsuid: FATIMA }, { kind: 'text', body: 'y' }),
    ).rejects.toMatchObject({ code: 130429, retryable: true, httpStatus: 429 });
  });

  it('retries a webhook the receiver rejected, as Meta does', async () => {
    receiverStatus = 500;
    await start();
    sim.sendInbound([{ customerId: FATIMA, type: 'text', text: 'retry me' }]);
    setTimeout(() => {
      receiverStatus = 200;
    }, 250);
    await sim.idle();
    expect(received.length).toBeGreaterThan(1);
    expect(sim.dispatcher.delivered).toBe(1);
  });
});

it('performs the GET verification handshake', async () => {
  await start();
  expect(await sim.verifyWebhook('verify-me')).toBe(true);
  expect(await sim.verifyWebhook('wrong')).toBe(false);
});
