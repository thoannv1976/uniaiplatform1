import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import type { UserStore } from '@uniai/firestore';
import { updateUserRequestSchema, userStatusSchema, type UserProfile } from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { IDENTITY_ADMIN, type IdentityAdmin } from '../auth/token-verifier.js';
import { parseOrBadRequest } from '../common/zod.js';

@Controller('api/admin/users')
export class AdminUsersController {
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(IDENTITY_ADMIN) private readonly identity: IdentityAdmin,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'auditor', 'unit_admin')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('status') status?: string,
  ): Promise<{ users: UserProfile[] }> {
    const statusFilter = status ? parseOrBadRequest(userStatusSchema, status) : undefined;
    if (auth.profile.role === 'unit_admin') {
      // Unit admins only see their own department; without a scope they see nobody.
      const scope = auth.profile.scopeDepartmentId;
      if (!scope) return { users: [] };
      return { users: await this.users.list({ status: statusFilter, departmentId: scope }) };
    }
    return { users: await this.users.list({ status: statusFilter }) };
  }

  @Patch(':uid')
  @Roles('super_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('uid') uid: string,
    @Body() body: unknown,
  ): Promise<UserProfile> {
    // Firebase uids are at most 128 URL-safe characters; anything else (e.g. a decoded "/")
    // must not reach Firestore as a document path.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid))
      throw new NotFoundException('Không tìm thấy người dùng.');
    const patch = parseOrBadRequest(updateUserRequestSchema, body);
    if (uid === auth.profile.uid && (patch.role !== undefined || patch.status !== undefined)) {
      throw new BadRequestException(
        'Không thể tự thay đổi vai trò hoặc trạng thái của chính mình.',
      );
    }
    const result = await this.users.update(uid, patch, auth.profile.uid);
    if (!result) throw new NotFoundException('Không tìm thấy người dùng.');

    if (patch.status === 'locked' && result.before.status !== 'locked') {
      await this.identity.revokeSessions(uid);
    }
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: uid,
      metadata: { action: 'update_user', changes: patch, before: pick(result.before, patch) },
    });
    const updated = await this.users.get(uid);
    if (!updated) throw new NotFoundException('Không tìm thấy người dùng.');
    return updated;
  }
}

function pick(profile: UserProfile, patch: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(patch).map((k) => [k, profile[k as keyof UserProfile] ?? null]),
  );
}
