import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  GcpSecretStore,
  MemorySecretStore,
  MockEmbedder,
  VertexEmbedder,
  type Embedder,
  type SecretStore,
} from '@uniai/ai-providers';
import type { BlobStore } from '@uniai/firestore';
import { KB_MAX_PAGES } from '@uniai/shared';
import {
  AuditStore,
  ConversationStore,
  DepartmentStore,
  FileStore,
  GcsBlobStore,
  getDb,
  KillSwitchStore,
  KnowledgeStore,
  RouterConfigStore,
  AlertService,
  QuotaService,
  RegistryStore,
  SettingsStore,
  UsageAggregator,
  UserStore,
} from '@uniai/firestore';
import { ModelsController } from './ai/models.controller.js';
import {
  defaultProviderFactory,
  PROVIDER_FACTORY,
  ProviderRuntime,
  SECRET_STORE,
  type ProviderFactory,
} from './ai/provider-runtime.js';
import { ProvidersController } from './ai/providers.controller.js';
import { REGISTRY_STORE } from './ai/tokens.js';
import { RegistryCache } from './ai/registry-cache.js';
import { ChatController } from './chat/chat.controller.js';
import { CONVERSATION_STORE, ChatService, QUOTA_SERVICE } from './chat/chat.service.js';
import { ConversationsController } from './chat/conversations.controller.js';
import { ModelRouter } from './chat/model-router.js';
import { AuditLogsController } from './audit/audit-logs.controller.js';
import { AUDIT_STORE, AuditService } from './audit/audit.service.js';
import { AuthGuard, USER_STORE } from './auth/auth.guard.js';
import {
  FirebaseIdentity,
  IDENTITY_ADMIN,
  TOKEN_VERIFIER,
  type IdentityAdmin,
  type TokenVerifier,
} from './auth/token-verifier.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DEPARTMENT_STORE, DepartmentsController } from './departments/departments.controller.js';
import { DirectoryController } from './directory/directory.controller.js';
import { FilesController } from './files/files.controller.js';
import { CloudTasksIngestQueue, InlineIngestQueue } from './knowledge/ingest-queue.js';
import { KnowledgeChatController } from './knowledge/knowledge-chat.controller.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeRetrieval } from './knowledge/retrieval.service.js';
import { EMBEDDER, INGEST_QUEUE, KNOWLEDGE_STORE, type IngestQueue } from './knowledge/tokens.js';
import { BLOB_STORE, FILE_STORE, FilesService } from './files/files.service.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { RouterController } from './router/router.controller.js';
import { ROUTER_CONFIG_STORE, RouterService } from './router/router.service.js';
import { KillSwitchController } from './resilience/kill-switch.controller.js';
import { KILL_SWITCH_STORE, KillSwitchService } from './resilience/kill-switch.service.js';
import { AdminQuotaController, MyQuotaController } from './quota/quota.controller.js';
import { DashboardService } from './usage/dashboard.service.js';
import { AGGREGATOR, ALERTS, FIRESTORE, SETTINGS } from './usage/tokens.js';
import { AdminUsageController, MyUsageController } from './usage/usage.controller.js';
import { AdminUsersController } from './users/admin-users.controller.js';

