import {
  budgetListResponseSchema,
  quotaAdjustmentListResponseSchema,
  quotaAdjustmentSchema,
  quotaListResponseSchema,
  quotaSummarySchema,
  quotaTierSchema,
  type Budget,
  type QuotaAdjustment,
  type QuotaAdjustmentRequest,
  type QuotaSummary,
  type QuotaTier,
  type QuotaTierId,
  type SetBudgetRequest,
  type UpdateQuotaTierRequest,
  conversationDetailResponseSchema,
  conversationListResponseSchema,
  conversationSchema,
  type Conversation,
  type ConversationDetail,
  type UpdateConversationRequest,
  chatModelListResponseSchema,
  createSseParser,
  type ChatModelOption,
  type ChatRequest,
  type ChatStreamEvent,
  modelListResponseSchema,
  modelViewSchema,
  priceListResponseSchema,
  priceSchema,
  providerListResponseSchema,
  providerViewSchema,
  seedModelsResponseSchema,
  testModelResponseSchema,
  type CreateModelRequest,
  type ModelView,
  type NewPrice,
  type Price,
  type ProviderId,
  type ProviderView,
  type TestModelResponse,
  type UpdateModelRequest,
  type UpdateProviderRequest,
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

// ---- M4: Model Registry ----

export async function fetchProviders(idToken: string): Promise<ProviderView[]> {
  return providerListResponseSchema.parse(await call('/api/admin/providers', idToken)).providers;
}

export async function updateProvider(
  idToken: string,
  id: ProviderId,
  patch: UpdateProviderRequest,
): Promise<ProviderView> {
  const body = JSON.stringify(patch);
  return providerViewSchema.parse(
    await call(`/api/admin/providers/${id}`, idToken, { method: 'PATCH', body }),
  );
}

/** Write-only: the key is sent once and never read back. */
export async function setProviderKey(
  idToken: string,
  id: ProviderId,
  apiKey: string,
): Promise<ProviderView> {
  const body = JSON.stringify({ apiKey });
  return providerViewSchema.parse(
    await call(`/api/admin/providers/${id}/key`, idToken, { method: 'PUT', body }),
  );
}

export async function fetchModels(idToken: string): Promise<ModelView[]> {
  return modelListResponseSchema.parse(await call('/api/admin/models', idToken)).models;
}

export async function createModel(idToken: string, input: CreateModelRequest) {
  const body = JSON.stringify(input);
  return modelViewSchema.parse(await call('/api/admin/models', idToken, { method: 'POST', body }));
}

export async function updateModel(idToken: string, id: string, patch: UpdateModelRequest) {
  const body = JSON.stringify(patch);
  return modelViewSchema.parse(
    await call(`/api/admin/models/${encodeURIComponent(id)}`, idToken, { method: 'PATCH', body }),
  );
}

export async function seedModels(idToken: string): Promise<string[]> {
  return seedModelsResponseSchema.parse(
    await call('/api/admin/models/seed', idToken, { method: 'POST' }),
  ).created;
}

export async function fetchPrices(idToken: string, modelId: string): Promise<Price[]> {
  return priceListResponseSchema.parse(
    await call(`/api/admin/models/${encodeURIComponent(modelId)}/prices`, idToken),
  ).prices;
}

export async function addPrice(idToken: string, modelId: string, price: NewPrice) {
  const body = JSON.stringify(price);
  return priceSchema.parse(
    await call(`/api/admin/models/${encodeURIComponent(modelId)}/prices`, idToken, {
      method: 'POST',
      body,
    }),
  );
}

export async function testModel(
  idToken: string,
  modelId: string,
  prompt?: string,
): Promise<TestModelResponse> {
  const body = JSON.stringify(prompt ? { prompt } : {});
  return testModelResponseSchema.parse(
    await call(`/api/admin/models/${encodeURIComponent(modelId)}/test`, idToken, {
      method: 'POST',
      body,
    }),
  );
}

// ---- M5: chat ----

export async function fetchChatModels(idToken: string): Promise<ChatModelOption[]> {
  return chatModelListResponseSchema.parse(await call('/api/ai/models', idToken)).models;
}

/**
 * POST /api/ai/chat and hand each Server-Sent Event to `onEvent` as it arrives. The API is
 * called directly on Cloud Run (no Hosting rewrite, which would cut streams at 60 s).
 * Aborting `signal` cancels the answer; the API still settles its cost.
 */
export async function streamChat(
  idToken: string,
  request: Partial<ChatRequest> & { message: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/ai/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) throw await readError(res);
  if (!res.body)
    throw new ApiError(res.status, 'Trình duyệt không hỗ trợ nhận dữ liệu dạng stream');
  const parser = createSseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  parser.end();
}

export async function fetchConversations(idToken: string): Promise<Conversation[]> {
  return conversationListResponseSchema.parse(await call('/api/conversations', idToken))
    .conversations;
}

export async function fetchConversation(idToken: string, id: string): Promise<ConversationDetail> {
  return conversationDetailResponseSchema.parse(
    await call(`/api/conversations/${encodeURIComponent(id)}`, idToken),
  );
}

export async function updateConversation(
  idToken: string,
  id: string,
  patch: UpdateConversationRequest,
): Promise<Conversation> {
  const body = JSON.stringify(patch);
  return conversationSchema.parse(
    await call(`/api/conversations/${encodeURIComponent(id)}`, idToken, { method: 'PATCH', body }),
  );
}

export async function deleteConversation(idToken: string, id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw await readError(res);
}

// ---- M7: quotas and budgets ----

export async function fetchMyQuota(idToken: string): Promise<QuotaSummary> {
  return quotaSummarySchema.parse(await call('/api/me/quota', idToken));
}

export async function fetchQuotas(
  idToken: string,
  period?: string,
): Promise<{ period: string; quotas: QuotaSummary[] }> {
  const query = period ? `?period=${period}` : '';
  return quotaListResponseSchema.parse(await call(`/api/admin/quotas${query}`, idToken));
}

export async function adjustQuota(
  idToken: string,
  input: Omit<QuotaAdjustmentRequest, 'kind'> & { kind?: QuotaAdjustmentRequest['kind'] },
): Promise<QuotaAdjustment> {
  const body = JSON.stringify(input);
  return quotaAdjustmentSchema.parse(
    await call('/api/admin/quota-adjustments', idToken, { method: 'POST', body }),
  );
}

export async function fetchAdjustments(idToken: string): Promise<QuotaAdjustment[]> {
  return quotaAdjustmentListResponseSchema.parse(
    await call('/api/admin/quota-adjustments', idToken),
  ).adjustments;
}

export async function fetchBudgets(
  idToken: string,
  period?: string,
): Promise<{ period: string; budgets: Budget[] }> {
  const query = period ? `?period=${period}` : '';
  return budgetListResponseSchema.parse(await call(`/api/admin/budgets${query}`, idToken));
}

export async function setBudget(idToken: string, departmentId: string, input: SetBudgetRequest) {
  const body = JSON.stringify(input);
  return budgetListResponseSchema.parse(
    await call(`/api/admin/budgets/${encodeURIComponent(departmentId)}`, idToken, {
      method: 'PUT',
      body,
    }),
  );
}

export async function fetchQuotaTiers(idToken: string): Promise<QuotaTier[]> {
  const raw = (await call('/api/admin/quota-tiers', idToken)) as { tiers: unknown[] };
  return raw.tiers.map((t) => quotaTierSchema.parse(t));
}

export async function updateQuotaTier(
  idToken: string,
  id: QuotaTierId,
  patch: UpdateQuotaTierRequest,
): Promise<QuotaTier> {
  const body = JSON.stringify(patch);
  return quotaTierSchema.parse(
    await call(`/api/admin/quota-tiers/${id}`, idToken, { method: 'PATCH', body }),
  );
}
