import { fireEvent, render, screen, within } from '@testing-library/react';
import type { KbDocument, KnowledgeBase } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgePage, type KnowledgeApi } from './KnowledgePage';

const KB: KnowledgeBase = {
  id: 'k1',
  name: 'Quy chế',
  description: '',
  aclScopeId: null,
  active: true,
  documentCount: 1,
  createdAt: '',
  updatedAt: '',
};
const doc = (over: Partial<KbDocument>): KbDocument => ({
  id: 'd1',
  kbId: 'k1',
  title: 'Quy chế đào tạo',
  version: 1,
  effectiveDate: '2026-09-01',
  status: 'ready',
  fileName: 'qc.pdf',
  mime: 'application/pdf',
  size: 2048,
  pages: 12,
  chunkCount: 30,
  error: null,
  replacesId: null,
  uploadedBy: 'ai',
  createdAt: '',
  readyAt: null,
  ...over,
});

function fakeApi(docs: KbDocument[]) {
  const api: KnowledgeApi = {
    fetchKnowledgeBases: vi.fn(() => Promise.resolve([KB])),
    createKnowledgeBase: vi.fn((_t, input) =>
      Promise.resolve({ ...KB, id: 'k2', name: input.name, aclScopeId: input.aclScopeId }),
    ),
    updateKnowledgeBase: vi.fn(() => Promise.resolve(KB)),
    fetchKbDocuments: vi.fn(() => Promise.resolve(docs)),
    uploadKbDocument: vi.fn(() => Promise.resolve(doc({ id: 'd2', status: 'queued' }))),
    retryKbDocument: vi.fn(() => Promise.resolve(doc({}))),
    deleteKbDocument: vi.fn(() => Promise.resolve()),
    fetchDepartments: vi.fn(() =>
      Promise.resolve([
        {
          id: 'KTQT',
          name: 'Khoa KTQT',
          type: 'khoa',
          parentId: 'FTU',
          path: ['FTU', 'KTQT'],
          status: 'active',
        } as never,
      ]),
    ),
  };
  return api;
}
const getToken = () => Promise.resolve('t');

describe('KnowledgePage', () => {
  it('lists documents with status and uploads a new version', async () => {
    const api = fakeApi([
      doc({}),
      doc({ id: 'd0', status: 'failed', error: 'PDF hỏng', version: 1 }),
    ]);
    render(<KnowledgePage canEdit getToken={getToken} api={api} />);
    expect(await screen.findByText('Phạm vi: Toàn trường')).toBeInTheDocument();
    const rows = await screen.findAllByRole('row');
    expect(rows[1]).toHaveTextContent('Sẵn sàng');
    expect(within(rows[2]!).getByText('PDF hỏng')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Xử lý lại'));
    await vi.waitFor(() => expect(api.retryKbDocument).toHaveBeenCalledWith('t', 'd0'));

    const file = new File(['%PDF-'], 'qc-2027.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/Tệp \(PDF/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Là phiên bản mới của'), { target: { value: 'd1' } });
    fireEvent.click(screen.getByText('Tải lên'));
    await vi.waitFor(() =>
      expect(api.uploadKbDocument).toHaveBeenCalledWith('t', 'k1', file, {
        title: 'qc-2027',
        effectiveDate: null,
        replacesDocumentId: 'd1',
      }),
    );
  });

  it('creates a base scoped to a unit; auditors only read', async () => {
    const api = fakeApi([]);
    const { unmount } = render(<KnowledgePage canEdit getToken={getToken} api={api} />);
    fireEvent.change(await screen.findByLabelText('Tên kho mới'), { target: { value: 'Khoa' } });
    fireEvent.change(screen.getByLabelText('Phạm vi'), { target: { value: 'KTQT' } });
    fireEvent.click(screen.getByText('Tạo kho'));
    await vi.waitFor(() =>
      expect(api.createKnowledgeBase).toHaveBeenCalledWith('t', {
        name: 'Khoa',
        description: '',
        aclScopeId: 'KTQT',
      }),
    );
    unmount();
    render(<KnowledgePage canEdit={false} getToken={getToken} api={fakeApi([doc({})])} />);
    await screen.findByText('Quy chế đào tạo');
    expect(screen.queryByText('Tải lên')).not.toBeInTheDocument();
    expect(screen.queryByText('Xóa')).not.toBeInTheDocument();
  });
});
