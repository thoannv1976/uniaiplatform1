import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { chatRequestSchema, type ChatModelOption } from '@uniai/shared';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole } from '../auth/decorators.js';
import { requireTerms } from '../common/terms.js';
import { parseOrBadRequest } from '../common/zod.js';
import { ChatService } from './chat.service.js';
import { ModelRouter } from './model-router.js';

@Controller('api/ai')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly router: ModelRouter,
  ) {}

  /** Models the current user may choose besides AUTO. */
  @Get('models')
  @AnyRole()
  async models(@CurrentAuth() auth: AuthContext): Promise<{ models: ChatModelOption[] }> {
    return { models: await this.router.options(auth.profile.role) };
  }

  /** Streams the answer as Server-Sent Events (see chatStreamEventSchema). */
  @Post('chat')
  @AnyRole()
  async chat(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    requireTerms(auth.profile);
    const request = parseOrBadRequest(chatRequestSchema, body);
    await this.chatService.chat(auth.profile, request, res);
  }
}
