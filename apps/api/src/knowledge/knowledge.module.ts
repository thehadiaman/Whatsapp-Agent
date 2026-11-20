import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { KnowledgeController } from './knowledge.controller.js';

@Module({
  imports: [TenancyModule],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}
