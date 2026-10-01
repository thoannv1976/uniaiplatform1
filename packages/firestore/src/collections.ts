/** Single source of truth for Firestore collection names (see spec section 9). */
export const COLLECTIONS = {
  users: 'users',
  userDirectory: 'userDirectory',
  departments: 'departments',
  quotaTiers: 'quotaTiers',
  quotaPeriods: 'quotaPeriods',
  budgetPeriods: 'budgetPeriods',
  quotaAdjustments: 'quotaAdjustments',
  providers: 'providers',
  models: 'models',
  conversations: 'conversations',
  files: 'files',
  usageTransactions: 'usageTransactions',
  auditLogs: 'auditLogs',
  settings: 'settings',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
