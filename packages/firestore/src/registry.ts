import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  needsApiKey,
  nextPriceAfter,
  PROVIDER_IDS,
  PROVIDER_TRANSPORTS,
  priceAt,
  type CreateModelRequest,
  type Model,
  type ModelView,
  type NewPrice,
  type Price,
  type ProviderId,
  type ProviderSettings,
  type ProviderView,
  type UpdateModelRequest,
  type UpdateProviderRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';
import { DEFAULT_MODELS, DEFAULT_PROVIDERS } from './registry-catalog.js';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

/** New prices may not start earlier than this, so settled requests keep their price. */
const PRICE_BACKDATE_TOLERANCE_MS = 5 * 60_000;

const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);

function toProviderView(id: ProviderId, snap: DocumentSnapshot | null): ProviderView {
  const d = DEFAULT_PROVIDERS[id];
  const data = snap?.exists ? (snap.data() ?? {}) : {};
  const key = (data.key ?? {}) as Record<string, unknown>;
  const settings: ProviderSettings = {
    id,
    name: d.name,
    transport: PROVIDER_TRANSPORTS[id].includes(data.transport) ? data.transport : d.transport,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : d.enabled,
    fallbackOrder: typeof data.fallbackOrder === 'number' ? data.fallbackOrder : d.fallbackOrder,
    key: {
      configured: key.configured === true,
      last4: typeof key.last4 === 'string' ? key.last4 : null,
      updatedAt: iso(key.updatedAt),
      updatedBy: typeof key.updatedBy === 'string' ? key.updatedBy : null,
    },
  };
  const keyRequired = needsApiKey(id, settings.transport);
  return {
    ...settings,
    transports: [...PROVIDER_TRANSPORTS[id]],
    keyRequired,
    ready: settings.enabled && (!keyRequired || settings.key.configured),
  };
}

function toPrice(snap: DocumentSnapshot): Price {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    inputPerMTok: d.inputPerMTok as number,
    outputPerMTok: d.outputPerMTok as number,
    cachedInputPerMTok: (d.cachedInputPerMTok as number | null | undefined) ?? null,
    effectiveFrom: iso(d.effectiveFrom) ?? new Date(0).toISOString(),
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    createdBy: (d.createdBy as string | undefined) ?? '',
  };
}

function toModel(snap: DocumentSnapshot): Model {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    providerId: d.providerId,
    apiModelId: d.apiModelId,
    displayName: d.displayName,
    tier: d.tier,
    status: d.status,
    contextWindow: d.contextWindow,
    maxOutputTokens: d.maxOutputTokens,
    capabilities: d.capabilities ?? ['text'],
    priority: d.priority ?? 100,
    rateLimitPerMinute: d.rateLimitPerMinute ?? null,
    defaultParams: d.defaultParams ?? {},
    notes: d.notes ?? '',
    updatedAt: iso(d.updatedAt),
    updatedBy: d.updatedBy ?? null,
  };
}

function view(model: Model, prices: Price[], now: Date): ModelView {
  return { ...model, currentPrice: priceAt(prices, now), nextPrice: nextPriceAfter(prices, now) };
}

/** Model Registry: providers/{id}, models/{id} and models/{id}/prices/{pid} (spec 8.5, 9). */
export class RegistryStore {
  constructor(private readonly db: Firestore) {}

  private providersCol() {
    return this.db.collection(COLLECTIONS.providers);
  }
  private modelsCol() {
    return this.db.collection(COLLECTIONS.models);
  }
  private pricesCol(modelId: string) {
    return this.modelsCol().doc(modelId).collection('prices');
  }

  // --- providers ------------------------------------------------------------------------

  async listProviders(): Promise<ProviderView[]> {
    const snap = await this.providersCol().get();
    const byId = new Map(snap.docs.map((d) => [d.id, d]));
    return PROVIDER_IDS.map((id) => toProviderView(id, byId.get(id) ?? null)).sort(
      (a, b) => a.fallbackOrder - b.fallbackOrder,
    );
  }

  async getProvider(id: ProviderId): Promise<ProviderView> {
    return toProviderView(id, await this.providersCol().doc(id).get());
  }

  async updateProvider(
    id: ProviderId,
    patch: UpdateProviderRequest,
    by: string,
  ): Promise<{ before: ProviderView; after: ProviderView }> {
    if (patch.transport && !PROVIDER_TRANSPORTS[id].includes(patch.transport)) {
      throw new RegistryError(
        `${DEFAULT_PROVIDERS[id].name} không hỗ trợ cách gọi "${patch.transport}".`,
        'invalid',
      );
    }
    const ref = this.providersCol().doc(id);
    const before = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.set(
        ref,
        { ...patch, updatedBy: by, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return toProviderView(id, snap);
    });
    return { before, after: await this.getProvider(id) };
  }

