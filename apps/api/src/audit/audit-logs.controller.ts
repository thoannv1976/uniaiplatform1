import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { AuditStore } from '@uniai/firestore';
import type { AuditLog } from '@uniai/shared';
import { Roles } from '../auth/decorators.js';
import { AUDIT_STORE } from './audit.service.js';

@Controller('api/admin/audit-logs')
export class AuditLogsController {
  constructor(@Inject(AUDIT_STORE) private readonly store: AuditStore) {}

  @Get()
  @Roles('super_admin', 'auditor')
  async list(@Query('limit') limit?: string): Promise<{ logs: AuditLog[] }> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return { logs: await this.store.list(n) };
  }
}
