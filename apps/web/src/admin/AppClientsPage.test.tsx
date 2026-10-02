import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppClientView } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { AppClientsPage, type AppClientsApi } from './AppClientsPage';

const CLIENT: AppClientView = {
  id: 'abcdefghij0123456789',
  name: 'LMS',
  description: '',
  ownerDepartmentId: 'KTQT',
  scopes: ['chat', 'usage'],
  monthlyBudget: 20_000_000,
  requestsPerMinute: 60,
  allowAdvanced: false,
  status: 'active',
  keyLast4: 'wxyz',
  createdBy: 'sa',
  createdAt: '',
  updatedAt: '',
  rotatedAt: null,
  lastUsedAt: null,
  period: '202610',
  used: 1_250_000,
  reserved: 0,
};
// Built at runtime so the repository's secret scan does not flag a fake key.
const KEY = ['uak', CLIENT.id, 'S'.repeat(43)].join('_');

function fakeApi() {
  const api: AppClientsApi = {
    fetchAppClients: vi.fn(() => Promise.resolve([CLIENT])),
    createAppClient: vi.fn((_t, input) =>
      Promise.resolve({ client: { ...CLIENT, name: input.name }, key: KEY }),
    ),
    updateAppClient: vi.fn((_t, _id, patch) => Promise.resolve({ ...CLIENT, ...patch })),
    rotateAppClientKey: vi.fn(() => Promise.resolve({ client: CLIENT, key: KEY })),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([
        {
          id: 'KTQT',
          name: 'Khoa Kinh tế quốc tế',
          type: 'faculty' as const,
          parentId: 'FTU',
          path: ['FTU', 'KTQT'],
          status: 'active' as const,
        },
      ]),
    ),
  };
  return api;
}
const getToken = () => Promise.resolve('t');

describe('AppClientsPage', () => {
  it('lists apps with spend and shows a new key once', async () => {
    const api = fakeApi();
    render(<AppClientsPage canEdit getToken={getToken} api={api} />);
    const list = await screen.findByRole('region', { name: 'Danh sách ứng dụng' });
    expect(within(list).getByText('Khoa Kinh tế quốc tế')).toBeInTheDocument();
    expect(list).toHaveTextContent('$1.25 / $20.00');
    expect(list).toHaveTextContent('…wxyz');

    fireEvent.change(screen.getByLabelText('Tên ứng dụng'), { target: { value: 'Cổng SV' } });
    fireEvent.change(screen.getByLabelText('Đơn vị chủ quản'), { target: { value: 'KTQT' } });
    fireEvent.change(screen.getByLabelText('Ngân sách tháng (USD)'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Tạo ứng dụng và cấp key'));
    expect(await screen.findByTestId('app-key')).toHaveTextContent(KEY);
    expect(vi.mocked(api.createAppClient).mock.calls[0]![1]).toMatchObject({
      name: 'Cổng SV',
      ownerDepartmentId: 'KTQT',
      monthlyBudget: 5_000_000,
      scopes: ['chat', 'usage'],
    });
    fireEvent.click(screen.getByText('Đã lưu key, đóng'));
    expect(screen.queryByTestId('app-key')).not.toBeInTheDocument();
  });

  it('rotates keys, pauses apps and changes budgets; auditors only read', async () => {
    const api = fakeApi();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(<AppClientsPage canEdit getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByText('Đổi key'));
    expect(await screen.findByTestId('app-key')).toHaveTextContent(KEY);
    fireEvent.click(screen.getByText('Tạm dừng'));
    await vi.waitFor(() =>
      expect(api.updateAppClient).toHaveBeenCalledWith('t', CLIENT.id, { status: 'disabled' }),
    );
    fireEvent.change(screen.getByLabelText('Ngân sách mới của LMS (USD)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByText('Lưu'));
    await vi.waitFor(() =>
      expect(api.updateAppClient).toHaveBeenCalledWith('t', CLIENT.id, {
        monthlyBudget: 30_000_000,
      }),
    );
    unmount();

    render(<AppClientsPage canEdit={false} getToken={getToken} api={fakeApi()} />);
    await screen.findByRole('region', { name: 'Danh sách ứng dụng' });
    expect(screen.queryByText('Đổi key')).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Thêm ứng dụng' })).not.toBeInTheDocument();
  });
});
