import type { Firestore } from 'firebase-admin/firestore';
import { forecastPeriod, quotaPeriodOf } from '@uniai/shared';
import { UsageAggregator } from './aggregate.js';
import { AlertService } from './alerts.js';

/**
 * Every 5 minutes (worker /jobs/usage-aggregate): fold new ledger entries into the totals,
 * copy unit costs into their budgets, then raise unit/university/forecast alerts.
 */
export async function runUsageJob(db: Firestore, now = new Date()) {
  const aggregator = new UsageAggregator(db);
  const added = await aggregator.run(now);
  const period = quotaPeriodOf(now);
  const budgets = await aggregator.updateBudgets(period);
  const [totals, days] = await Promise.all([aggregator.period(period), aggregator.days(period)]);
  const forecast = forecastPeriod(totals.cost, days, period, now);
  const alerts = await new AlertService(db).checkBudgets(period, budgets, forecast);
  return { period, added, budgets: budgets.length, forecast, alerts };
}
