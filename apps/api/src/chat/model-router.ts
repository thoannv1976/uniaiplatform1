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
  ) {}

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
    const { models, providers } = await this.cache.get();
    return this.usable(models, providers)
      .filter(({ model }) => ModelRouter.allowed(model, role))
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
    const { models, providers } = await this.cache.get();
    const usable = this.usable(models, providers);
    const readsImages = (m: ModelView) => m.capabilities.includes('image');

    if (requested === CHAT_MODEL_AUTO) {
      const tiers = options.excludePremium
        ? AUTO_TIERS.filter((t) => !isPremiumTier(t))
        : AUTO_TIERS;
      const best = usable
        .filter(({ model }) => tiers.includes(model.tier))
        .filter(({ model }) => !options.requireImage || readsImages(model))
        .sort(ModelRouter.rank)[0];
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
    if (options.requireImage && !readsImages(match.model)) {
      throw new BadRequestException(
        `Model ${match.model.displayName} không đọc được ảnh. Hãy chọn AUTO hoặc model hỗ trợ ảnh.`,
      );
    }
    return { ...match, reason: 'Người dùng chọn model' };
  }
}
