import {
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
import type { ConversationStore, ProjectStore } from '@uniai/firestore';
import {
  conversationIdSchema,
  createConversationRequestSchema,
  updateConversationRequestSchema,
  type Conversation,
  type ConversationDetail,
} from '@uniai/shared';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PROJECT_STORE } from '../workspace/tokens.js';
import { CONVERSATION_STORE } from './chat.service.js';

const NOT_FOUND = 'Không tìm thấy hội thoại.';

function idOr404(raw: string): string {
  const parsed = conversationIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException(NOT_FOUND);
  return parsed.data;
}

/** The caller's own conversations only; other people's look exactly like missing ones. */
@Controller('api/conversations')
export class ConversationsController {
  constructor(
    @Inject(CONVERSATION_STORE) private readonly conversations: ConversationStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROJECT_STORE) private readonly projects: ProjectStore,
  ) {}

  private async checkProject(uid: string, projectId: string | null | undefined) {
    if (projectId && !(await this.projects.get(projectId, uid))) {
      throw new NotFoundException('Không tìm thấy dự án.');
    }
  }

  @Get()
  @AnyRole()
  async list(@CurrentAuth() auth: AuthContext): Promise<{ conversations: Conversation[] }> {
    return { conversations: await this.conversations.list(auth.profile.uid) };
  }

  @Post()
  @AnyRole()
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Conversation> {
    const { title, projectId } = parseOrBadRequest(createConversationRequestSchema, body ?? {});
    await this.checkProject(auth.profile.uid, projectId);
    return this.conversations.create(
      auth.profile.uid,
      title ?? 'Hội thoại mới',
      this.config.conversationRetentionDays,
      projectId ?? null,
    );
  }

  @Get(':id')
  @AnyRole()
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('id') raw: string,
  ): Promise<ConversationDetail> {
    const id = idOr404(raw);
    const conversation = await this.conversations.get(id, auth.profile.uid);
    if (!conversation) throw new NotFoundException(NOT_FOUND);
    return { conversation, messages: await this.conversations.listMessages(id) };
  }

  @Patch(':id')
  @AnyRole()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') raw: string,
    @Body() body: unknown,
  ): Promise<Conversation> {
    const id = idOr404(raw);
    const patch = parseOrBadRequest(updateConversationRequestSchema, body);
    await this.checkProject(auth.profile.uid, patch.projectId);
    const updated = await this.conversations.update(id, auth.profile.uid, patch);
    if (!updated) throw new NotFoundException(NOT_FOUND);
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  @AnyRole()
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') raw: string): Promise<void> {
    if (!(await this.conversations.delete(idOr404(raw), auth.profile.uid))) {
      throw new NotFoundException(NOT_FOUND);
    }
  }
}
