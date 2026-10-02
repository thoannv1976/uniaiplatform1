import { Inject, Injectable } from '@nestjs/common';
import {
  createProvider,
  secretNameFor,
  type LLMProvider,
  type ProviderConnection,
  type SecretStore,
} from '@uniai/ai-providers';
import type { ProviderId, ProviderView } from '@uniai/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';

export const SECRET_STORE = Symbol('SECRET_STORE');
export const PROVIDER_FACTORY = Symbol('PROVIDER_FACTORY');
export type ProviderFactory = (connection: ProviderConnection) => LLMProvider;

/** Why a provider cannot be called right now; shown to admins as is. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'disabled',
  ) {
    super(message);
  }
}

/**
 * Builds provider adapters from the registry settings and Secret Manager keys (ADR 0002).
 * An adapter is reused until its transport or key changes: a new key shows up as a new
 * `key.updatedAt`, which makes the next call read the latest secret version.
 */
@Injectable()
export class ProviderRuntime {
  private readonly cache = new Map<ProviderId, { stamp: string; provider: LLMProvider }>();

  constructor(
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(PROVIDER_FACTORY) private readonly factory: ProviderFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  secretName(id: ProviderId): string {
    return secretNameFor(id, this.config.firestoreDatabaseId);
  }

  async resolve(settings: ProviderView): Promise<LLMProvider> {
    const { id, transport } = settings;
    if (id === 'mock' && !this.config.mockProviderEnabled) {
      throw new ProviderUnavailableError(
        'Mock provider chỉ dùng ở emulator và staging.',
        'disabled',
      );
    }
    const stamp = `${transport}|${settings.key.updatedAt ?? ''}`;
    const cached = this.cache.get(id);
    if (cached?.stamp === stamp) return cached.provider;

    let apiKey: string | null = null;
    if (settings.keyRequired) {
      if (!settings.key.configured) {
        throw new ProviderUnavailableError(
          `Chưa nhập API key cho ${settings.name} (cách gọi trực tiếp).`,
          'not_configured',
        );
      }
      apiKey = await this.secrets.accessLatest(this.secretName(id));
      if (!apiKey) {
        throw new ProviderUnavailableError(
          `Secret ${this.secretName(id)} chưa có phiên bản nào; hãy nhập lại API key.`,
          'not_configured',
        );
      }
    }
    if (transport === 'vertex' && !this.config.gcpProject) {
      throw new ProviderUnavailableError(
        'Chưa cấu hình GCLOUD_PROJECT nên không gọi được Vertex AI.',
        'not_configured',
      );
    }
    const provider = this.factory({
      id,
      transport,
      apiKey,
      project: this.config.gcpProject ?? undefined,
      location: this.config.vertexLocation,
    });
    this.cache.set(id, { stamp, provider });
    return provider;
  }

  /** Stores a new key version; the key itself is never kept here or logged. */
  async storeKey(id: ProviderId, apiKey: string): Promise<void> {
    await this.secrets.addVersion(this.secretName(id), apiKey);
    this.cache.delete(id);
  }
}

export const defaultProviderFactory: ProviderFactory = createProvider;
