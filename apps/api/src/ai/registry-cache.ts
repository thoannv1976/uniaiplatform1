import { Inject, Injectable } from '@nestjs/common';
import type { RegistryStore } from '@uniai/firestore';
import type { ModelView, ProviderView } from '@uniai/shared';
import { REGISTRY_STORE } from './tokens.js';

/** Registry changes reach every instance within this time (spec 8.5: ≤ 60 s). */
export const REGISTRY_TTL_MS = 30_000;

/**
 * Short-lived copy of providers and models for the request path. Admin writes on this
 * instance invalidate it at once; other instances pick changes up within REGISTRY_TTL_MS.
 * (A realtime listener is not used: Cloud Run only gives CPU while serving requests.)
 */
@Injectable()
export class RegistryCache {
  private snapshot: {
    at: number;
    value: Promise<{ models: ModelView[]; providers: ProviderView[] }>;
  } | null = null;

  constructor(@Inject(REGISTRY_STORE) private readonly registry: RegistryStore) {}

  async get(now = Date.now()): Promise<{ models: ModelView[]; providers: ProviderView[] }> {
    if (!this.snapshot || now - this.snapshot.at > REGISTRY_TTL_MS) {
      const value = Promise.all([this.registry.listModels(), this.registry.listProviders()]).then(
        ([models, providers]) => ({ models, providers }),
      );
      this.snapshot = { at: now, value };
      value.catch(() => (this.snapshot = null));
    }
    return this.snapshot.value;
  }

  invalidate(): void {
    this.snapshot = null;
  }
}
