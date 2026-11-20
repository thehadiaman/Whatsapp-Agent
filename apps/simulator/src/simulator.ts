import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import {
  mockVoiceNote,
  readMockVoiceNote,
  SPOKEN_LANGUAGES,
  VOICE_NOTE_MIME_TYPE,
} from '@app/voice';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { WebhookDispatcher } from './dispatcher.js';
import { faultSettingsSchema, NO_FAULTS, type FaultSettings } from './faults.js';
import { simulatorPage } from './page.js';
import { inboundPayload, statusPayload, type InboundItem } from './payloads.js';
import { SimulatorState, wamid, type Customer, type ThreadMessage } from './state.js';

export interface SimulatorOptions {
  /** Where to POST webhooks: the product's /api/webhooks/whatsapp/simulator. */
  webhookUrl: string;
  appSecret: string;
  accessToken: string;
  /** Base URL used in media download URLs. Defaults to the address the request came in on. */
  publicUrl?: string;
  random?: () => number;
  faults?: Partial<FaultSettings>;
  /** Delay between status steps (accepted → sent → delivered → read). */
  statusStepMs?: number;
  /** Mark outgoing messages as read automatically (tests). The UI reads on view. */
  autoRead?: boolean;
  seedDemo?: boolean;
  onError?: (error: unknown) => void;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const VERSION = /^v\d+\.\d+$/;

/** Meta's error envelope (Cloud API error-code reference). */
function graphError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    error: {
      message: `(#${String(code)}) ${message}`,
      type: 'OAuthException',
      code,
      error_data: { messaging_product: 'whatsapp', details: message },
      fbtrace_id: 'SIMULATOR',
    },
  });
}

const sendSchema = z
  .object({
    messaging_product: z.literal('whatsapp'),
    recipient_type: z.literal('individual').optional(),
    to: z.string().optional(),
    recipient: z.string().optional(),
    type: z.enum(['text', 'template', 'audio', 'image', 'document']),
    text: z
      .object({ body: z.string().min(1).max(4096) })
      .loose()
      .optional(),
    template: z
      .object({ name: z.string(), language: z.object({ code: z.string() }) })
      .loose()
      .optional(),
    audio: z.object({ id: z.string(), voice: z.boolean().optional() }).loose().optional(),
  })
  .loose()
  .refine((b) => b.to !== undefined || b.recipient !== undefined, {
    message: 'to or recipient is required',
  });

const inboundRequestSchema = z.object({
  customerId: z.string(),
  type: z.enum(['text', 'image', 'document', 'audio']).default('text'),
  /** For a voice note: what the customer says (the mock transcript). */
  text: z.string().max(4096).optional(),
  /** For a voice note: the language spoken. */
  language: z.enum(SPOKEN_LANGUAGES).optional(),
  caption: z.string().max(1024).optional(),
  filename: z.string().max(200).optional(),
  /** Base64 file content; a tiny placeholder is used when absent. */
  dataBase64: z.string().optional(),
  mimeType: z.string().optional(),
  /** Pretend the customer wrote this long ago (tests the 24-hour window). */
  ageMs: z.number().int().min(0).optional(),
});
type InboundRequest = z.infer<typeof inboundRequestSchema>;

// 1x1 PNG, used when the page or a test sends an image without content.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface Simulator {
  app: express.Express;
  state: SimulatorState;
  dispatcher: WebhookDispatcher;
  faults: FaultSettings;
  setFaults(faults: Partial<FaultSettings>): void;
  /** A customer writes to their business. Returns the wamids, in order. */
  sendInbound(items: InboundRequest[]): string[];
  /** Waits until no webhook or status is pending. */
  idle(): Promise<void>;
  listen(port: number, host?: string): Promise<{ url: string; close: () => Promise<void> }>;
  /** Sends Meta's GET verification handshake to the webhook. */
  verifyWebhook(verifyToken: string): Promise<boolean>;
}

