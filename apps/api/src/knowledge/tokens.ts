export const KNOWLEDGE_STORE = Symbol('KNOWLEDGE_STORE');
export const EMBEDDER = Symbol('EMBEDDER');
export const INGEST_QUEUE = Symbol('INGEST_QUEUE');

/** Hands a knowledge-base document to processing (Cloud Tasks → worker, or inline). */
export interface IngestQueue {
  enqueue(documentId: string): Promise<void>;
}
