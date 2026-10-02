import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { KillSwitchStore } from '@uniai/firestore';
import { updateKillSwitchRequestSchema, type KillSwitch } from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { KILL_SWITCH_STORE, KillSwitchService } from './kill-switch.service.js';

/** Kill switch (spec 8.8): Super Admin and AI Admin switch AI off; every change is audited. */
@Controller('api/admin/kill-switch')
export class KillSwitchController {
  constructor(
    @Inject(KILL_SWITCH_STORE) private readonly store: KillSwitchStore,
    private readonly service: KillSwitchService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'ai_admin', 'auditor')
  async get(): Promise<KillSwitch> {
    return this.store.get();
  }

  @Put()
  @Roles('super_admin', 'ai_admin')
  async set(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<KillSwitch> {
    const value = parseOrBadRequest(updateKillSwitchRequestSchema, body);
    const before = await this.store.get();
    const after = await this.store.set(value, auth.profile.uid);
    this.service.set(after);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: 'settings:killSwitch',
      metadata: {
        action: 'kill_switch',
        before: {
          all: before.all,
          providers: before.providers,
          models: before.models,
          tiers: before.tiers,
        },
        after: {
          all: after.all,
          providers: after.providers,
          models: after.models,
          tiers: after.tiers,
        },
        reason: after.reason,
        autoBrakePercent: after.autoBrakePercent,
      },
    });
    return after;
  }
}
