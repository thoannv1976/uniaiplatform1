import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { UserStore } from '@uniai/firestore';
import { acceptTermsRequestSchema, TERMS_VERSION, type MeResponse } from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AllowInactive, AnyRole } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';

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

  /** The user accepts the current terms of use (spec 12: at first sign-in). */
  @Post('me/terms')
  @HttpCode(204)
  @AnyRole()
  async acceptTerms(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    const { version } = parseOrBadRequest(acceptTermsRequestSchema, body);
    if (version !== TERMS_VERSION) {
      throw new BadRequestException('Điều khoản đã được cập nhật. Hãy tải lại trang và đọc lại.');
    }
    if (auth.profile.termsVersion === version) return;
    await this.users.acceptTerms(auth.profile.uid, version);
    await this.audit.record({
      event: 'TERMS_ACCEPTED',
      actor: auth.profile.uid,
      metadata: { version },
    });
  }
}
