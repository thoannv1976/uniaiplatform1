import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_DLP_POLICY, type DlpPolicyView } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { DlpPage, type DlpApi } from './DlpPage';

const VIEW: DlpPolicyView = { policy: DEFAULT_DLP_POLICY, updatedBy: null, updatedAt: null };

function fakeApi() {
  const api: DlpApi = {
    fetchDlpRules: vi.fn(() => Promise.resolve(VIEW)),
    saveDlpRules: vi.fn((_t, policy) => Promise.resolve({ ...VIEW, policy })),
    testDlpRules: vi.fn(() =>
      Promise.resolve({
        action: 'mask' as const,
        findings: [{ detector: 'cccd' as const, action: 'mask' as const }],
        masked: 'CCCD [CCCD_1]',
      }),
    ),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([
        {
          id: 'QLDT',
          name: 'Phòng Quản lý đào tạo',
          code: 'QLDT',
          parentId: 'FTU',
          path: ['FTU', 'QLDT'],
          active: true,
          createdAt: '',
          updatedAt: '',
        },
      ] as never),
    ),
  };
  return api;
}
const getToken = () => Promise.resolve('t');

describe('DlpPage', () => {
  it('changes a default action, adds a unit exception and saves', async () => {
    const api = fakeApi();
    render(<DlpPage canEdit getToken={getToken} api={api} />);
    fireEvent.change(await screen.findByLabelText('Hành động cho Số CCCD/CMND'), {
      target: { value: 'block' },
    });
    fireEvent.click(screen.getByText('+ Thêm ngoại lệ'));
    const units = screen.getByLabelText('Đơn vị ngoại lệ 1') as HTMLSelectElement;
    units.options[0]!.selected = true;
    fireEvent.change(units);
    fireEvent.change(screen.getByLabelText('Ghi chú ngoại lệ 1'), {
      target: { value: 'Xử lý điểm' },
    });
    fireEvent.click(screen.getByText('Lưu chính sách'));
    expect(await screen.findByText(/Đã lưu chính sách DLP/)).toBeInTheDocument();
    const saved = vi.mocked(api.saveDlpRules).mock.calls[0]![1];
    expect(saved.defaults.cccd).toBe('block');
    expect(saved.overrides).toEqual([
      {
        detector: 'student_data',
        action: 'allow',
        departmentIds: ['QLDT'],
        roles: [],
        note: 'Xử lý điểm',
      },
    ]);
  });

  it('previews a sample and is read-only for auditors', async () => {
    const api = fakeApi();
    const { unmount } = render(<DlpPage canEdit getToken={getToken} api={api} />);
    fireEvent.change(await screen.findByLabelText('Văn bản thử'), {
      target: { value: 'CCCD 001203004567' },
    });
    fireEvent.click(screen.getByText('Kiểm tra'));
    expect(await screen.findByText('Sau khi che: CCCD [CCCD_1]')).toBeInTheDocument();
    unmount();

    render(<DlpPage canEdit={false} getToken={getToken} api={fakeApi()} />);
    expect(await screen.findByLabelText('Hành động cho Mật khẩu')).toBeDisabled();
    expect(screen.queryByText('Lưu chính sách')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Văn bản thử')).not.toBeInTheDocument();
  });
});
