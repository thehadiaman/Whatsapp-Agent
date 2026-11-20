import type { DbHandle } from '@app/db';
import { subscribeToEvents } from '@app/pipeline';
import { INBOX_EVENT, INBOX_SOCKET_PATH, type Logger } from '@app/shared';
import { Inject, type OnModuleDestroy } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import type { Auth } from '../auth/auth.js';
import { API_CONFIG, trustedOrigin, type ApiConfig } from '../config.js';
import { AUTH, DB, LOGGER } from '../infra/tokens.js';

const room = (tenantId: string) => `tenant:${tenantId}`;
const userRoom = (userId: string) => `user:${userId}`;

interface SocketData {
  tenantId: string;
  userId: string;
}

/**
 * Live updates for the inbox. Receive-only: clients cannot send events.
 *
 * - Handshake: the request must come from the web app (see
 *   `fromTrustedOrigin`), the session cookie must be valid, and the user must
 *   belong to a business. The socket joins only that business's room.
 * - Events come from Redis (worker and API publish there) and carry IDs
 *   only; the inbox refetches through the API, where row-level security
 *   applies, so a socket can never receive another tenant's content.
 */
// addTrailingSlash: false — proxies (Next.js rewrites in dev) drop the trailing
// slash from /api/socket.io/, so match the path without it.
/**
 * Cross-site WebSocket hijacking guard. Browsers omit Origin on same-origin
 * GET requests, and Socket.IO's polling handshake is a GET, so a missing
 * Origin is normal. A cross-site browser request always carries Origin, or
 * `Sec-Fetch-Site: cross-site`. A non-browser client can forge both headers
 * anyway; the session check is what stops it.
 */
export function fromTrustedOrigin(
  headers: Record<string, string | string[] | undefined>,
  trusted: string,
): boolean {
  const origin = headers['origin'];
  if (origin !== undefined) return origin === trusted;
  const site = headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

@WebSocketGateway({ path: INBOX_SOCKET_PATH, addTrailingSlash: false, serveClient: false })
export class InboxGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() private server!: Server;
  private subscriber: Redis | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private readonly origin: string;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.origin = trustedOrigin(config);
  }

  async afterInit(server: Server): Promise<void> {
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(error instanceof Error ? error : new Error('unauthorized'));
        },
      );
    });

    // A subscribed Redis connection can do nothing else, so it gets its own.
    this.subscriber = new Redis(this.config.REDIS_URL);
    this.subscriber.on('error', (error) => {
      this.logger.warn({ err: error }, 'event subscriber error');
    });
    this.unsubscribe = await subscribeToEvents(
      this.subscriber,
      (event) => {
        server.to(room(event.tenantId)).emit(INBOX_EVENT, { conversationId: event.conversationId });
      },
      this.logger,
    );
  }

  private async authenticate(socket: Socket): Promise<void> {
    if (!fromTrustedOrigin(socket.handshake.headers, this.origin))
      throw new Error('forbidden origin');
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(socket.handshake.headers),
    });
    if (!session) throw new Error('unauthorized');
    const membership = await this.db.db.execute<{ tenant_id: string }>(
      sql`select tenant_id from auth_membership(${session.user.id})`,
    );
    const tenantId = membership.rows[0]?.tenant_id;
    if (!tenantId) throw new Error('no business');
    const data: SocketData = { tenantId, userId: session.user.id };
    socket.data = data;
  }

  async handleConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    await socket.join([room(data.tenantId), userRoom(data.userId)]);
  }

  /**
   * Closes a removed person's live connections at once. Their session is
   * already gone, so they cannot reconnect. One API instance (the hosting
   * plan); several would need the Socket.IO Redis adapter for this to reach all.
   */
  disconnectUser(userId: string): void {
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribe?.();
    this.subscriber?.disconnect();
  }
}
