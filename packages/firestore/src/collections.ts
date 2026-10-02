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
  knowledgeBases: 'knowledgeBases',
  documents: 'documents',
  chunks: 'chunks',
  prompts: 'prompts',
  projects: 'projects',
  usageTransactions: 'usageTransactions',
  auditLogs: 'auditLogs',
  settings: 'settings',
  monthlyReports: 'monthlyReports',
  appClients: 'appClients',
  appQuotaPeriods: 'appQuotaPeriods',
  agents: 'agents',
  integrations: 'integrations',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
