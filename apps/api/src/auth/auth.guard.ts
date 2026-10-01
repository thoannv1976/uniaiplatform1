import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserStore } from '@uniai/firestore';
import { isAllowedEmail, type Role, type UserProfile } from '@uniai/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ALLOW_INACTIVE, IS_PUBLIC, ROLES_KEY } from './decorators.js';
import { TOKEN_VERIFIER, type TokenVerifier, type VerifiedToken } from './token-verifier.js';

export const USER_STORE = Symbol('USER_STORE');

export interface AuthContext {
  token: VerifiedToken & { email: string };
  profile: UserProfile;
}

export interface AuthenticatedRequest extends Request {
  auth: AuthContext;
}

const INACTIVE_MESSAGES = {
  pending: 'Tài khoản đang chờ quản trị viên duyệt.',
  locked: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.',
} as const;

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Global guard: authenticates every request (Firebase ID token, verified email of an
 * allowed domain), loads or provisions the user profile, then enforces status and roles.
 * Endpoints are denied unless they declare @Public() or @Roles(...).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private meta<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.meta<boolean>(IS_PUBLIC, context)) return true;

    const roles = this.meta<Role[]>(ROLES_KEY, context);
    if (!roles) {
      this.logger.error(
        `Endpoint thiếu @Roles: ${context.getClass().name}.${context.getHandler().name}`,
      );
      throw new ForbiddenException('Endpoint chưa được cấu hình phân quyền.');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const raw = bearerToken(req);
    if (!raw) throw new UnauthorizedException('Bạn chưa đăng nhập.');

    let token: VerifiedToken;
    try {
      token = await this.verifier.verify(raw);
    } catch {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }

    const domains = this.config.allowedEmailDomains;
    if (!token.emailVerified || !isAllowedEmail(token.email, domains)) {
      this.audit.recordQuietly({
        event: 'AUTH_DENIED',
        actor: token.uid,
        metadata: { reason: 'email_domain', email: token.email ?? null },
      });
      throw new ForbiddenException(
        `Chỉ chấp nhận tài khoản email ${domains.map((d) => '@' + d).join(', ')} đã xác minh.`,
      );
    }
    const email = token.email as string;

    let profile = await this.users.get(token.uid);
    if (!profile) {
      const result = await this.users.provision({
        uid: token.uid,
        email,
        name: token.name ?? null,
      });
      profile = result.profile;
      if (result.created) {
        this.audit.recordQuietly({
          event: 'USER_PROVISIONED',
          actor: token.uid,
          target: token.uid,
          metadata: { email, role: profile.role, status: profile.status },
        });
      }
    }

    (req as AuthenticatedRequest).auth = { token: { ...token, email }, profile };

    if (profile.status !== 'active' && !this.meta<boolean>(ALLOW_INACTIVE, context)) {
      throw new ForbiddenException(INACTIVE_MESSAGES[profile.status]);
    }
    if (!roles.includes(profile.role)) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này.');
    }
    return true;
  }
}