export interface AppOverrides {
  /** Replaces Firebase token verification, for tests. */
  tokenVerifier?: TokenVerifier;
  identityAdmin?: IdentityAdmin;
  /** Replaces Secret Manager, for tests. */
  secretStore?: SecretStore;
  /** Replaces the real provider adapters, for tests (no network). */
  providerFactory?: ProviderFactory;
  /** Replaces Cloud Storage, for tests. */
  blobStore?: BlobStore;
  /** Replaces Vertex AI embeddings, for tests. */
  embedder?: Embedder;
  /** Extra controllers, for tests of the guard itself. */
  extraControllers?: Type[];
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    const firebase = new FirebaseIdentity();
    return {
      module: AppModule,
      controllers: [
        HealthController,
        MeController,
        AdminUsersController,
        AuditLogsController,
        DepartmentsController,
        DirectoryController,
        ProvidersController,
        ModelsController,
        ChatController,
        ConversationsController,
        MyQuotaController,
        AdminQuotaController,
        MyUsageController,
        AdminUsageController,
        FilesController,
        KillSwitchController,
        RouterController,
        KnowledgeController,
        KnowledgeChatController,
        ...(overrides.extraControllers ?? []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: TOKEN_VERIFIER, useValue: overrides.tokenVerifier ?? firebase },
        { provide: IDENTITY_ADMIN, useValue: overrides.identityAdmin ?? firebase },
        // Factories: Firestore is only touched when the app actually starts.
        { provide: USER_STORE, useFactory: () => new UserStore(getDb()) },
        { provide: AUDIT_STORE, useFactory: () => new AuditStore(getDb()) },
        { provide: DEPARTMENT_STORE, useFactory: () => new DepartmentStore(getDb()) },
        { provide: REGISTRY_STORE, useFactory: () => new RegistryStore(getDb()) },
        {
          provide: SECRET_STORE,
          useFactory: (): SecretStore => {
            if (overrides.secretStore) return overrides.secretStore;
            if (config.inMemorySecrets) return new MemorySecretStore();
            if (config.gcpProject) return new GcpSecretStore(config.gcpProject);
            const missing = () =>
              Promise.reject(new Error('Cần GCLOUD_PROJECT để dùng Secret Manager'));
            return { addVersion: missing, accessLatest: missing };
          },
        },
        {
          provide: PROVIDER_FACTORY,
          useValue: overrides.providerFactory ?? defaultProviderFactory,
        },
        ProviderRuntime,
        RegistryCache,
        ModelRouter,
        ChatService,
        { provide: CONVERSATION_STORE, useFactory: () => new ConversationStore(getDb()) },
        { provide: QUOTA_SERVICE, useFactory: () => new QuotaService(getDb()) },
        { provide: FIRESTORE, useFactory: () => getDb() },
        { provide: AGGREGATOR, useFactory: () => new UsageAggregator(getDb()) },
        { provide: ALERTS, useFactory: () => new AlertService(getDb()) },
        { provide: SETTINGS, useFactory: () => new SettingsStore(getDb()) },
        DashboardService,
        { provide: FILE_STORE, useFactory: () => new FileStore(getDb(), config.filesEnv) },
        {
          provide: BLOB_STORE,
          useFactory: (): BlobStore => overrides.blobStore ?? new GcsBlobStore(config.filesBucket),
        },
        FilesService,
        {
          provide: KNOWLEDGE_STORE,
          useFactory: () => new KnowledgeStore(getDb(), config.filesEnv),
        },
        {
          provide: EMBEDDER,
          useFactory: (): Embedder =>
            overrides.embedder ??
            (config.embeddings.mode === 'vertex' && config.gcpProject
              ? new VertexEmbedder(config.gcpProject, config.embeddings.location)
              : new MockEmbedder()),
        },
        KnowledgeRetrieval,
        {
          provide: INGEST_QUEUE,
          inject: [KNOWLEDGE_STORE, BLOB_STORE, EMBEDDER],
          useFactory: (store: KnowledgeStore, blobs: BlobStore, embedder: Embedder): IngestQueue =>
            config.kbIngest.mode === 'tasks'
              ? new CloudTasksIngestQueue(
                  config.kbIngest.queue,
                  config.kbIngest.workerUrl,
                  config.kbIngest.serviceAccount,
                )
              : new InlineIngestQueue({ store, blobs, embedder, maxPages: KB_MAX_PAGES }),
        },
        { provide: KILL_SWITCH_STORE, useFactory: () => new KillSwitchStore(getDb()) },
        KillSwitchService,
        { provide: ROUTER_CONFIG_STORE, useFactory: () => new RouterConfigStore(getDb()) },
        RouterService,
        { provide: CircuitBreaker, useFactory: () => new CircuitBreaker() },
        AuditService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
