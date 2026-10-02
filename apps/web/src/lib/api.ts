import {
  killSwitchSchema,
  type KillSwitch,
  type UpdateKillSwitchRequest,
  createFileResponseSchema,
  fileViewSchema,
  type FileView,
  dashboardSchema,
  exchangeRateSchema,
  myUsageSchema,
  notificationListResponseSchema,
  type AppNotification,
  type Dashboard,
  type MyUsage,
  type UsageExportKind,
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
  await downloadCsv(idToken, `/api/admin/${target}/export.csv`, filename);
}

async function downloadCsv(idToken: string, path: string, filename: string) {
  const res = await fetch(`${API_URL}${path}`, {
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

// ---- M8: usage, dashboards, notifications ----

export async function fetchDashboard(
  idToken: string,
  period?: string,
  departmentId?: string,
): Promise<Dashboard> {
  const query = new URLSearchParams();
  if (period) query.set('period', period);
  if (departmentId) query.set('departmentId', departmentId);
  const qs = query.size ? `?${query.toString()}` : '';
  return dashboardSchema.parse(await call(`/api/admin/dashboard${qs}`, idToken));
}

export async function downloadUsageExport(idToken: string, kind: UsageExportKind, period: string) {
  await downloadCsv(
    idToken,
    `/api/admin/usage/export.csv?kind=${kind}&period=${period}`,
    `chi-phi-ai-${kind}-${period}.csv`,
  );
}

export async function fetchExchangeRate(idToken: string): Promise<number> {
  return exchangeRateSchema.parse(await call('/api/admin/settings/exchange-rate', idToken))
    .vndPerUsd;
}

export async function setExchangeRate(idToken: string, vndPerUsd: number): Promise<number> {
  const body = JSON.stringify({ vndPerUsd });
  return exchangeRateSchema.parse(
    await call('/api/admin/settings/exchange-rate', idToken, { method: 'PUT', body }),
  ).vndPerUsd;
}

export async function fetchMyUsage(idToken: string, period?: string): Promise<MyUsage> {
  const query = period ? `?period=${period}` : '';
  return myUsageSchema.parse(await call(`/api/me/usage${query}`, idToken));
}

export async function fetchNotifications(
  idToken: string,
): Promise<{ notifications: AppNotification[]; unread: number }> {
  return notificationListResponseSchema.parse(await call('/api/me/notifications', idToken));
}

export async function markNotificationsRead(idToken: string, ids?: string[]): Promise<void> {
  const res = await fetch(`${API_URL}/api/me/notifications/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ids ? { ids } : {}),
  });
  if (!res.ok) throw await readError(res);
}

// ---- M9: attachments ----

/**
 * Uploads a chat attachment: register it (POST /api/files), PUT the bytes to the signed
 * Cloud Storage URL (or to the API in local development), then let the API check it and
 * extract its text. Resolves with the ready file; rejects with a Vietnamese message.
 */
export async function uploadFile(idToken: string, file: File): Promise<FileView> {
  const created = createFileResponseSchema.parse(
    await call('/api/files', idToken, {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mime: file.type, size: file.size }),
    }),
  );
  const target = created.upload;
  const headers = new Headers(target.headers);
  if (target.withAuth) headers.set('Authorization', `Bearer ${idToken}`);
  const url = target.url.startsWith('/') ? `${API_URL}${target.url}` : target.url;
  const put = await fetch(url, { method: target.method, headers, body: file });
  if (!put.ok) {
    throw new ApiError(put.status, `Tải tệp lên không thành công (mã ${put.status}).`);
  }
  return fileViewSchema.parse(
    await call(`/api/files/${created.file.id}/complete`, idToken, { method: 'POST' }),
  );
}

// ---- M10: terms, kill switch ----

export async function acceptTerms(idToken: string, version: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/me/terms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw await readError(res);
}

export async function fetchKillSwitch(idToken: string): Promise<KillSwitch> {
  return killSwitchSchema.parse(await call('/api/admin/kill-switch', idToken));
}

export async function updateKillSwitch(
  idToken: string,
  value: UpdateKillSwitchRequest,
): Promise<KillSwitch> {
  return killSwitchSchema.parse(
    await call('/api/admin/kill-switch', idToken, { method: 'PUT', body: JSON.stringify(value) }),
  );
}
