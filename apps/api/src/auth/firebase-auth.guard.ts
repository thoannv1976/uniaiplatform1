import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isAllowedEmail } from '@uniai/shared';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { TOKEN_VERIFIER, type TokenVerifier, type VerifiedToken } from './token-verifier.js';

export interface AuthenticatedRequest extends Request {
  user: VerifiedToken & { email: string };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Requires a valid Firebase ID token whose email is verified and belongs to an allowed
 * domain. Role checks (RBAC) are layered on top in M2.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(req);
    if (!token) throw new UnauthorizedException('Bạn chưa đăng nhập.');

    let user: VerifiedToken;
    try {
      user = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }

    const domains = this.config.allowedEmailDomains;
    if (!user.emailVerified || !isAllowedEmail(user.email, domains)) {
      throw new ForbiddenException(
        `Chỉ chấp nhận tài khoản email ${domains.map((d) => '@' + d).join(', ')} đã xác minh.`,
      );
    }

    (req as AuthenticatedRequest).user = { ...user, email: user.email as string };
    return true;
  }
}
