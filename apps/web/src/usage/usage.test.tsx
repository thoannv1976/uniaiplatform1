import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Dashboard, MyUsage } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { recentPeriods } from './charts';
import { DashboardPage, type DashboardApi } from './DashboardPage';
import { MyUsagePage } from './MyUsagePage';
import { NotificationBell, type NotificationApi } from './NotificationBell';

const NOW = new Date('2026-10-15T05:00:00Z');
const getToken = () => Promise.resolve('t');

const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  period: '202610',
  departmentId: null,
  departmentName: 'Trường Đại học Ngoại thương',
  totalCost: 1_500_000,
  requests: 42,
  inputTokens: 1000,
  outputTokens: 2000,
  cachedTokens: 0,
  budget: 2_000_000,
  percentOfBudget: 75,
  forecast: 3_000_000,
  activeUsers: 7,
  activeToday: 3,
  byProvider: [{ key: 'openai', label: 'OpenAI', cost: 1_000_000, requests: 30 }],
  byModel: [{ key: 'gpt', label: 'GPT Mini', cost: 1_500_000, requests: 42 }],
  byTier: [],
  byDepartment: [
    { key: 'KTQT', label: 'Khoa Kinh tế quốc tế', cost: 1_200_000, requests: 30 },
    { key: 'QTKD', label: 'Khoa Quản trị kinh doanh', cost: 300_000, requests: 12 },
  ],
  byDay: [{ day: '20261014', cost: 500_000, requests: 10, users: 2 }],
  aggregatedAt: '2026-10-15T04:55:00Z',
  vndPerUsd: 26_000,
  ...over,
});

function dashboardApi() {
  const api: DashboardApi = {
    fetchDashboard: vi.fn((_t: string, _p?: string, dep?: string) =>
      Promise.resolve(dashboard(dep ? { departmentId: dep, departmentName: 'Khoa KTQT' } : {})),
    ),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([
        {
          id: 'KTQT',
          name: 'Khoa Kinh tế quốc tế',
          type: 'khoa',
          parentId: 'FTU',
          path: ['FTU', 'KTQT'],
          status: 'active',
        } as never,
      ]),
    ),
    downloadUsageExport: vi.fn(() => Promise.resolve()),
    setExchangeRate: vi.fn((_t: string, v: number) => Promise.resolve(v)),
  };
  return api;
}

describe('recentPeriods', () => {
  it('walks back across the year', () => {
    expect(recentPeriods('202602', 4)).toEqual(['202602', '202601', '202512', '202511']);
  });
});

describe('DashboardPage', () => {
  it('shows KPIs in USD and VND, a forecast warning and the unit ranking', async () => {
    const api = dashboardApi();
    render(<DashboardPage role="super_admin" getToken={getToken} api={api} now={NOW} />);
    expect(await screen.findByText('Tổng chi phí')).toBeTruthy();
    expect(screen.getByText(/39\.000 ₫/)).toBeTruthy();
    expect(screen.getByText('⚠ Vượt ngân sách')).toBeTruthy();
    expect(screen.getByText('Đã dùng 75%')).toBeTruthy();
    expect(screen.getByText('Khoa Quản trị kinh doanh')).toBeTruthy();

    fireEvent.change(await screen.findByLabelText('Phạm vi'), { target: { value: 'KTQT' } });
    await waitFor(() => expect(api.fetchDashboard).toHaveBeenLastCalledWith('t', '202610', 'KTQT'));

    fireEvent.click(screen.getByText('CSV theo người dùng'));
    await waitFor(() =>
      expect(api.downloadUsageExport).toHaveBeenCalledWith('t', 'users', '202610'),
    );

    fireEvent.change(screen.getByLabelText('Tỷ giá (VND/USD)'), { target: { value: '25.500' } });
    fireEvent.click(screen.getByText('Lưu tỷ giá'));
    await waitFor(() => expect(api.setExchangeRate).toHaveBeenCalledWith('t', 25_500));
  });

  it('gives unit admins no unit picker, no exchange rate form', async () => {
    const api = dashboardApi();
    render(<DashboardPage role="unit_admin" getToken={getToken} api={api} now={NOW} />);
    await screen.findByText('Tổng chi phí');
    expect(screen.queryByLabelText('Phạm vi')).toBeNull();
    expect(screen.queryByText('Lưu tỷ giá')).toBeNull();
    expect(screen.getByText('CSV theo đơn vị')).toBeTruthy();
    expect(api.fetchDepartments).not.toHaveBeenCalled();
  });

  it('hides exports from AI admins', async () => {
    render(<DashboardPage role="ai_admin" getToken={getToken} api={dashboardApi()} now={NOW} />);
    await screen.findByText('Tổng chi phí');
    expect(screen.queryByText('CSV theo đơn vị')).toBeNull();
  });
});

describe('MyUsagePage', () => {
  it('shows spend against the quota', async () => {
    const usage: MyUsage = {
      period: '202610',
      quota: {
        uid: 'gv',
        period: '202610',
        tierId: 'standard',
        limit: 2_000_000,
        premiumLimit: 0,
        used: 1_700_000,
        premiumUsed: 0,
        reserved: 0,
        premiumReserved: 0,
        departmentId: 'KTQT',
        departmentPath: ['FTU', 'KTQT'],
        email: 'gv@ftu.edu.vn',
        name: 'GV',
        remaining: 300_000,
        premiumRemaining: 0,
        percentUsed: 85,
      },
      totalCost: 1_700_000,
      requests: 12,
      byModel: [{ key: 'gpt', label: 'GPT Mini', cost: 1_700_000, requests: 12 }],
      byDay: [],
      vndPerUsd: 26_000,
    };
    render(
      <MyUsagePage
        getToken={getToken}
        now={NOW}
        api={{ fetchMyUsage: vi.fn(() => Promise.resolve(usage)) }}
      />,
    );
    expect(await screen.findByText('Đã dùng 85%')).toBeTruthy();
    expect(screen.getByText('$0.30')).toBeTruthy();
    expect(screen.getByText('GPT Mini')).toBeTruthy();
  });
});

describe('NotificationBell', () => {
  it('shows the unread count and marks all read when opened', async () => {
    const api: NotificationApi = {
      fetchNotifications: vi.fn(() =>
        Promise.resolve({
          unread: 1,
          notifications: [
            {
              id: 'n1',
              type: 'quota_80' as const,
              title: 'Đã dùng 80% định mức AI tháng này',
              message: 'Bạn đã dùng $1.60 trên $2.00.',
              createdAt: '2026-10-15T04:00:00Z',
              read: false,
            },
          ],
        }),
      ),
      markNotificationsRead: vi.fn(() => Promise.resolve()),
    };
    render(<NotificationBell getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByText('Thông báo (1)'));
    expect(screen.getByText('Đã dùng 80% định mức AI tháng này')).toBeTruthy();
    await waitFor(() => expect(api.markNotificationsRead).toHaveBeenCalled());
    expect(screen.getByText('Thông báo')).toBeTruthy();
  });
});
