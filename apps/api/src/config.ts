export interface AppConfig {
  port: number;
  serviceName: string;
  version: string;
  /** Browser origins allowed by CORS (the web app). */
  webOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT không hợp lệ: ${env.PORT}`);
  return {
    port,
    serviceName: env.SERVICE_NAME ?? 'uniai-api',
    // K_REVISION is set by Cloud Run; APP_VERSION by the deploy workflow.
    version: env.APP_VERSION ?? env.K_REVISION ?? 'dev',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
