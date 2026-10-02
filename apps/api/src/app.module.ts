import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { GcpSecretStore, MemorySecretStore, type SecretStore } from '@uniai/ai-providers';
import { AuditStore, DepartmentStore, getDb, RegistryStore, UserStore } from '@uniai/firestore';
import { ModelsController } from './ai/models.controller.js';
import {
  defaultProviderFactory,
  PROVIDER_FACTORY,
  ProviderRuntime,
  SECRET_STORE,
  type ProviderFactory,
} from './ai/provider-runtime.js';
import { ProvidersController, REGISTRY_STORE } from './ai/providers.controller.js';
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
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';
import { AdminUsersController } from './users/admin-users.controller.js';

export interface AppOverrides {
  /** Replaces Firebase token verification, for tests. */
  tokenVerifier?: TokenVerifier;
  identityAdmin?: IdentityAdmin;
  /** Replaces Secret Manager, for tests. */
  secretStore?: SecretStore;
  /** Replaces the real provider adapters, for tests (no network). */
  providerFactory?: ProviderFactory;
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
        AuditService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
