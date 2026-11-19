import { Module } from '@nestjs/common';
import {
  ConversationsController,
  MediaController,
  MessagesController,
} from '../inbox/conversations.controller.js';
import { InboxGateway } from '../inbox/inbox.gateway.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { WhatsAppWebhookController } from './webhook.controller.js';

@Module({
  imports: [TenancyModule],
  controllers: [
    WhatsAppWebhookController,
    ConversationsController,
    MessagesController,
    MediaController,
  ],
  providers: [InboxGateway],
})
export class WhatsAppModule {}
