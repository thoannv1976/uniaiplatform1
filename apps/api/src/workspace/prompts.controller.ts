import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DepartmentStore, PromptRecord, PromptStore, UserStore } from '@uniai/firestore';
import {
  createPromptRequestSchema,
  updatePromptRequestSchema,
  type Prompt,
  type UserProfile,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { PROMPT_STORE } from './tokens.js';

const LIBRARY_ADMINS = ['super_admin', 'ai_admin'];
const NOT_FOUND = 'Không tìm thấy prompt.';

/**
 * Prompt library (spec 8.10): everyone keeps private prompts; AI Admins (and Super Admins)
 * publish prompts to the whole university or to units, Unit Admins to units of their own.
 */
@Controller('api/prompts')
export class PromptsController {
  constructor(
    @Inject(PROMPT_STORE) private readonly prompts: PromptStore,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    private readonly audit: AuditService,
  ) {}

  private canEdit(p: PromptRecord, user: UserProfile): boolean {
    if (p.visibility === 'private') return p.ownerUid === user.uid;
    if (LIBRARY_ADMINS.includes(user.role)) return true;
    return user.role === 'unit_admin' && p.ownerUid === user.uid;
  }

  private view(p: PromptRecord, user: UserProfile): Prompt {
    const { createdByRole: _role, ...rest } = p;
    void _role;
    return { ...rest, editable: this.canEdit(p, user) };
  }

  /** Who may publish where: library admins anywhere, Unit Admins inside their unit. */
  private async checkPublish(user: UserProfile, visibility: string, publishedTo: string[]) {
    if (visibility !== 'shared') return;
    if (LIBRARY_ADMINS.includes(user.role)) {
      const known = await this.departments.map();
      if (publishedTo.some((id) => !known.has(id))) {
        throw new BadRequestException('Đơn vị nhận prompt không tồn tại.');
      }
      return;
    }
    if (user.role !== 'unit_admin' || !user.scopeDepartmentId) {
      throw new ForbiddenException('Chỉ quản trị viên mới chia sẻ prompt cho đơn vị.');
    }
    const known = await this.departments.map();
    const scope = user.scopeDepartmentId;
    if (
      publishedTo.length === 0 ||
      publishedTo.some((id) => !known.get(id)?.path.includes(scope))
    ) {
      throw new ForbiddenException('Bạn chỉ chia sẻ prompt cho đơn vị mình quản lý.');
    }
  }

  @Get()
  @AnyRole()
  async list(@CurrentAuth() auth: AuthContext): Promise<{ prompts: Prompt[] }> {
    const user = auth.profile;
    const path = await this.users.departmentPathOf(user.uid);
    const list = await this.prompts.visible(user.uid, path, LIBRARY_ADMINS.includes(user.role));
    return { prompts: list.map((p) => this.view(p, user)) };
  }

  @Post()
  @AnyRole()
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Prompt> {
    const input = parseOrBadRequest(createPromptRequestSchema, body);
    await this.checkPublish(auth.profile, input.visibility, input.publishedTo);
    const p = await this.prompts.create(input, auth.profile.uid, auth.profile.role);
    if (p.visibility === 'shared') {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: `prompts/${p.id}`,
        metadata: { action: 'publish_prompt', publishedTo: p.publishedTo },
      });
    }
    return this.view(p, auth.profile);
  }

  private async own(id: string, user: UserProfile): Promise<PromptRecord> {
    const p = /^[A-Za-z0-9]{1,64}$/.test(id) ? await this.prompts.get(id) : null;
    if (!p) throw new NotFoundException(NOT_FOUND);
    if (!this.canEdit(p, user)) {
      // Other people's private prompts look missing; shared ones are read-only.
      if (p.visibility === 'private') throw new NotFoundException(NOT_FOUND);
      throw new ForbiddenException('Bạn không sửa được prompt dùng chung này.');
    }
    return p;
  }

  @Patch(':id')
  @AnyRole()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Prompt> {
    const current = await this.own(id, auth.profile);
    const patch = parseOrBadRequest(updatePromptRequestSchema, body);
    const visibility = patch.visibility ?? current.visibility;
    await this.checkPublish(auth.profile, visibility, patch.publishedTo ?? current.publishedTo);
    const p = await this.prompts.update(current.id, patch);
    if (current.visibility === 'shared' || p.visibility === 'shared') {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: `prompts/${p.id}`,
        metadata: { action: 'update_prompt', visibility: p.visibility, publishedTo: p.publishedTo },
      });
    }
    return this.view(p, auth.profile);
  }

  @Delete(':id')
  @HttpCode(204)
  @AnyRole()
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    const p = await this.own(id, auth.profile);
    await this.prompts.delete(p.id);
    if (p.visibility === 'shared') {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: `prompts/${p.id}`,
        metadata: { action: 'delete_prompt' },
      });
    }
  }
}