  /** Records that a new key version was stored in Secret Manager. Never stores the key. */
  async recordKey(id: ProviderId, last4: string, by: string): Promise<ProviderView> {
    await this.providersCol()
      .doc(id)
      .set(
        {
          key: { configured: true, last4, updatedBy: by, updatedAt: FieldValue.serverTimestamp() },
          updatedBy: by,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    return this.getProvider(id);
  }

  // --- models and prices ----------------------------------------------------------------

  async listModels(now = new Date()): Promise<ModelView[]> {
    const models = await this.modelsCol().get();
    // One small read per model instead of a collection-group query, which would need an
    // extra collection-group index in production.
    const prices = await Promise.all(models.docs.map((d) => this.listPrices(d.id)));
    return models.docs
      .map((d, i) => view(toModel(d), prices[i] ?? [], now))
      .sort(
        (a, b) =>
          a.providerId.localeCompare(b.providerId) || a.displayName.localeCompare(b.displayName),
      );
  }

  async getModel(id: string, now = new Date()): Promise<ModelView | null> {
    const snap = await this.modelsCol().doc(id).get();
    if (!snap.exists) return null;
    return view(toModel(snap), await this.listPrices(id), now);
  }

  async listPrices(modelId: string): Promise<Price[]> {
    const snap = await this.pricesCol(modelId).get();
    return snap.docs
      .map(toPrice)
      .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
  }

  async createModel(input: CreateModelRequest, by: string): Promise<ModelView> {
    const { id, price, ...fields } = input;
    const ref = this.modelsCol().doc(id);
    const priceRef = this.pricesCol(id).doc();
    const now = Timestamp.now();
    await this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) {
        throw new RegistryError(`Mã model ${id} đã tồn tại.`, 'conflict');
      }
      tx.create(ref, { ...fields, createdAt: now, updatedAt: now, updatedBy: by });
      tx.create(priceRef, { ...price, effectiveFrom: now, createdAt: now, createdBy: by });
    });
    return (await this.getModel(id))!;
  }

  async updateModel(
    id: string,
    patch: UpdateModelRequest,
    by: string,
  ): Promise<{ before: Model; after: ModelView }> {
    const ref = this.modelsCol().doc(id);
    const before = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError(`Không có model ${id}.`, 'not_found');
      tx.update(ref, { ...patch, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
      return toModel(snap);
    });
    return { before, after: (await this.getModel(id))! };
  }

  /** Prices are append-only: a change is a new record from `effectiveFrom` on. */
  async addPrice(modelId: string, input: NewPrice, by: string, now = new Date()): Promise<Price> {
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    if (effectiveFrom.getTime() < now.getTime() - PRICE_BACKDATE_TOLERANCE_MS) {
      throw new RegistryError(
        'Không được đặt giá có hiệu lực trong quá khứ: các yêu cầu đã tính phí phải giữ giá cũ.',
        'invalid',
      );
    }
    const modelRef = this.modelsCol().doc(modelId);
    const priceRef = this.pricesCol(modelId).doc();
    await this.db.runTransaction(async (tx) => {
      if (!(await tx.get(modelRef)).exists) {
        throw new RegistryError(`Không có model ${modelId}.`, 'not_found');
      }
      tx.create(priceRef, {
        inputPerMTok: input.inputPerMTok,
        outputPerMTok: input.outputPerMTok,
        cachedInputPerMTok: input.cachedInputPerMTok,
        effectiveFrom: Timestamp.fromDate(effectiveFrom),
        createdAt: FieldValue.serverTimestamp(),
        createdBy: by,
      });
      tx.update(modelRef, { updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
    });
    return toPrice(await priceRef.get());
  }

  /** Adds catalogue models that do not exist yet; never touches existing ones. */
  async seedDefaults(by: string, options: { includeMock: boolean }): Promise<string[]> {
    const created: string[] = [];
    for (const model of DEFAULT_MODELS) {
      if (model.providerId === 'mock' && !options.includeMock) continue;
      try {
        await this.createModel(model, by);
        created.push(model.id);
      } catch (err) {
        if (!(err instanceof RegistryError && err.code === 'conflict')) throw err;
      }
    }
    return created;
  }
}
