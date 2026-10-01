import { Controller, Get, UseGuards } from '@nestjs/common';
import type { MeResponse } from '@uniai/shared';
import { CurrentUser } from '../auth/current-user.js';
import { FirebaseAuthGuard, type AuthenticatedRequest } from '../auth/firebase-auth.guard.js';

@Controller('api')
@UseGuards(FirebaseAuthGuard)
export class MeController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedRequest['user']): MeResponse {
    return { uid: user.uid, email: user.email, name: user.name ?? null };
  }
}
