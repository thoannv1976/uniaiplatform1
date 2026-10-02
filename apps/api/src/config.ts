import { parseDomainList, parseEmailList, type EmailPolicy } from '@uniai/shared';

export interface AppConfig {
  port: number;
  serviceName: string;
  version: string;
  /** Browser origins allowed by CORS (the web app). */
  webOrigins: string[];
  /** Only verified emails of these domains may use the API (decision D2). */
  allowedEmailDomains: string[];
  /** Exact break-glass admin addresses allowed outside those domains (ADR 0004). */
  extraAllowedEmails: string[];
  /** GCP project for Vertex AI and Secret Manager; null when running against the emulator. */
  gcpProject: string | null;
  /** Firestore database; also selects the Secret Manager secrets (staging keys stay apart). */
  firestoreDatabaseId: string;
  /** Vertex AI location for Gemini and Claude ("global" is recommended). */
  vertexLocation: string;
  /** Mock provider and mock models: emulator, CI and staging only (spec 8.5). */
  mockProviderEnabled: boolean;
  /** Keep API keys in memory instead of Secret Manager (emulator and tests only). */
  inMemorySecrets: boolean;
}

export function emailPolicy(config: AppConfig): EmailPolicy {
  return { domains: config.allowedEmailDomains, extraEmails: config.extraAllowedEmails };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT không hợp lệ: ${env.PORT}`);
  const emulator = Boolean(env.FIRESTORE_EMULATOR_HOST);
  const allowedEmailDomains = parseDomainList(env.ALLOWED_EMAIL_DOMAINS ?? 'ftu.edu.vn');
  if (allowedEmailDomains.length === 0) throw new Error('ALLOWED_EMAIL_DOMAINS không được rỗng');
  return {
    port,
    serviceName: env.SERVICE_NAME ?? 'uniai-api',
    // K_REVISION is set by Cloud Run; APP_VERSION by the deploy workflow.
    version: env.APP_VERSION ?? env.K_REVISION ?? 'dev',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    allowedEmailDomains,
    extraAllowedEmails: parseEmailList(env.EXTRA_ALLOWED_EMAILS),
    gcpProject: env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || null,
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID ?? '(default)',
    vertexLocation: env.VERTEX_LOCATION ?? 'global',
    mockProviderEnabled: parseFlag(env.ENABLE_MOCK_PROVIDER, emulator),
    inMemorySecrets: emulator,
  };
}

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`Giá trị cờ không hợp lệ: ${value}`);
}

export const APP_CONFIG = Symbol('APP_CONFIG');
