import { fireEvent, render, screen } from '@testing-library/react';
import type { FileView, Project, Prompt } from '@uniai/shared';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePage, type WorkspaceApi } from './WorkspacePage';

const prompt = (over: Partial<Prompt>): Prompt => ({
  id: 'p1',
  title: 'Dịch thư',
  description: '',
  body: 'Dịch {{đoạn}}',
  category: 'dich-thuat',
  variables: ['đoạn'],
  visibility: 'private',
  publishedTo: [],
  ownerUid: 'me',
  editable: true,
  createdAt: '',
  updatedAt: '',
  ...over,
});
const FILE: FileView = {
  id: 'f1',
  name: 'syllabus.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  size: 4096,
  status: 'ready',
  pages: 3,
  chars: 900,
  truncated: false,
  error: null,
  createdAt: '2026-10-02T00:00:00.000Z',
};

function fakeApi() {
  const api: WorkspaceApi = {
    fetchPrompts: vi.fn(() =>
      Promise.resolve([
        prompt({}),
        prompt({ id: 'p2', title: 'Chung', visibility: 'shared', editable: false }),
      ]),
    ),
    createPrompt: vi.fn(() => Promise.resolve(prompt({}))),
    updatePrompt: vi.fn(() => Promise.resolve(prompt({}))),
    deletePrompt: vi.fn(() => Promise.resolve()),
    fetchProjects: vi.fn(() => Promise.resolve([] as Project[])),
    createProject: vi.fn((_t, input) =>
      Promise.resolve({ id: 'pr1', ...input, createdAt: '', updatedAt: '' } as Project),
    ),
    updateProject: vi.fn(() => Promise.resolve({} as Project)),
    deleteProject: vi.fn(() => Promise.resolve()),
    fetchMyFiles: vi.fn(() => Promise.resolve([FILE])),
    deleteFile: vi.fn(() => Promise.resolve()),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([{ id: 'KTQT', name: 'Khoa KTQT', status: 'active' } as never]),
    ),
  };
  return api;
}
const getToken = () => Promise.resolve('t');
const ui = (role: 'user' | 'ai_admin', api: WorkspaceApi) =>
  render(
    <MemoryRouter>
      <WorkspacePage role={role} getToken={getToken} api={api} />
    </MemoryRouter>,
  );

describe('WorkspacePage', () => {
  it('creates a private prompt; only own prompts are editable', async () => {
    const api = fakeApi();
    ui('user', api);
    expect(await screen.findByText('Chung')).toBeInTheDocument();
    expect(screen.getAllByText('Sửa')).toHaveLength(1);
    expect(screen.queryByText('Chia sẻ cho đơn vị (dùng chung)')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tiêu đề'), { target: { value: 'Tóm tắt' } });
    fireEvent.change(screen.getByLabelText(/Nội dung/), {
      target: { value: 'Tóm tắt {{văn bản}}' },
    });
    fireEvent.click(screen.getByText('Lưu prompt'));
    await vi.waitFor(() =>
      expect(api.createPrompt).toHaveBeenCalledWith('t', {
        title: 'Tóm tắt',
        description: '',
        body: 'Tóm tắt {{văn bản}}',
        category: 'khac',
        visibility: 'private',
        publishedTo: [],
      }),
    );
  });

  it('lets AI admins publish to units', async () => {
    const api = fakeApi();
    ui('ai_admin', api);
    fireEvent.change(await screen.findByLabelText('Tiêu đề'), { target: { value: 'Chung KTQT' } });
    fireEvent.change(screen.getByLabelText(/Nội dung/), { target: { value: 'X' } });
    fireEvent.click(screen.getByText('Chia sẻ cho đơn vị (dùng chung)'));
    const units = await screen.findByLabelText('Đơn vị nhận');
    (units as HTMLSelectElement).options[0]!.selected = true;
    fireEvent.change(units);
    fireEvent.click(screen.getByText('Lưu prompt'));
    await vi.waitFor(() =>
      expect(api.createPrompt).toHaveBeenCalledWith(
        't',
        expect.objectContaining({ visibility: 'shared', publishedTo: ['KTQT'] }),
      ),
    );
  });

  it('creates a project with files and lists my files', async () => {
    const api = fakeApi();
    ui('user', api);
    fireEvent.click(await screen.findByText(/Tệp của tôi/));
    expect(screen.getByText('syllabus.pdf')).toBeInTheDocument();
    expect(screen.getByText(/4 KB · 3 trang/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Dự án \(/));
    fireEvent.change(screen.getByLabelText('Tên dự án'), { target: { value: 'Đề cương' } });
    fireEvent.click(screen.getByLabelText('syllabus.pdf'));
    fireEvent.click(screen.getByText('Lưu dự án'));
    await vi.waitFor(() =>
      expect(api.createProject).toHaveBeenCalledWith('t', {
        name: 'Đề cương',
        instructions: '',
        fileIds: ['f1'],
      }),
    );
  });
});
