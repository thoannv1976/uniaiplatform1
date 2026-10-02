import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_ROUTER_CONFIG, type RouterView } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { RouterPage, type RouterApi } from './RouterPage';

const VIEW: RouterView = {
  config: DEFAULT_ROUTER_CONFIG,
  period: '202610',
  requests: 120,
  actual: { economy: 80, standard: 15, advanced: 5, premium: 0 },
  updatedBy: null,
  updatedAt: null,
};

function fakeApi() {
  const api: RouterApi = {
    fetchRouter: vi.fn(() => Promise.resolve(VIEW)),
    saveRouter: vi.fn((_t, config) => Promise.resolve({ ...VIEW, config })),
    testRouter: vi.fn(() =>
      Promise.resolve({
        tier: 'standard' as const,
        ruleId: 'lap-trinh',
        reason: 'AUTO: luật "Lập trình, dữ liệu" → nhóm Tiêu chuẩn',
        modelId: 'm',
        modelName: 'Model T',
      }),
    ),
  };
  return api;
}
const getToken = () => Promise.resolve('t');

describe('RouterPage', () => {
  it('shows shares, edits a rule and saves', async () => {
    const api = fakeApi();
    render(<RouterPage canEdit getToken={getToken} api={api} />);
    expect(await screen.findByText('80%')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Bật luật Lập trình, dữ liệu'));
    fireEvent.change(screen.getByLabelText('Mục tiêu Tiết kiệm'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('+ Thêm luật'));
    fireEvent.click(screen.getByText('Lưu cấu hình'));
    expect(await screen.findByText('Đã lưu cấu hình định tuyến.')).toBeInTheDocument();
    const saved = vi.mocked(api.saveRouter).mock.calls[0]![1];
    expect(saved.rules.find((r) => r.id === 'lap-trinh')?.enabled).toBe(false);
    expect(saved.targets.economy).toBe(60);
    expect(saved.rules).toHaveLength(DEFAULT_ROUTER_CONFIG.rules.length + 1);
  });

  it('runs a dry test and is read-only for auditors', async () => {
    const api = fakeApi();
    const { unmount } = render(<RouterPage canEdit getToken={getToken} api={api} />);
    fireEvent.change(await screen.findByLabelText('Câu hỏi thử'), {
      target: { value: 'Viết code' },
    });
    fireEvent.click(screen.getByText('Thử'));
    expect(await screen.findByRole('status')).toHaveTextContent('Model T');
    unmount();
    render(<RouterPage canEdit={false} getToken={getToken} api={fakeApi()} />);
    await screen.findByText('80%');
    expect(screen.queryByText('Lưu cấu hình')).not.toBeInTheDocument();
  });
});
