import type { DbHandle } from '@app/db';
import {
  ingestWebhook,
  type Provider,
  type ProviderRegistry,
  type ProviderSettings,
  type Queues,
} from '@app/pipeline';
import type { Logger } from '@app/shared';
import { SIGNATURE_HEADER, verifyHandshake, verifySignature } from '@app/whatsapp';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Access } from '../auth/access.guard.js';
import { DB, LOGGER, PROVIDERS, QUEUES } from '../infra/tokens.js';

/**
 * WhatsApp webhooks, one route per provider (`meta`, `simulator`) so each is
 * checked with its own app secret (decision P-01). Authenticated by the
 * X-Hub-Signature-256 HMAC, not by a session.
 */
@Controller('webhooks/whatsapp')
@Access('webhook')
export class WhatsAppWebhookController {
  constructor(
    @Inject(PROVIDERS) private readonly providers: ProviderRegistry,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private settings(provider: string): { provider: Provider; settings: ProviderSettings } {
    if (provider !== 'meta' && provider !== 'simulator') throw new NotFoundException();
    const settings = this.providers.get(provider);
    if (!settings) throw new NotFoundException();
    return { provider, settings };
  }

  /** Meta's verification handshake: echo hub.challenge if hub.verify_token matches. */
  @Get(':provider')
  handshake(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): void {
    const { settings } = this.settings(provider);
    const challenge = verifyHandshake(query, settings.verifyToken);
    if (challenge === null) throw new ForbiddenException('Verification failed.');
    res.type('text/plain').send(challenge);
  }

  /**
   * Verify, store, enqueue, answer. No parsing beyond the signature check, so
   * Meta gets its 200 in milliseconds and a processing bug cannot lose events.
   */
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() req: Request,
  ): Promise<{ received: true }> {
    const { provider: name, settings } = this.settings(provider);
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Expected a JSON body.');
    }
    if (!verifySignature(body, req.header(SIGNATURE_HEADER), settings.appSecret)) {
      this.logger.warn({ provider: name }, 'webhook rejected: bad signature');
      throw new UnauthorizedException('Invalid signature.');
    }
    await ingestWebhook(this.db.db, this.queues, name, body.toString('utf8'));
    return { received: true };
  }
}
