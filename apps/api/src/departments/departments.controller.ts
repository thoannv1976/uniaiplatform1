import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DepartmentStore } from '@uniai/firestore';
import {
  createDepartmentRequestSchema,
  DEPARTMENT_CSV_COLUMNS,
  departmentCodeSchema,
  departmentToCsvRow,
  importRequestSchema,
  parseCsv,
  parseDepartmentRows,
  toCsv,
  updateDepartmentRequestSchema,
  type Department,
  type ImportResult,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';

export const DEPARTMENT_STORE = Symbol('DEPARTMENT_STORE');

@Controller('api/admin/departments')
export class DepartmentsController {
  constructor(
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'auditor', 'unit_admin', 'ai_admin')
  async list(): Promise<{ departments: Department[] }> {
    return { departments: await this.departments.list() };
  }

  @Get('export.csv')
  @Roles('super_admin', 'auditor')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="don-vi.csv"')
  async export(): Promise<string> {
    const list = await this.departments.list();
    return toCsv([...DEPARTMENT_CSV_COLUMNS], list.map(departmentToCsvRow));
  }

  @Post()
  @Roles('super_admin')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Department> {
    const input = parseOrBadRequest(createDepartmentRequestSchema, body);
    const created = await this.departments.create(input, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `department:${created.id}`,
      metadata: { action: 'create_department', department: input },
    });
    return created;
  }

  @Patch(':id')
  @Roles('super_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<Department> {
    const id = parseOrBadRequest(departmentCodeSchema, rawId);
    const patch = parseOrBadRequest(updateDepartmentRequestSchema, body);
    const { before, after } = await this.departments.update(id, patch, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `department:${id}`,
      metadata: {
        action: 'update_department',
        changes: patch,
        before: {
          name: before.name,
          type: before.type,
          parentId: before.parentId,
          status: before.status,
        },
      },
    });
    return after;
  }

  @Post('import')
  @HttpCode(200)
  @Roles('super_admin')
  async import(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ImportResult> {
    const { csv, dryRun } = parseOrBadRequest(importRequestSchema, body);
    const parsed = parseCsv(csv);
    const { rows, issues } = parseDepartmentRows(parsed);
    const result = await this.departments.importRows(rows, issues, {
      dryRun,
      by: auth.profile.uid,
      total: parsed.rows.length,
    });
    if (result.applied) {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: 'departments',
        metadata: {
          action: 'import_departments',
          created: result.created,
          updated: result.updated,
        },
      });
    }
    return result;
  }
}
