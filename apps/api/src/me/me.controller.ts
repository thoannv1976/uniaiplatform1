import { Controller, Get, Inject } from '@nestjs/common';
import type { UserStore } from '@uniai/firestore';
import type { MeResponse } from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AllowInactive, AnyRole } from '../auth/decorators.js';

/** A new USER_LOGIN audit entry is written when the previous sign-in is older than this. */
const LOGIN_AUDIT_GAP_MS = 30 * 60 * 1000;

@Controller('api')
export class MeController {
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @AnyRole()
  @AllowInactive()
  async me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    const previous = await this.users.touchLogin(auth.profile.uid);
    if (!previous || Date.now() - previous.getTime() > LOGIN_AUDIT_GAP_MS) {
      this.audit.recordQuietly({
        event: 'USER_LOGIN',
        actor: auth.profile.uid,
        metadata: { status: auth.profile.status },
      });
    }
    return auth.profile;
  }
}
