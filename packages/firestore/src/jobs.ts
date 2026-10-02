import type { Firestore } from 'firebase-admin/firestore';
import { forecastPeriod, formatUsd, quotaPeriodOf } from '@uniai/shared';
import { UsageAggregator } from './aggregate.js';
import { AlertService } from './alerts.js';
import { KillSwitchStore } from './killswitch.js';

/**
 * Every 5 minutes (worker /jobs/usage-aggregate): fold new ledger entries into the totals,
 * copy unit costs into their budgets, then raise unit/university/forecast alerts. When the
 * university spend reaches the kill switch's autoBrakePercent of its budget, switch off the
 * advanced and premium tiers (emergency brake, spec 8.7).
 */
export async function runUsageJob(db: Firestore, now = new Date()) {
  const aggregator = new UsageAggregator(db);
  const added = await aggregator.run(now);
  const period = quotaPeriodOf(now);
  const budgets = await aggregator.updateBudgets(period);
  const [totals, days] = await Promise.all([aggregator.period(period), aggregator.days(period)]);
  const forecast = forecastPeriod(totals.cost, days, period, now);
  const alertService = new AlertService(db);
  const alerts = await alertService.checkBudgets(period, budgets, forecast);

  let braked = false;
  const root = budgets.find((b) => b.parentId === null && b.budget > 0);
  const killSwitch = new KillSwitchStore(db);
  const { autoBrakePercent } = await killSwitch.get();
  if (root && autoBrakePercent !== null && root.used * 100 >= root.budget * autoBrakePercent) {
    const reason = `Phanh khẩn cấp: chi phí AI toàn trường tháng ${period.slice(4)}/${period.slice(0, 4)} đã đạt ${formatUsd(root.used)} / ngân sách ${formatUsd(root.budget)}. Tạm dừng nhóm model Nâng cao và Cao cấp.`;
    braked = await killSwitch.brake(reason);
    if (braked) {
      await alertService.notifyOnce(`brake_${period}`, await alertService.superAdmins(), {
        type: 'university_budget',
        title: 'Đã tự bật phanh khẩn cấp (kill switch)',
        message: reason,
      });
    }
  }
  return { period, added, budgets: budgets.length, forecast, alerts, braked };
}
