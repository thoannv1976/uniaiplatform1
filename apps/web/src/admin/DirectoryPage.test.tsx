import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Department, DirectoryEntry } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { DirectoryPage, type DirectoryApi } from './DirectoryPage';

const dept = (id: string, path: string[], name = id): Department => ({
  id,
  name,
  type: 'faculty',
  parentId: path.length > 1 ? (path.at(-2) as string) : null,
  path,
  status: 'active',
});
const DEPTS = [
  dept('FTU', ['FTU'], 'Trường'),
  dept('KTQT', ['FTU', 'KTQT'], 'Khoa KTQT'),
  dept('QTKD', ['FTU', 'QTKD'], 'Khoa QTKD'),
];

const entry = (email: string, over: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  email,
  uid: null,
  fullName: null,
  staffCode: null,
  title: null,
  departmentId: 'KTQT',
  departmentPath: ['FTU', 'KTQT'],
  role: 'user',
  status: 'active',
  quotaTierId: 'standard',
  scopeDepartmentId: null,
  activatedAt: null,
  lockedAt: null,
  updatedAt: null,
  updatedBy: null,
  ...over,
});

function fakeApi(entries: DirectoryEntry[]) {
  const updates: unknown[] = [];
  const api: DirectoryApi = {
    fetchDirectory: vi.fn(() => Promise.resolve(entries)),
    fetchDepartments: vi.fn(() => Promise.resolve(DEPTS)),
    updateDirectoryEntry: vi.fn((_t: string, email: string, patch: object) => {
      updates.push({ email, patch });
      return Promise.resolve({
        ...(entries.find((e) => e.email === email) as DirectoryEntry),
        ...patch,
      });
    }),
    importCsv: vi.fn(),
    downloadExport: vi.fn(() => Promise.resolve()),
  };
  return { api, updates };
}
const getToken = () => Promise.resolve('tok');

describe('DirectoryPage', () => {
  it('searches without diacritics and filters by department subtree', async () => {
    const { api } = fakeApi([
      entry('a@ftu.edu.vn', { fullName: 'Nguyễn Văn Ánh' }),
      entry('b@ftu.edu.vn', {
        fullName: 'Trần B',
        departmentId: 'QTKD',
        departmentPath: ['FTU', 'QTKD'],
      }),
    ]);
    render(
      <DirectoryPage
        role="super_admin"
        selfUid="sa"
        scopeDepartmentId={null}
        getToken={getToken}
        api={api}
      />,
    );
    expect(await screen.findByText('2 / 2 cán bộ')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tìm kiếm'), { target: { value: 'nguyen anh' } });
    expect(screen.getByText('1 / 2 cán bộ')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tìm kiếm'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Lọc theo đơn vị'), { target: { value: 'QTKD' } });
    expect(screen.getByText('b@ftu.edu.vn')).toBeInTheDocument();
    expect(screen.queryByText('a@ftu.edu.vn')).not.toBeInTheDocument();
  });

  it('lets a Super Admin edit a person and set a unit admin scope', async () => {
    const { api, updates } = fakeApi([entry('a@ftu.edu.vn')]);
    render(
      <DirectoryPage
        role="super_admin"
        selfUid="sa"
        scopeDepartmentId={null}
        getToken={getToken}
        api={api}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sửa a@ftu.edu.vn' }));
    fireEvent.change(screen.getByLabelText('Họ tên'), { target: { value: 'Lê Văn A' } });
    fireEvent.change(screen.getByLabelText('Vai trò'), { target: { value: 'unit_admin' } });
    fireEvent.change(screen.getByLabelText('Đơn vị quản lý'), { target: { value: 'KTQT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await vi.waitFor(() =>
      expect(updates).toEqual([
        {
          email: 'a@ftu.edu.vn',
          patch: expect.objectContaining({
            fullName: 'Lê Văn A',
            role: 'unit_admin',
            scopeDepartmentId: 'KTQT',
          }),
        },
      ]),
    );
  });

  it('unit admins cannot change roles, cannot touch other admins and only assign inside their unit', async () => {
    const { api, updates } = fakeApi([
      entry('gv@ftu.edu.vn'),
      entry('boss@ftu.edu.vn', { role: 'unit_admin', scopeDepartmentId: 'KTQT' }),
    ]);
    render(
      <DirectoryPage
        role="unit_admin"
        selfUid="ka"
        scopeDepartmentId="KTQT"
        getToken={getToken}
        api={api}
      />,
    );
    const bossRow = (await screen.findByText('boss@ftu.edu.vn')).closest('tr') as HTMLElement;
    expect(within(bossRow).queryByRole('button')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sửa gv@ftu.edu.vn' }));
    expect(screen.queryByLabelText('Vai trò')).not.toBeInTheDocument();
    const options = within(screen.getByLabelText('Đơn vị'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Khoa KTQT']);
    fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));

    fireEvent.click(screen.getByRole('button', { name: 'Khóa gv@ftu.edu.vn' }));
    await vi.waitFor(() =>
      expect(updates).toEqual([{ email: 'gv@ftu.edu.vn', patch: { status: 'locked' } }]),
    );
    expect(
      await screen.findByRole('button', { name: 'Mở khóa gv@ftu.edu.vn' }),
    ).toBeInTheDocument();
  });

  it('is read-only for auditors but can export', async () => {
    const { api } = fakeApi([entry('a@ftu.edu.vn')]);
    render(
      <DirectoryPage
        role="auditor"
        selfUid="au"
        scopeDepartmentId={null}
        getToken={getToken}
        api={api}
      />,
    );
    await screen.findByText('a@ftu.edu.vn');
    expect(screen.queryByRole('button', { name: 'Nhập CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sửa/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Xuất CSV' }));
    await vi.waitFor(() =>
      expect(api.downloadExport).toHaveBeenCalledWith('tok', 'directory', 'can-bo.csv'),
    );
  });
});