export function createSimulator(options: SimulatorOptions): Simulator {
  const random = options.random ?? Math.random;
  const state = new SimulatorState(options.seedDemo ?? true);
  let faults: FaultSettings = { ...NO_FAULTS, ...options.faults };
  const statusStepMs = options.statusStepMs ?? 150;
  const listeners = new Set<Response>();
  let pendingStatuses = 0;
  const statusWaiters: (() => void)[] = [];

  const dispatcher = new WebhookDispatcher({
    webhookUrl: options.webhookUrl,
    appSecret: options.appSecret,
    random,
    faults: () => faults,
    ...(options.onError ? { onError: options.onError } : {}),
  });

  const broadcast = (event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(line);
  };

  const businessOf = (customer: Customer) => {
    const business = state.businesses.get(customer.businessPhoneNumberId);
    if (!business) throw new Error('customer without business');
    return business;
  };

  // --- statuses for business → customer messages ------------------------------
  const emitStatus = (
    customer: Customer,
    message: ThreadMessage,
    status: 'sent' | 'delivered' | 'read' | 'failed',
  ) => {
    message.status = status;
    dispatcher.send(
      statusPayload(businessOf(customer), {
        customer,
        wamid: message.wamid,
        status,
        at: Date.now(),
      }),
    );
    broadcast('thread', { customerId: customer.id });
  };

  const scheduleStatuses = (customer: Customer, message: ThreadMessage) => {
    const steps: ('sent' | 'delivered' | 'read' | 'failed')[] =
      random() < faults.failedStatusRate
        ? ['sent', 'failed']
        : options.autoRead
          ? ['sent', 'delivered', 'read']
          : ['sent', 'delivered'];
    steps.forEach((status, index) => {
      pendingStatuses += 1;
      const timer = setTimeout(
        () => {
          emitStatus(customer, message, status);
          pendingStatuses -= 1;
          if (pendingStatuses === 0) for (const resolve of statusWaiters.splice(0)) resolve();
        },
        statusStepMs * (index + 1),
      );
      timer.unref();
    });
  };

  // --- inbound: customer → business --------------------------------------------
  const sendInbound = (requests: InboundRequest[]): string[] => {
    const byBusiness = new Map<string, InboundItem[]>();
    const ids: string[] = [];
    for (const request of requests) {
      const customer = state.customers.get(request.customerId);
      if (!customer) throw new Error(`unknown customer ${request.customerId}`);
      const at = Date.now() - (request.ageMs ?? 0);
      const id = wamid();
      let item: InboundItem;
      if (request.type === 'text') {
        item = { customer, wamid: id, at, type: 'text', text: request.text ?? '' };
      } else {
        // A voice note is recorded on the phone: the words travel inside it.
        const bytes = request.dataBase64
          ? Buffer.from(request.dataBase64, 'base64')
          : request.type === 'audio'
            ? Buffer.from(
                mockVoiceNote({ text: request.text ?? '', language: request.language ?? 'en' }),
              )
            : PLACEHOLDER_PNG;
        const mimeType =
          request.mimeType ??
          (request.type === 'image'
            ? 'image/png'
            : request.type === 'audio'
              ? VOICE_NOTE_MIME_TYPE
              : 'application/pdf');
        const sha256 = createHash('sha256').update(bytes).digest('base64');
        const media = state.storeMedia(new Uint8Array(bytes), mimeType, sha256);
        item = {
          customer,
          wamid: id,
          at,
          type: request.type,
          media: { id: media.id, mimeType, sha256 },
          ...(request.caption ? { caption: request.caption } : {}),
          ...(request.filename ? { filename: request.filename } : {}),
          ...(request.type === 'audio' ? { voice: true } : {}),
        };
      }
      state.thread(customer.id).push({
        wamid: id,
        direction: 'in',
        type: request.type,
        text:
          request.type === 'text' || request.type === 'audio'
            ? (request.text ?? '')
            : (request.caption ?? null),
        mediaId: item.type === 'text' ? null : item.media.id,
        status: null,
        at,
      });
      const key = customer.id;
      state.lastInbound.set(key, Math.max(state.lastInbound.get(key) ?? 0, at));
      const list = byBusiness.get(customer.businessPhoneNumberId) ?? [];
      list.push(item);
      byBusiness.set(customer.businessPhoneNumberId, list);
      ids.push(id);
      broadcast('thread', { customerId: customer.id });
    }
    for (const [phoneNumberId, items] of byBusiness) {
      const business = state.businesses.get(phoneNumberId);
      if (business) dispatcher.send(inboundPayload(business, items));
    }
    return ids;
  };

  const app = express();
  app.disable('x-powered-by');

  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const expected = Buffer.from(`Bearer ${options.accessToken}`);
    const given = Buffer.from(header);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      next();
      return;
    }
    graphError(res, 401, 190, 'Invalid OAuth access token.');
  };

  // --- page and control API (used by the page and by tests) ---------------------
  app.get('/', (_req, res) => {
    res.type('html').send(simulatorPage());
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const control = express.Router();
  control.use(express.json({ limit: '20mb' }));
  control.get('/state', (_req, res) => {
    res.json({
      businesses: [...state.businesses.values()],
      customers: [...state.customers.values()],
      faults,
      delivered: dispatcher.delivered,
      failedDeliveries: dispatcher.failedDeliveries,
    });
  });
  control.get('/threads/:customerId', (req, res) => {
    res.json(state.thread(req.params.customerId));
  });
  control.post('/faults', (req, res) => {
    const parsed = faultSettingsSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message) });
      return;
    }
    faults = { ...faults, ...stripUndefined(parsed.data) };
    broadcast('faults', faults);
    res.json(faults);
  });
  control.post('/messages', (req, res) => {
    const parsed = z
      .array(inboundRequestSchema)
      .min(1)
      .max(500)
      .safeParse(Array.isArray(req.body) ? req.body : [req.body]);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    try {
      res.status(202).json({ wamids: sendInbound(parsed.data) });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : 'unknown' });
    }
  });
  // Load tests bring their own number and customers, apart from the demo ones.
  control.post('/businesses', (req, res) => {
    const parsed = z
      .object({
        phoneNumberId: z.string().regex(/^\d{5,25}$/),
        displayPhoneNumber: z.string().min(3).max(30),
        name: z.string().min(1).max(80),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message) });
      return;
    }
    state.businesses.set(parsed.data.phoneNumberId, parsed.data);
    res.status(201).json(parsed.data);
  });
  control.post('/customers', (req, res) => {
    const parsed = z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          bsuid: z.string().min(3).max(80),
          waId: z
            .string()
            .regex(/^\d{6,20}$/)
            .nullable(),
          businessPhoneNumberId: z.string(),
        }),
      )
      .min(1)
      .max(2_000)
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message) });
      return;
    }
    if (parsed.data.some((c) => !state.businesses.has(c.businessPhoneNumberId))) {
      res.status(404).json({ error: 'unknown business' });
      return;
    }
    res.status(201).json(parsed.data.map((c) => state.addCustomer(c)));
  });

  // The page plays voice notes from here (the Graph download needs the token).
  control.get('/media/:mediaId', (req, res) => {
    const media = state.media.get(req.params.mediaId);
    if (!media) {
      res.status(404).json({ error: 'unknown media' });
      return;
    }
    res.type(media.mimeType).send(Buffer.from(media.bytes));
  });
  control.post('/read/:customerId', (req, res) => {
    const customer = state.customers.get(req.params.customerId);
    if (!customer) {
      res.status(404).json({ error: 'unknown customer' });
      return;
    }
    for (const message of state.thread(customer.id)) {
      if (message.direction === 'out' && message.status === 'delivered')
        emitStatus(customer, message, 'read');
    }
    res.status(204).end();
  });
  control.post('/reset', (_req, res) => {
    state.reset();
    faults = { ...NO_FAULTS };
    broadcast('reset', {});
    res.status(204).end();
  });
  control.get('/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  });
  app.use('/control', control);

  // --- media download (URL handed out by GET /{media-id}) -------------------------
  app.get('/media-files/:mediaId', requireToken, (req, res) => {
    const media = state.media.get(String(req.params['mediaId']));
    if (!media) {
      graphError(res, 404, 100, 'Unknown media.');
      return;
    }
    res.type(media.mimeType).send(Buffer.from(media.bytes));
  });

  // --- Graph API subset ------------------------------------------------------------
  const graph = express.Router({ mergeParams: true });
  graph.use((req, res, next) => {
    if (!VERSION.test(String(req.params['version']))) {
      next('router');
      return;
    }
    requireToken(req, res, next);
  });

  graph.post('/:phoneNumberId/messages', express.json({ limit: '1mb' }), (req, res) => {
    const business = state.businesses.get(req.params['phoneNumberId']);
    if (!business) {
      graphError(res, 400, 100, 'Unsupported post request. Unknown phone number ID.');
      return;
    }
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      graphError(res, 400, 100, parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    const body = parsed.data;
    if (random() < faults.rateLimitRate) {
      graphError(res, 429, 130429, 'Rate limit hit');
      return;
    }
    if (random() < faults.failSendRate) {
      graphError(res, 500, 131000, 'Something went wrong');
      return;
    }
    const customer = state.findRecipient(business.phoneNumberId, body.recipient ?? body.to ?? '');
    if (!customer) {
      graphError(res, 400, 131026, 'Message undeliverable');
      return;
    }
    const lastInbound = state.lastInbound.get(customer.id) ?? 0;
    if (body.type !== 'template' && Date.now() - lastInbound > WINDOW_MS) {
      graphError(res, 400, 131047, 'Re-engagement message');
      return;
    }
    if (body.type === 'audio' && body.audio && !state.media.has(body.audio.id)) {
      graphError(res, 400, 131053, 'Media upload error: unknown media ID.');
      return;
    }
    // What a business voice note says, as the customer would hear it.
    const spoken = body.audio
      ? readMockVoiceNote(state.media.get(body.audio.id)?.bytes ?? new Uint8Array())?.text
      : undefined;
    const message: ThreadMessage = {
      wamid: wamid(),
      direction: 'out',
      type: body.type,
      text:
        body.text?.body ?? spoken ?? (body.template ? `[template ${body.template.name}]` : null),
      mediaId: body.audio?.id ?? null,
      status: 'accepted',
      at: Date.now(),
    };
    state.thread(customer.id).push(message);
    broadcast('thread', { customerId: customer.id });
    scheduleStatuses(customer, message);
    res.json({
      messaging_product: 'whatsapp',
      contacts: [
        {
          input: body.recipient ?? body.to,
          ...(customer.waId ? { wa_id: customer.waId } : {}),
          user_id: customer.bsuid,
        },
      ],
      messages: [{ id: message.wamid }],
    });
  });

  graph.post('/:phoneNumberId/media', async (req, res) => {
    try {
      const request = new Request(`http://simulator${req.originalUrl}`, {
        method: 'POST',
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === 'string' ? [[k, v]] : [],
        ),
        body: Readable.toWeb(req) as ReadableStream,
        duplex: 'half',
      });
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- simulator only: small test uploads; avoids a multipart parser dependency
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof Blob) || form.get('messaging_product') !== 'whatsapp') {
        graphError(res, 400, 100, 'file and messaging_product are required');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('base64');
      res.json({ id: state.storeMedia(bytes, file.type || 'application/octet-stream', sha256).id });
    } catch {
      graphError(res, 400, 100, 'Invalid multipart upload.');
    }
  });

  graph.get('/:mediaId', (req, res) => {
    const media = state.media.get(req.params['mediaId']);
    if (!media) {
      graphError(res, 404, 100, 'Unknown media.');
      return;
    }
    res.json({
      messaging_product: 'whatsapp',
      url: `${(options.publicUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`).replace(/\/$/, '')}/media-files/${media.id}`,
      mime_type: media.mimeType,
      sha256: media.sha256,
      file_size: media.bytes.byteLength,
      id: media.id,
    });
  });

  app.use('/:version', graph);

  return {
    app,
    state,
    dispatcher,
    get faults() {
      return faults;
    },
    setFaults(next) {
      faults = { ...faults, ...stripUndefined(next) };
    },
    sendInbound,
    async idle() {
      // Statuses schedule webhooks, so wait for statuses first, then deliveries.
      if (pendingStatuses > 0) await new Promise<void>((resolve) => statusWaiters.push(resolve));
      await dispatcher.idle();
      if (pendingStatuses > 0) await this.idle();
    },
    async listen(port, host = '127.0.0.1') {
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(port, host, () => {
          resolve(s);
        });
      });
      const { port: actual } = server.address() as AddressInfo;
      return {
        url: `http://${host}:${String(actual)}`,
        close: () =>
          new Promise<void>((resolve) => {
            for (const res of listeners) res.end();
            server.close(() => {
              resolve();
            });
          }),
      };
    },
    async verifyWebhook(verifyToken) {
      const challenge = String(Math.floor(random() * 1e9));
      const url = new URL(options.webhookUrl);
      url.searchParams.set('hub.mode', 'subscribe');
      url.searchParams.set('hub.verify_token', verifyToken);
      url.searchParams.set('hub.challenge', challenge);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return response.ok && (await response.text()) === challenge;
      } catch {
        return false;
      }
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
