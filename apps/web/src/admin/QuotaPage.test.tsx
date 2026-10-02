import { fireEvent, render, screen, within } from '@testing-library/react';
import type { QuotaSummary } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { QuotaPage, type QuotaApi } from './QuotaPage';

const q = (uid: string, used: number, limit = 2_000_000): QuotaSummary => ({
  uid,
  period: '202610',
  tierId: 'standard',
  limit,
  premiumLimit: 500_000,
  used,
  premiumUsed: 0,
  reserved: 0,
  premiumReserved: 0,
  departmentId: 'KTQT',
  departmentPath: ['FTU', 'KTQT'],
  email: `${uid}@ftu.edu.vn`,
  name: `Cán bộ ${uid}`,
  remaining: limit - used,
  premiumRemaining: 500_000,
  percentUsed: (used / limit) * 100,
});

function fakeApi() {
  const calls: unknown[] = [];
  const api: QuotaApi = {
    fetchQuotas: vi.fn(() =>
      Promise.resolve({ period: '202610', quotas: [q('gv1', 1_700_000), q('gv2', 100_000)] }),
    ),
    adjustQuota: vi.fn(
      (_t, input) => (calls.push(['adjust', input]), Promise.resolve({} as never)),
    ),
    fetchAdjustments: vi.fn(() => Promise.resolve([])),
    fetchBudgets: vi.fn(() =>
      Promise.resolve({
        period: '202610',
        budgets: [
          {
            departmentId: 'KTQT',
            period: '202610',
            budget: 10_000_000,
            allocated: 4_000_000,
            usedAggregate: 1_800_000,
            aggregatedAt: null,
            updatedBy: 'sa',
            updatedAt: null,
          },
        ],
      }),
    ),
    setBudget: vi.fn(
      (_t, id, input) => (
        calls.push(['budget', id, input]),
        Promise.resolve({ period: '202610', budgets: [] })
      ),
    ),
    fetchQuotaTiers: vi.fn(() =>
      Promise.resolve([
        {
          id: 'standard' as const,
          name: 'Tiêu chuẩn',
          monthlyBudget: 2_000_000,
          premiumBudget: 500_000,
          requestsPerMinute: 10,
        },
      ]),
    ),
    updateQuotaTier: vi.fn(
      (_t, id, patch) => (calls.push(['tier', id, patch]), Promise.resolve({} as never)),
    ),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([
        {
          id: 'FTU',
          name: 'Trường',
          type: 'university' as const,
          parentId: null,
          path: ['FTU'],
          status: 'active' as const,
        },
        {
          id: 'KTQT',
          name: 'Khoa KTQT',
          type: 'faculty' as const,
          parentId: 'FTU',
          path: ['FTU', 'KTQT'],
          status: 'active' as const,
        },
      ]),
    ),
  };
  return { api, calls };
}
const getToken = () => Promise.resolve('tok');

describe('QuotaPage', () => {
  it('lists staff usage and unit budgets', async () => {
    const { api } = fakeApi();
    render(<QuotaPage canEdit canEditTiers getToken={getToken} api={api} />);
    expect(await screen.findByText('Định mức và ngân sách – tháng 10/2026')).toBeInTheDocument();
    expect(screen.getByText('$1.70 / $2.00', { exact: false })).toBeInTheDocument();
    const budgetSection = screen.getByText('Ngân sách đơn vị').closest('div') as HTMLElement;
    expect(within(budgetSection).getByRole('cell', { name: 'Khoa KTQT' })).toBeInTheDocument();
    expect(within(budgetSection).getByRole('cell', { name: '$10.00' })).toBeInTheDocument();
  });

  it('adjusts a quota with reason and approver, in micro-USD', async () => {
    const { api, calls } = fakeApi();
    render(<QuotaPage canEdit canEditTiers={false} getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Điều chỉnh Cán bộ gv1' }));
    const form = screen
      .getByRole('button', { name: 'Lưu điều chỉnh' })
      .closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Số tiền (USD)'), { target: { value: '1,5' } });
    fireEvent.change(within(form).getByLabelText('Lý do'), {
      target: { value: 'Đề tài NCKH cấp trường' },
    });
    fireEvent.change(within(form).getByLabelText('Người phê duyệt'), {
      target: { value: 'Trưởng khoa' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lưu điều chỉnh' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        [
          'adjust',
          {
            uid: 'gv1',
            type: 'increase',
            kind: 'monthly',
            amount: 1_500_000,
            reason: 'Đề tài NCKH cấp trường',
            approvedBy: 'Trưởng khoa',
          },
        ],
      ]),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Đã điều chỉnh');
    // Tiers are read-only without the super admin right.
    expect(screen.queryByLabelText('Ngân sách tháng Tiêu chuẩn')).not.toBeInTheDocument();
  });

  it('is read-only for auditors', async () => {
    const { api } = fakeApi();
    render(<QuotaPage canEdit={false} canEditTiers={false} getToken={getToken} api={api} />);
    expect(await screen.findByText('Cán bộ gv1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Điều chỉnh/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Đặt ngân sách' })).not.toBeInTheDocument();
  });
});
