import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MonthlyReportView } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ReportsPage, type ReportsApi } from './ReportsPage';

const REPORT: MonthlyReportView = {
  period: '202609',
  generatedAt: '2026-10-01T18:15:00.000Z',
  final: true,
  vndPerUsd: 26_000,
  totalCost: 583_000_000,
  requests: 12_345,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cachedTokens: 0,
  activeUsers: 321,
  budget: 800_000_000,
  percentOfBudget: 72.9,
  byProvider: [{ key: 'openai', label: 'OpenAI', cost: 310_000_000, requests: 6000 }],
  byModel: [{ key: 'm1', label: 'Model Một', cost: 583_000_000, requests: 12_345 }],
  byTier: [{ key: 'economy', label: 'Tiết kiệm', cost: 583_000_000, requests: 12_345 }],
  byDay: [],
  departments: [
    {
      id: 'FTU',
      name: 'Trường Đại học Ngoại thương',
      parentId: null,
      depth: 0,
      cost: 583_000_000,
      requests: 12_345,
      inputTokens: 1,
      outputTokens: 1,
      budget: 800_000_000,
      allocated: 600_000_000,
      percentOfBudget: 72.9,
    },
    {
      id: 'KTQT',
      name: 'Khoa Kinh tế quốc tế',
      parentId: 'FTU',
      depth: 1,
      cost: 210_000_000,
      requests: 4000,
      inputTokens: 1,
      outputTokens: 1,
      budget: 200_000_000,
      allocated: null,
      percentOfBudget: 105,
    },
  ],
  scopeDepartmentId: null,
  scopeName: 'Trường Đại học Ngoại thương',
  stored: true,
};

function fakeApi(report = REPORT) {
  const api: ReportsApi = {
    fetchMonthlyReport: vi.fn((_t, period) => Promise.resolve({ ...report, period })),
    generateMonthlyReport: vi.fn((_t, period) => Promise.resolve({ ...report, period })),
    downloadMonthlyReport: vi.fn(() => Promise.resolve()),
  };
  return api;
}
const getToken = () => Promise.resolve('t');
const now = new Date('2026-10-02T03:00:00Z');

describe('ReportsPage', () => {
  it('opens last month, shows units with budget use and exports Excel', async () => {
    const api = fakeApi();
    render(<ReportsPage role="super_admin" getToken={getToken} api={api} now={now} />);
    const overview = await screen.findByRole('region', { name: 'Tổng quan' });
    expect(overview).toHaveTextContent('$583.00');
    expect(overview).toHaveTextContent('Đã dùng 72.9%');
    expect(api.fetchMonthlyReport).toHaveBeenCalledWith('t', '202609');
    const units = screen.getByRole('region', { name: 'Theo đơn vị' });
    const row = within(units).getByText('Khoa Kinh tế quốc tế').closest('tr')!;
    expect(row).toHaveTextContent('105%');
    expect(screen.getByText(/Báo cáo đã chốt/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Tải Excel'));
    await vi.waitFor(() =>
      expect(api.downloadMonthlyReport).toHaveBeenCalledWith(
        't',
        '202609',
        'bao-cao-ai-202609.xlsx',
      ),
    );
    fireEvent.click(screen.getByText('Tạo lại báo cáo'));
    expect(await screen.findByText('Đã lưu báo cáo tháng 09/2026.')).toBeInTheDocument();
  });

  it('shows a Unit Admin their own unit only, without regenerating', async () => {
    const api = fakeApi({
      ...REPORT,
      stored: false,
      scopeDepartmentId: 'KTQT',
      scopeName: 'Khoa Kinh tế quốc tế',
      departments: REPORT.departments.slice(1),
    });
    render(<ReportsPage role="unit_admin" getToken={getToken} api={api} now={now} />);
    expect(await screen.findByText('Báo cáo tháng – Khoa Kinh tế quốc tế')).toBeInTheDocument();
    expect(screen.getByText(/Số liệu tạm tính/)).toBeInTheDocument();
    expect(screen.queryByText('Lưu báo cáo tháng')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tháng'), { target: { value: '202608' } });
    await vi.waitFor(() => expect(api.fetchMonthlyReport).toHaveBeenCalledWith('t', '202608'));
    fireEvent.click(screen.getByText('Tải Excel'));
    await vi.waitFor(() =>
      expect(api.downloadMonthlyReport).toHaveBeenCalledWith(
        't',
        '202608',
        'bao-cao-ai-202608-KTQT.xlsx',
      ),
    );
  });
});
