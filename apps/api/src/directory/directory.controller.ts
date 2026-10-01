import {
  Body,
  Controller,
  HttpCode,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DepartmentStore, DirectoryActor, UserStore } from '@uniai/firestore';
import {
  directoryToCsvRow,
  importRequestSchema,
  isAllowedEmail,
  parseCsv,
  parseDirectoryRows,
  toCsv,
  updateDirectoryRequestSchema,
  USER_CSV_COLUMNS,
  type DirectoryEntry,
  type ImportResult,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { IDENTITY_ADMIN, type IdentityAdmin } from '../auth/token-verifier.js';
import { parseOrBadRequest } from '../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';

function actorOf(auth: AuthContext): DirectoryActor {
  return {
    uid: auth.profile.uid,
    role: auth.profile.role,
    scopeDepartmentId: auth.profile.scopeDepartmentId,
  };
}

/** Unit Admins only see their subtree; one without a scope sees nobody. */
function scopeFilter(auth: AuthContext): { withinDepartment?: string } | null {
  if (auth.profile.role !== 'unit_admin') return {};
  return auth.profile.scopeDepartmentId
    ? { withinDepartment: auth.profile.scopeDepartmentId }
    : null;
}

@Controller('api/admin/directory')
export class DirectoryController {
  constructor(
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    @Inject(IDENTITY_ADMIN) private readonly identity: IdentityAdmin,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'auditor', 'unit_admin')
  async list(@CurrentAuth() auth: AuthContext): Promise<{ entries: DirectoryEntry[] }> {
    const filter = scopeFilter(auth);
    return { entries: filter ? await this.users.listDirectory(filter) : [] };
  }

  @Get('export.csv')
  @Roles('super_admin', 'auditor', 'unit_admin')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="can-bo.csv"')
  async export(@CurrentAuth() auth: AuthContext): Promise<string> {
    const filter = scopeFilter(auth);
    const entries = filter ? await this.users.listDirectory(filter) : [];
    return toCsv([...USER_CSV_COLUMNS], entries.map(directoryToCsvRow));
  }

  @Patch(':email')
  @Roles('super_admin', 'unit_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('email') email: string,
    @Body() body: unknown,
  ): Promise<DirectoryEntry> {
    // Plain addresses only: the email becomes a Firestore document id.
    if (
      !/^[^\s/@]+@[^\s/@]+$/.test(email) ||
      !isAllowedEmail(email, this.config.allowedEmailDomains)
    ) {
      throw new NotFoundException('Không tìm thấy cán bộ trong danh bạ.');
    }
    if (auth.profile.role === 'unit_admin' && !auth.profile.scopeDepartmentId) {
      throw new ForbiddenException('Bạn chưa được gán đơn vị quản lý.');
    }
    const patch = parseOrBadRequest(updateDirectoryRequestSchema, body);
    const { before, after, revokeUid } = await this.users.updateEntry(email, patch, actorOf(auth));
    if (revokeUid) await this.identity.revokeSessions(revokeUid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: before.uid ?? before.email,
      metadata: {
        action: 'update_directory',
        email: before.email,
        changes: patch,
        before: Object.fromEntries(
          Object.keys(patch).map((k) => [k, before[k as keyof DirectoryEntry] ?? null]),
        ),
      },
    });
    return after;
  }

  @Post('import')
  @HttpCode(200)
  @Roles('super_admin', 'unit_admin')
  async import(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ImportResult> {
    if (auth.profile.role === 'unit_admin' && !auth.profile.scopeDepartmentId) {
      throw new ForbiddenException('Bạn chưa được gán đơn vị quản lý.');
    }
    const { csv, dryRun } = parseOrBadRequest(importRequestSchema, body);
    const parsed = parseCsv(csv);
    const { rows, issues } = parseDirectoryRows(parsed, (e) =>
      isAllowedEmail(e, this.config.allowedEmailDomains),
    );
    const { revokeUids, ...result } = await this.users.importDirectory(rows, issues, {
      dryRun,
      actor: actorOf(auth),
      departments: await this.departments.map(),
      total: parsed.rows.length,
    });
    for (const uid of revokeUids) await this.identity.revokeSessions(uid);
    if (result.applied) {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: 'userDirectory',
        metadata: {
          action: 'import_directory',
          created: result.created,
          updated: result.updated,
          locked: revokeUids.length,
        },
      });
    }
    return result;
  }
}
