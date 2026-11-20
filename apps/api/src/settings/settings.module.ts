import { Module } from '@nestjs/common';
import { AnalyticsController } from '../analytics/analytics.controller.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js';
import { SettingsController } from './settings.controller.js';
import { LinksController, StaffController } from './staff.controller.js';

@Module({
  imports: [TenancyModule, WhatsAppModule],
  controllers: [SettingsController, StaffController, LinksController, AnalyticsController],
})
export class SettingsModule {}
