import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { FileStore, ProjectStore } from '@uniai/firestore';
import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
  type Project,
} from '@uniai/shared';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { FILE_STORE } from '../files/files.service.js';
import { PROJECT_STORE } from './tokens.js';

const NOT_FOUND = 'Không tìm thấy dự án.';

/** Projects (spec 8.10): the caller's own; other people's look missing. */
@Controller('api/projects')
export class ProjectsController {
  constructor(
    @Inject(PROJECT_STORE) private readonly projects: ProjectStore,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  private async checkFiles(uid: string, ids: string[] | undefined) {
    if (!ids?.length) return;
    const found = await this.files.getMany([...new Set(ids)], uid);
    if (found.length !== new Set(ids).size || found.some((f) => f.status !== 'ready')) {
      throw new BadRequestException('Có tệp không tồn tại hoặc chưa xử lý xong.');
    }
  }

  @Get()
  @AnyRole()
  async list(@CurrentAuth() auth: AuthContext): Promise<{ projects: Project[] }> {
    return { projects: await this.projects.list(auth.profile.uid) };
  }

  @Post()
  @AnyRole()
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Project> {
    const input = parseOrBadRequest(createProjectRequestSchema, body);
    await this.checkFiles(auth.profile.uid, input.fileIds);
    return this.projects.create(input, auth.profile.uid);
  }

  @Patch(':id')
  @AnyRole()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Project> {
    const patch = parseOrBadRequest(updateProjectRequestSchema, body);
    await this.checkFiles(auth.profile.uid, patch.fileIds);
    const p = /^[A-Za-z0-9]{1,64}$/.test(id)
      ? await this.projects.update(id, auth.profile.uid, patch)
      : null;
    if (!p) throw new NotFoundException(NOT_FOUND);
    return p;
  }

  @Delete(':id')
  @HttpCode(204)
  @AnyRole()
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(id) || !(await this.projects.delete(id, auth.profile.uid))) {
      throw new NotFoundException(NOT_FOUND);
    }
  }
}
