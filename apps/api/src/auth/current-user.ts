import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AppContext, AuthContext, AuthenticatedRequest } from './auth.guard.js';

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);

/** The application calling a Platform API endpoint (@AppScopeRequired). */
export const CurrentApp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AppContext =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().platformApp,
);
