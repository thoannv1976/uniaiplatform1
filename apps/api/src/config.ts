import { parseDomainList } from '@uniai/shared';

export interface AppConfig {
  port: number;
  serviceName: string;
  version: string;
  /** Browser origins allowed by CORS (the web app). */
  webOrigins: string[];
  /** Only verified emails of these domains may use the API (decision D2). */
  allowedEmailDomains: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT không hợp lệ: ${env.PORT}`);
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
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
