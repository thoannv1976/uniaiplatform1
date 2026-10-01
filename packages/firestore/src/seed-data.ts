import { usdToMicro } from '@uniai/shared';

/** Starting quota tiers from spec section 17; amounts are monthly micro-USD. */
export const QUOTA_TIERS = [
  {
    id: 'standard',
    name: 'Standard',
    monthlyBudget: usdToMicro(2),
    premiumBudget: usdToMicro(0.5),
  },
  { id: 'power', name: 'Power', monthlyBudget: usdToMicro(5), premiumBudget: usdToMicro(1) },
  { id: 'research', name: 'Research', monthlyBudget: usdToMicro(20), premiumBudget: usdToMicro(5) },
] as const;

/** Sample tree for local development (ids are department codes; see departments.csv template). */
export const SAMPLE_DEPARTMENTS = [
  {
    id: 'FTU',
    parentId: null,
    name: 'Trường Đại học Ngoại thương',
    type: 'university',
    path: ['FTU'],
  },
  {
    id: 'KTQT',
    parentId: 'FTU',
    name: 'Khoa Kinh tế quốc tế',
    type: 'faculty',
    path: ['FTU', 'KTQT'],
  },
  {
    id: 'QTKD',
    parentId: 'FTU',
    name: 'Khoa Quản trị kinh doanh',
    type: 'faculty',
    path: ['FTU', 'QTKD'],
  },
  {
    id: 'QLDT',
    parentId: 'FTU',
    name: 'Phòng Quản lý đào tạo',
    type: 'office',
    path: ['FTU', 'QLDT'],
  },
  {
    id: 'KTQT-KTVM',
    parentId: 'KTQT',
    name: 'Bộ môn Kinh tế vĩ mô',
    type: 'division',
    path: ['FTU', 'KTQT', 'KTQT-KTVM'],
  },
] as const;

export const APP_SETTINGS = {
  allowedEmailDomains: ['ftu.edu.vn'],
  exchangeRateVndPerUsd: 26_000,
  killSwitch: { all: false, providers: [] as string[], models: [] as string[] },
};
