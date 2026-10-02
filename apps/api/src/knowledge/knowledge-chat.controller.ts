import { Controller, Get } from '@nestjs/common';
import type { ChatKnowledgeBase } from '@uniai/shared';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { KnowledgeRetrieval } from './retrieval.service.js';

/** Knowledge bases the caller may consult in chat (M13). */
@Controller('api/knowledge-bases')
export class KnowledgeChatController {
  constructor(private readonly retrieval: KnowledgeRetrieval) {}

  @Get()
  @AnyRole()
  async list(@CurrentAuth() auth: AuthContext): Promise<{ knowledgeBases: ChatKnowledgeBase[] }> {
    return { knowledgeBases: await this.retrieval.options(auth.profile) };
  }
}
