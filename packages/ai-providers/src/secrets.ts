import { GoogleAuth, type AuthClient } from 'google-auth-library';
import type { ProviderId } from './types.js';

/**
 * Where admin-entered API keys live (ADR 0002). Keys are only ever written as new
 * Secret Manager versions and read back by the API; they never reach Firestore,
 * the browser or the logs.
 */
export interface SecretStore {
  /** Adds a new version that becomes "latest". */
  addVersion(name: string, value: string): Promise<void>;
  /** The latest enabled version, or null when the secret has none. */
  accessLatest(name: string): Promise<string | null>;
}

/**
 * Secret per provider and Firestore database, so staging keys never reach production:
 * "(default)" → openai-api-key, "staging" → openai-api-key-staging.
 */
export function secretNameFor(provider: ProviderId, databaseId = '(default)'): string {
  const suffix = databaseId === '(default)' ? '' : `-${databaseId}`;
  return `${provider}-api-key${suffix}`;
}

/**
 * Token of an integration (M18, ADR 0017), per Firestore database like the provider keys:
 * "integration-lms-token" / "integration-lms-token-staging".
 */
export function integrationSecretName(integrationId: string, databaseId = '(default)'): string {
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(integrationId)) {
    throw new Error(`Mã tích hợp không hợp lệ: ${integrationId}`);
  }
  const suffix = databaseId === '(default)' ? '' : `-${databaseId}`;
  return `integration-${integrationId}-token${suffix}`;
}

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SECRET_MANAGER = 'https://secretmanager.googleapis.com/v1';

/** Secret Manager over REST with the runtime's service account (no extra SDK). */
export class GcpSecretStore implements SecretStore {
  private authClient: Promise<AuthClient> | null = null;

  constructor(
    private readonly project: string,
    private readonly options: { authClient?: AuthClient; fetch?: typeof fetch } = {},
  ) {}

  private client(): Promise<AuthClient> {
    this.authClient ??= this.options.authClient
      ? Promise.resolve(this.options.authClient)
      : new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' }).getClient();
    return this.authClient;
  }

  private async call(url: string, init: { method: string; body?: string }): Promise<Response> {
    const headers = await (await this.client()).getRequestHeaders(url);
    headers.set('Content-Type', 'application/json');
    return (this.options.fetch ?? fetch)(url, { ...init, headers });
  }

  private secretUrl(name: string): string {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(name)) throw new Error(`Tên secret không hợp lệ: ${name}`);
    return `${SECRET_MANAGER}/projects/${encodeURIComponent(this.project)}/secrets/${name}`;
  }

  async addVersion(name: string, value: string): Promise<void> {
    const res = await this.call(`${this.secretUrl(name)}:addVersion`, {
      method: 'POST',
      body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
    });
    if (!res.ok) {
      // The error body never contains the payload, but keep only the status to be safe.
      throw new SecretStoreError(`Không lưu được secret ${name} (HTTP ${res.status})`, res.status);
    }
  }

  async accessLatest(name: string): Promise<string | null> {
    const res = await this.call(`${this.secretUrl(name)}/versions/latest:access`, {
      method: 'GET',
    });
    // 404: no version yet; 400 FAILED_PRECONDITION: latest version disabled/destroyed.
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      throw new SecretStoreError(`Không đọc được secret ${name} (HTTP ${res.status})`, res.status);
    }
    const body = (await res.json()) as { payload?: { data?: string } };
    const data = body.payload?.data;
    return data ? Buffer.from(data, 'base64').toString('utf8') : null;
  }
}

/** In-memory store for the emulator and tests. Keys are lost on restart. */
export class MemorySecretStore implements SecretStore {
  readonly versions = new Map<string, string[]>();

  addVersion(name: string, value: string): Promise<void> {
    this.versions.set(name, [...(this.versions.get(name) ?? []), value]);
    return Promise.resolve();
  }

  accessLatest(name: string): Promise<string | null> {
    return Promise.resolve(this.versions.get(name)?.at(-1) ?? null);
  }
}
