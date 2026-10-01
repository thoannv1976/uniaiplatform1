import {
  apiErrorSchema,
  healthResponseSchema,
  meResponseSchema,
  userListResponseSchema,
  userProfileSchema,
  type HealthResponse,
  type MeResponse,
  type UpdateUserRequest,
  type UserProfile,
  type UserStatus,
} from '@uniai/shared';
import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return new ApiError(
    res.status,
    parsed.success ? parsed.data.message : `API trả về mã ${res.status}`,
  );
}

async function call(path: string, token: string | null, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return healthResponseSchema.parse(await call('/healthz', null, { signal }));
}

export async function fetchMe(idToken: string, signal?: AbortSignal): Promise<MeResponse> {
  return meResponseSchema.parse(await call('/api/me', idToken, { signal }));
}

export async function fetchUsers(idToken: string, status?: UserStatus): Promise<UserProfile[]> {
  const query = status ? `?status=${status}` : '';
  return userListResponseSchema.parse(await call(`/api/admin/users${query}`, idToken)).users;
}

export async function updateUser(
  idToken: string,
  uid: string,
  patch: UpdateUserRequest,
): Promise<UserProfile> {
  const body = JSON.stringify(patch);
  return userProfileSchema.parse(
    await call(`/api/admin/users/${encodeURIComponent(uid)}`, idToken, { method: 'PATCH', body }),
  );
}
