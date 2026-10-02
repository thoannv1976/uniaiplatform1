import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import {
  CHAT_MODEL_AUTO,
  isPremiumTier,
  killSwitchBlocks,
  PROVIDER_LABELS_VI,
  type KillSwitch,
  MODEL_TIER_LABELS_VI,
  MODEL_TIERS,
  type ChatModelOption,
  type ModelTier,
  type ModelView,
  type ProviderView,
  type Role,
} from '@uniai/shared';
import { RegistryCache } from '../ai/registry-cache.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { KillSwitchService } from '../resilience/kill-switch.service.js';

export interface Route {
  model: ModelView;
  provider: ProviderView;
  reason: string;
}

/** Premium models stay with administrators until quota tiers grant them (M7). */
const PREMIUM_ROLES: Role[] = ['super_admin', 'ai_admin'];
/** AUTO never picks premium models. */
const AUTO_TIERS: ModelTier[] = ['economy', 'standard', 'advanced'];

/**
 * Chooses the model for a chat request. M5 keeps AUTO simple: the cheapest tier that has
 * a usable model, then the highest priority. The Smart Cost Router (spec 8.6) replaces
 * `auto()` later without changing callers.
 */
@Injectable()
export class ModelRouter {
  constructor(
    private readonly cache: RegistryCache,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly killSwitch: KillSwitchService,
    private readonly circuit: CircuitBreaker,
  ) {}

  /** Not stopped by the kill switch and the provider's circuit is closed. */
  private open(model: ModelView, ks: KillSwitch): boolean {
    return killSwitchBlocks(ks, model) === null && this.circuit.openFor(model.providerId) === 0;
  }

  /** Active, priced, provider ready, and mock only where it is enabled. */
  private usable(models: ModelView[], providers: ProviderView[]) {
    const byId = new Map(providers.map((p) => [p.id, p]));
    return models.flatMap((model) => {
      const provider = byId.get(model.providerId);
      const ok =
        model.status === 'active' &&
        model.currentPrice !== null &&
        provider?.ready === true &&
        (model.providerId !== 'mock' || this.config.mockProviderEnabled);
      return ok && provider ? [{ model, provider }] : [];
    });
  }

  private static allowed(model: ModelView, role: Role): boolean {
    return model.tier !== 'premium' || PREMIUM_ROLES.includes(role);
  }

  private static rank(a: { model: ModelView; provider: ProviderView }, b: typeof a): number {
    return (
      MODEL_TIERS.indexOf(a.model.tier) - MODEL_TIERS.indexOf(b.model.tier) ||
      b.model.priority - a.model.priority ||
      a.provider.fallbackOrder - b.provider.fallbackOrder ||
      a.model.displayName.localeCompare(b.model.displayName)
    );
  }

  /** Models the user may pick, cheapest tier first. */
  async options(role: Role): Promise<ChatModelOption[]> {
    const [{ models, providers }, ks] = await Promise.all([
      this.cache.get(),
      this.killSwitch.current(),
    ]);
    return this.usable(models, providers)
      .filter(({ model }) => ModelRouter.allowed(model, role))
      .filter(({ model }) => killSwitchBlocks(ks, model) === null)
      .sort(ModelRouter.rank)
      .map(({ model }) => ({
        id: model.id,
        displayName: model.displayName,
        providerId: model.providerId,
        tier: model.tier,
        capabilities: model.capabilities,
      }));
  }

  async choose(
    requested: string,
    role: Role,
    options: { excludePremium?: boolean; requireImage?: boolean } = {},
  ): Promise<Route> {
    const [{ models, providers }, ks] = await Promise.all([
      this.cache.get(),
      this.killSwitch.current(),
    ]);
    const usable = this.usable(models, providers);
    const readsImages = (m: ModelView) => m.capabilities.includes('image');
    if (ks.all) {
      throw new ServiceUnavailableException(
        `Hệ thống AI đang tạm dừng.${ks.reason ? ` Lý do: ${ks.reason}` : ''}`,
      );
    }

    if (requested === CHAT_MODEL_AUTO) {
      const tiers = options.excludePremium
        ? AUTO_TIERS.filter((t) => !isPremiumTier(t))
        : AUTO_TIERS;
      const best = usable
        .filter(({ model }) => tiers.includes(model.tier))
        .filter(({ model }) => !options.requireImage || readsImages(model))
        .filter(({ model }) => this.open(model, ks))
        .sort(ModelRouter.rank)[0];
      if (!best && ks.reason && (ks.providers.length || ks.models.length || ks.tiers.length)) {
        throw new ServiceUnavailableException(
          `Các model AI phù hợp đang tạm dừng. Lý do: ${ks.reason}`,
        );
      }
      if (!best && options.requireImage) {
        throw new BadRequestException('Chưa có model AI nào đọc được ảnh. Hãy gửi tệp văn bản.');
      }
      if (!best) {
        throw new ServiceUnavailableException(
          'Chưa có model AI nào sẵn sàng. Vui lòng liên hệ quản trị viên.',
        );
      }
      return {
        ...best,
        reason: `AUTO: nhóm ${MODEL_TIER_LABELS_VI[best.model.tier]}, ưu tiên cao nhất${options.requireImage ? ', đọc được ảnh' : ''}`,
      };
    }

    const known = models.find((m) => m.id === requested);
    const match = usable.find(({ model }) => model.id === requested);
    if (!known || !match) {
      throw new BadRequestException(`Model ${requested} hiện không dùng được. Hãy chọn AUTO.`);
    }
    if (!ModelRouter.allowed(match.model, role)) {
      throw new ForbiddenException(
        `Bạn chưa được cấp quyền dùng model ${match.model.displayName}.`,
      );
    }
    const blocked = killSwitchBlocks(ks, match.model);
    if (blocked) throw new ServiceUnavailableException(`${match.model.displayName}: ${blocked}`);
    const wait = this.circuit.openFor(match.model.providerId);
    if (wait > 0) {
      throw new ServiceUnavailableException(
        `${PROVIDER_LABELS_VI[match.model.providerId]} đang tạm ngắt do lỗi liên tục. Thử lại sau ${wait} giây hoặc chọn AUTO.`,
      );
    }
    if (options.requireImage && !readsImages(match.model)) {
      throw new BadRequestException(
        `Model ${match.model.displayName} không đọc được ảnh. Hãy chọn AUTO hoặc model hỗ trợ ảnh.`,
      );
    }
    return { ...match, reason: 'Người dùng chọn model' };
  }

  /**
   * Fallback (spec 8.8): an equivalent model – same tier, another provider – that is usable
   * now and fits the request. Null when there is none.
   */
  async fallback(
    failed: Route,
    role: Role,
    options: { requireImage?: boolean } = {},
  ): Promise<Route | null> {
    const [{ models, providers }, ks] = await Promise.all([
      this.cache.get(),
      this.killSwitch.current(),
    ]);
    if (ks.all) return null;
    const next = this.usable(models, providers)
      .filter(
        ({ model }) =>
          model.tier === failed.model.tier &&
          model.providerId !== failed.model.providerId &&
          ModelRouter.allowed(model, role) &&
          (!options.requireImage || model.capabilities.includes('image')) &&
          this.open(model, ks),
      )
      .sort(ModelRouter.rank)[0];
    return next
      ? {
          ...next,
          reason: `Dự phòng: ${failed.model.displayName} lỗi – chuyển sang ${next.model.displayName}`,
        }
      : null;
  }
}
