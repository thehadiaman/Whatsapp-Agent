import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ConversationsController } from './conversations.controller.js';
import { WhatsAppWebhookController } from './webhook.controller.js';

@Module({
  imports: [TenancyModule],
  controllers: [WhatsAppWebhookController, ConversationsController],
})
export class WhatsAppModule {}
