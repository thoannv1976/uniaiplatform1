export interface WorkerConfig {
  port: number;
  serviceName: string;
  version: string;
  /** Knowledge Base sources (M12) live in this bucket. */
  filesBucket: string;
  gcpProject: string | null;
  /** Vertex AI region for embeddings. */
  embeddingLocation: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT không hợp lệ: ${env.PORT}`);
  return {
    port,
    serviceName: env.SERVICE_NAME ?? 'uniai-worker',
    version: env.APP_VERSION ?? env.K_REVISION ?? 'dev',
    filesBucket: env.FILES_BUCKET || 'uniaiplatform1-uploads',
    gcpProject: env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || null,
    embeddingLocation: env.EMBEDDING_LOCATION || 'asia-southeast1',
  };
}
