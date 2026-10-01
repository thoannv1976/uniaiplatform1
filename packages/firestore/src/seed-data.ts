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

export const SAMPLE_DEPARTMENTS = [
  { id: 'truong', parentId: null, code: 'TRUONG', name: 'Trường', type: 'university' },
  {
    id: 'khoa-cntt',
    parentId: 'truong',
    code: 'CNTT',
    name: 'Khoa Công nghệ thông tin',
    type: 'faculty',
  },
  { id: 'khoa-kt', parentId: 'truong', code: 'KT', name: 'Khoa Kinh tế', type: 'faculty' },
  { id: 'phong-dt', parentId: 'truong', code: 'PDT', name: 'Phòng Đào tạo', type: 'office' },
] as const;

export const APP_SETTINGS = {
  allowedEmailDomains: ['example.edu.vn'],
  exchangeRateVndPerUsd: 26_000,
  killSwitch: { all: false, providers: [] as string[], models: [] as string[] },
};
