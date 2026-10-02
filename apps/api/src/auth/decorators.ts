import { SetMetadata } from '@nestjs/common';
import { ROLES, type AppScope, type Role } from '@uniai/shared';

export const IS_PUBLIC = 'uniai:isPublic';
export const ROLES_KEY = 'uniai:roles';
export const ALLOW_INACTIVE = 'uniai:allowInactive';
export const APP_SCOPE = 'uniai:appScope';

/** No authentication at all (health checks only). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Roles allowed to call the endpoint. Every non-public endpoint MUST declare this;
 * the global AuthGuard denies endpoints that do not.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const AnyRole = () => Roles(...ROLES);

/** Lets pending/locked accounts through (only GET /api/me, so the UI can explain why). */
export const AllowInactive = () => SetMetadata(ALLOW_INACTIVE, true);

/**
 * Platform API (M17): the caller is an internal application authenticated by its key
 * (Authorization: Bearer uak_…) holding this scope – not a staff login.
 */
export const AppScopeRequired = (scope: AppScope) => SetMetadata(APP_SCOPE, scope);
