import {
  departmentListResponseSchema,
  departmentSchema,
  directoryEntrySchema,
  directoryListResponseSchema,
  importResultSchema,
  type CreateDepartmentRequest,
  type Department,
  type DirectoryEntry,
  type ImportResult,
  type UpdateDepartmentRequest,
  type UpdateDirectoryRequest,
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
  return healthResponseSchema.parse(await call('/health', null, { signal }));
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

// ---- M3: departments and staff directory ----

export async function fetchDepartments(idToken: string): Promise<Department[]> {
  return departmentListResponseSchema.parse(await call('/api/admin/departments', idToken))
    .departments;
}

export async function createDepartment(idToken: string, input: CreateDepartmentRequest) {
  const body = JSON.stringify(input);
  return departmentSchema.parse(
    await call('/api/admin/departments', idToken, { method: 'POST', body }),
  );
}

export async function updateDepartment(
  idToken: string,
  id: string,
  patch: UpdateDepartmentRequest,
) {
  const body = JSON.stringify(patch);
  return departmentSchema.parse(
    await call(`/api/admin/departments/${encodeURIComponent(id)}`, idToken, {
      method: 'PATCH',
      body,
    }),
  );
}

export async function fetchDirectory(idToken: string): Promise<DirectoryEntry[]> {
  return directoryListResponseSchema.parse(await call('/api/admin/directory', idToken)).entries;
}

export async function updateDirectoryEntry(
  idToken: string,
  email: string,
  patch: UpdateDirectoryRequest,
) {
  const body = JSON.stringify(patch);
  return directoryEntrySchema.parse(
    await call(`/api/admin/directory/${encodeURIComponent(email)}`, idToken, {
      method: 'PATCH',
      body,
    }),
  );
}

export type ImportTarget = 'departments' | 'directory';

export async function importCsv(
  idToken: string,
  target: ImportTarget,
  csv: string,
  dryRun: boolean,
): Promise<ImportResult> {
  const body = JSON.stringify({ csv, dryRun });
  return importResultSchema.parse(
    await call(`/api/admin/${target}/import`, idToken, { method: 'POST', body }),
  );
}

/** Downloads an export as a file in the browser. */
export async function downloadExport(idToken: string, target: ImportTarget, filename: string) {
  const res = await fetch(`${API_URL}/api/admin/${target}/export.csv`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw await readError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
