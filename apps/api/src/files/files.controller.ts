import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  createFileRequestSchema,
  fileIdSchema,
  type CreateFileResponse,
  type FileView,
} from '@uniai/shared';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { FilesService } from './files.service.js';

function idOr404(raw: string): string {
  const parsed = fileIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException('Không tìm thấy tệp.');
  return parsed.data;
}

/**
 * Chat attachments (spec 8.3, API "POST /api/files"). The caller's own files only; other
 * people's look exactly like missing ones.
 */
@Controller('api/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Registers an upload and returns where the browser should PUT the file. */
  @Post()
  @AnyRole()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<CreateFileResponse> {
    return this.files.create(auth.profile.uid, parseOrBadRequest(createFileRequestSchema, body));
  }

  /** Local development only (FILE_UPLOAD_MODE=proxy); 404 on Cloud Run. */
  @Put(':id/content')
  @HttpCode(204)
  @AnyRole()
  async content(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.files.receive(auth.profile.uid, idOr404(id), body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @AnyRole()
  async complete(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<FileView> {
    return this.files.complete(auth.profile.uid, idOr404(id));
  }

  @Get(':id')
  @AnyRole()
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<FileView> {
    return this.files.get(auth.profile.uid, idOr404(id));
  }

  @Delete(':id')
  @HttpCode(204)
  @AnyRole()
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    await this.files.remove(auth.profile.uid, idOr404(id));
  }
}
