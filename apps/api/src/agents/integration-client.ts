import { Inject, Injectable } from '@nestjs/common';
import { integrationSecretName, type SecretStore } from '@uniai/ai-providers';
import type { Integration, IntegrationOperation } from '@uniai/shared';
import { SECRET_STORE } from '../ai/provider-runtime.js';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';

/** Response bytes kept from an integration call. */
export const INTEGRATION_MAX_BYTES = 100_000;
const TOKEN_TTL_MS = 5 * 60_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface IntegrationCallResult {
  ok: boolean;
  status: number | null;
  body: string;
  bytes: number;
  durationMs: number;
  /** Vietnamese reason when ok is false (never the response body). */
  error: string | null;
}

export class IntegrationArgumentError extends Error {}

/**
 * http:// is accepted only for local test systems (emulator/staging with the mock provider);
 * everything else must be https.
 */
export function integrationUrlAllowed(
  baseUrl: string,
  config: Pick<AppConfig, 'mockProviderEnabled'>,
) {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && config.mockProviderEnabled && LOCAL_HOSTS.has(url.hostname);
}

/** The request URL of an operation, or an error for missing/invalid arguments. */
export function buildOperationUrl(
  integration: Pick<Integration, 'baseUrl'>,
  op: IntegrationOperation,
  args: Record<string, unknown>,
): URL {
  const values = new Map<string, string>();
  for (const p of op.parameters) {
    const raw = args[p.name];
    if (raw === undefined || raw === null || raw === '') {
      if (p.required) throw new IntegrationArgumentError(`Thiếu tham số bắt buộc "${p.name}".`);
      continue;
    }
    let value: string;
    if (p.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new IntegrationArgumentError(`"${p.name}" phải là số.`);
      value = String(n);
    } else if (p.type === 'boolean') {
      if (typeof raw !== 'boolean' && raw !== 'true' && raw !== 'false') {
        throw new IntegrationArgumentError(`"${p.name}" phải là true/false.`);
      }
      value = String(raw);
    } else {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw new IntegrationArgumentError(`"${p.name}" phải là chuỗi.`);
      }
      value = String(raw);
    }
    if (value.length > 200) throw new IntegrationArgumentError(`"${p.name}" quá dài.`);
    if (p.in === 'path' && (value === '.' || value === '..')) {
      throw new IntegrationArgumentError(`"${p.name}" không hợp lệ.`);
    }
    values.set(p.name, value);
  }
  const base = new URL(integration.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(values.get(name) ?? ''),
  );
  const url = new URL(`${base.origin}${basePath}${path}`);
  // Never leave the configured system: same origin, under the base path.
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
    throw new IntegrationArgumentError('Đường dẫn không hợp lệ.');
  }
  for (const p of op.parameters) {
    if (p.in === 'query' && values.has(p.name)) url.searchParams.set(p.name, values.get(p.name)!);
  }
  return url;
}

/**
 * Read-only HTTP calls to integrations (M18). GET only, same origin and base path as
 * configured, no redirects, timeout and response size limits. The token comes from Secret
 * Manager; arguments and responses are never logged (they may hold personal data).
 */
@Injectable()
export class IntegrationClient {
  private readonly tokens = new Map<string, { value: string | null; at: number }>();

  constructor(
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private secretName(integrationId: string) {
    return integrationSecretName(integrationId, this.config.firestoreDatabaseId);
  }

  async setToken(integrationId: string, token: string): Promise<void> {
    await this.secrets.addVersion(this.secretName(integrationId), token);
    this.tokens.delete(integrationId);
  }

  private async token(integrationId: string): Promise<string | null> {
    const cached = this.tokens.get(integrationId);
    if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.value;
    const value = await this.secrets.accessLatest(this.secretName(integrationId));
    this.tokens.set(integrationId, { value, at: Date.now() });
    return value;
  }

  async call(
    integration: Integration,
    op: IntegrationOperation,
    args: Record<string, unknown>,
    actor: { id: string; label: string },
    signal?: AbortSignal,
  ): Promise<IntegrationCallResult> {
    const started = Date.now();
    const fail = (
      error: string,
      status: number | null = null,
      bytes = 0,
    ): IntegrationCallResult => {
      this.record(integration, op, actor, status, bytes, Date.now() - started, false);
      return { ok: false, status, body: '', bytes, durationMs: Date.now() - started, error };
    };
    if (integration.status !== 'active') return fail('Tích hợp đang tạm dừng.');
    if (!integrationUrlAllowed(integration.baseUrl, this.config)) {
      return fail('Địa chỉ tích hợp phải dùng https.');
    }
    let url: URL;
    try {
      url = buildOperationUrl(integration, op, args);
    } catch (err) {
      if (err instanceof IntegrationArgumentError) return fail(err.message);
      throw err;
    }
    const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.9' };
    if (integration.authType !== 'none') {
      const token = await this.token(integration.id).catch(() => null);
      if (!token) return fail('Tích hợp chưa có token. Báo quản trị viên.');
      if (integration.authType === 'bearer') headers.Authorization = `Bearer ${token}`;
      else headers[integration.authHeader!] = token;
    }
    if (integration.sendActor) headers['X-UniAI-Actor'] = actor.label;

    const timeout = AbortSignal.timeout(integration.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: combined });
    } catch {
      return fail(
        timeout.aborted
          ? 'Hệ thống tích hợp phản hồi quá lâu.'
          : 'Không kết nối được hệ thống tích hợp.',
      );
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return fail('Hệ thống tích hợp chuyển hướng (không được phép).', res.status);
    }
    // Read at most INTEGRATION_MAX_BYTES.
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    try {
      const reader = res.body?.getReader();
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        if (bytes + value.length > INTEGRATION_MAX_BYTES) {
          chunks.push(value.subarray(0, INTEGRATION_MAX_BYTES - bytes));
          bytes = INTEGRATION_MAX_BYTES;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        bytes += value.length;
      }
    } catch {
      return fail('Đọc phản hồi của hệ thống tích hợp bị gián đoạn.', res.status, bytes);
    }
    const body =
      Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[… phản hồi dài, đã cắt bớt]' : '');
    if (!res.ok) {
      return fail(`Hệ thống tích hợp trả lỗi HTTP ${res.status}.`, res.status, bytes);
    }
    const durationMs = Date.now() - started;
    this.record(integration, op, actor, res.status, bytes, durationMs, true);
    return { ok: true, status: res.status, body, bytes, durationMs, error: null };
  }

  private record(
    integration: Integration,
    op: IntegrationOperation,
    actor: { id: string },
    status: number | null,
    bytes: number,
    durationMs: number,
    ok: boolean,
  ) {
    this.audit.recordQuietly({
      event: 'INTEGRATION_CALL',
      actor: actor.id,
      target: `integrations/${integration.id}`,
      metadata: { operation: op.id, ok, status, bytes, durationMs },
    });
  }
}
