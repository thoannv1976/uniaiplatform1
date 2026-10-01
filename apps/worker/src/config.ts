export interface WorkerConfig {
  port: number;
  serviceName: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT không hợp lệ: ${env.PORT}`);
  return {
    port,
    serviceName: env.SERVICE_NAME ?? 'uniai-worker',
    version: env.APP_VERSION ?? env.K_REVISION ?? 'dev',
  };
}
