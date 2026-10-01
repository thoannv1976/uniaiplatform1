import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Department } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { DepartmentsPage, type DepartmentsApi } from './DepartmentsPage';

const d = (
  id: string,
  path: string[],
  name = id,
  status: Department['status'] = 'active',
): Department => ({
  id,
  name,
  type: path.length === 1 ? 'university' : 'faculty',
  parentId: path.length > 1 ? (path.at(-2) as string) : null,
  path,
  status,
});
const TREE = [
  d('FTU', ['FTU'], 'Trường'),
  d('KTQT', ['FTU', 'KTQT'], 'Khoa KTQT'),
  d('BM1', ['FTU', 'KTQT', 'BM1'], 'Bộ môn 1'),
];

function fakeApi(list: Department[]) {
  const calls: unknown[] = [];
  const api: DepartmentsApi = {
    fetchDepartments: vi.fn(() => Promise.resolve(list)),
    createDepartment: vi.fn(
      (_t, input) => (calls.push(['create', input]), Promise.resolve(list[0] as Department)),
    ),
    updateDepartment: vi.fn(
      (_t, id, patch) => (
        calls.push(['update', id, patch]),
        Promise.resolve(list[0] as Department)
      ),
    ),
    importCsv: vi.fn(),
    downloadExport: vi.fn(() => Promise.resolve()),
  };
  return { api, calls };
}
const getToken = () => Promise.resolve('tok');

describe('DepartmentsPage', () => {
  it('shows the tree and creates a child department', async () => {
    const { api, calls } = fakeApi(TREE);
    render(<DepartmentsPage canEdit canExport getToken={getToken} api={api} />);
    expect(await screen.findByText('Bộ môn 1')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Mã đơn vị'), { target: { value: 'QTKD' } });
    fireEvent.change(screen.getByLabelText('Tên đơn vị'), { target: { value: 'Khoa QTKD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Thêm' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['create', { id: 'QTKD', name: 'Khoa QTKD', type: 'faculty', parentId: 'FTU' }],
      ]),
    );
  });

  it('does not offer a department or its children as its new parent', async () => {
    const { api } = fakeApi(TREE);
    render(<DepartmentsPage canEdit canExport getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sửa KTQT' }));
    const editForm = screen.getByRole('button', { name: 'Lưu' }).closest('form') as HTMLElement;
    const options = within(within(editForm).getByLabelText('Đơn vị cha'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Trường']);
  });

  it('archives a department and is read-only without edit rights', async () => {
    const { api, calls } = fakeApi(TREE);
    const { unmount } = render(<DepartmentsPage canEdit canExport getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ngừng BM1' }));
    await vi.waitFor(() => expect(calls).toEqual([['update', 'BM1', { status: 'archived' }]]));
    unmount();

    render(
      <DepartmentsPage
        canEdit={false}
        canExport={false}
        getToken={getToken}
        api={fakeApi(TREE).api}
      />,
    );
    await screen.findByText('Bộ môn 1');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
