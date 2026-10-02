import { Inject, Injectable } from '@nestjs/common';
import type { RouterConfigStore, UsageAggregator } from '@uniai/firestore';
import {
  classifyRequest,
  quotaPeriodOf,
  type RouteDecision,
  type RouteInput,
  type RouterConfig,
  type RouterView,
} from '@uniai/shared';
import { AGGREGATOR } from '../usage/tokens.js';

export const ROUTER_CONFIG_STORE = Symbol('ROUTER_CONFIG_STORE');
const CONFIG_TTL_MS = 30_000;
const SHARES_TTL_MS = 5 * 60_000;
/** Targets are only enforced once the month has this many requests. */
const MIN_REQUESTS_FOR_TARGETS = 100;
const TARGET_TOLERANCE = 5;

type Shares = RouterView['actual'] & { requests: number; period: string };

/**
 * Smart Router decisions (spec 8.6): rules from settings/router (cached 30 s, reloaded at
 * once after an admin change), plus the monthly target for the Advanced tier.
 */
@Injectable()
export class RouterService {
  private config: { value: Awaited<ReturnType<RouterConfigStore['get']>>; at: number } | null =
    null;
  private shares: { value: Shares; at: number } | null = null;

  constructor(
    @Inject(ROUTER_CONFIG_STORE) private readonly store: RouterConfigStore,
    @Inject(AGGREGATOR) private readonly aggregator: UsageAggregator,
  ) {}

  async state() {
    if (!this.config || Date.now() - this.config.at > CONFIG_TTL_MS) {
      this.config = { value: await this.store.get(), at: Date.now() };
    }
    return this.config.value;
  }

  invalidate() {
    this.config = null;
  }

  /** Share of this month's requests per tier, from the 5-minute aggregates. */
  async actualShares(now = new Date()): Promise<Shares> {
    const period = quotaPeriodOf(now);
    if (
      this.shares &&
      this.shares.value.period === period &&
      Date.now() - this.shares.at < SHARES_TTL_MS
    ) {
      return this.shares.value;
    }
    const agg = await this.aggregator.period(period);
    const total = agg.requests;
    const pct = (tier: string) =>
      total ? Math.round(((agg.byTier[tier]?.requests ?? 0) / total) * 1000) / 10 : 0;
    const value: Shares = {
      period,
      requests: total,
      economy: pct('economy'),
      standard: pct('standard'),
      advanced: pct('advanced'),
      premium: pct('premium'),
    };
    this.shares = { value, at: Date.now() };
    return value;
  }

  /** The tier for an AUTO request, applying the Advanced target when enforced. */
  async decide(input: RouteInput): Promise<RouteDecision> {
    const { config } = await this.state();
    const decision = classifyRequest(config, input);
    return this.applyTargets(config, decision);
  }

  private async applyTargets(config: RouterConfig, d: RouteDecision): Promise<RouteDecision> {
    if (!config.enforceTargets || d.tier !== 'advanced') return d;
    const shares = await this.actualShares();
    if (
      shares.requests >= MIN_REQUESTS_FOR_TARGETS &&
      shares.advanced > config.targets.advanced + TARGET_TOLERANCE
    ) {
      return {
        ...d,
        tier: 'standard',
        reason: `${d.reason}; tháng này nhóm Nâng cao đã chiếm ${shares.advanced}% (mục tiêu ${config.targets.advanced}%) → dùng nhóm Tiêu chuẩn`,
      };
    }
    return d;
  }
}
