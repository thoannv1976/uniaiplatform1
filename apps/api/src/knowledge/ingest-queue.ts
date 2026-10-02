import { Logger } from '@nestjs/common';
import type { Embedder } from '@uniai/ai-providers';
import { ingestDocument } from '@uniai/documents';
import type { BlobStore, KnowledgeStore } from '@uniai/firestore';
import type { IngestQueue } from './tokens.js';

/**
 * Cloud Tasks queue (spec 8.9): one task per document, POSTed to the private worker
 * (/jobs/kb-ingest) with an OIDC token of the scheduler service account; Cloud Tasks
 * retries failures with backoff (queue settings in infra/knowledge.sh).
 */
export class CloudTasksIngestQueue implements IngestQueue {
  constructor(
    private readonly queue: string,
    private readonly workerUrl: string,
    private readonly serviceAccount: string,
  ) {}

  async enqueue(documentId: string): Promise<void> {
    const { CloudTasksClient } = await import('@google-cloud/tasks');
    const client = new CloudTasksClient();
    await client.createTask({
      parent: this.queue,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: `${this.workerUrl}/jobs/kb-ingest`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ documentId })).toString('base64'),
          oidcToken: { serviceAccountEmail: this.serviceAccount, audience: this.workerUrl },
        },
        dispatchDeadline: { seconds: 900 },
      },
    });
  }
}

/** Local development and tests: process right away, in this process. */
export class InlineIngestQueue implements IngestQueue {
  private readonly logger = new Logger('KnowledgeIngest');

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      blobs: BlobStore;
      embedder: Embedder;
      maxPages: number;
    },
  ) {}

  async enqueue(documentId: string): Promise<void> {
    try {
      const result = await ingestDocument(this.deps, documentId);
      this.logger.log(JSON.stringify({ job: 'kb-ingest', documentId, ...result }));
    } catch (err) {
      this.logger.error(`Lỗi xử lý tài liệu ${documentId}: ${String(err)}`);
    }
  }
}
