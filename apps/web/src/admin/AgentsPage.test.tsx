import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Agent, Integration } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { AgentsPage, type AgentsAdminApi } from './AgentsPage';

const INTEGRATION: Integration = {
  id: 'lms',
  name: 'LMS thử nghiệm',
  type: 'lms',
  description: '',
  baseUrl: 'https://lms.example.edu.vn/api',
  authType: 'bearer',
  authHeader: null,
  sendActor: true,
  timeoutMs: 10000,
  status: 'active',
  operations: [
    {
      id: 'get_course',
      name: 'Thông tin học phần',
      description: 'Theo mã học phần',
      method: 'GET',
      path: '/courses/{courseId}',
      parameters: [
        { name: 'courseId', in: 'path', type: 'string', description: 'Mã', required: true },
      ],
    },
  ],
  tokenLast4: 'abcd',
  updatedBy: 'sa',
  updatedAt: null,
};
const AGENT: Agent = {
  id: 'a1',
  name: 'Trợ lý đào tạo',
  description: 'Tra cứu học phần',
  instructions: 'Trả lời về học phần.',
  model: 'auto',
  tools: ['lms.get_course'],
  knowledgeBaseIds: [],
  publishedTo: ['KTQT'],
  allowApps: false,
  maxSteps: 4,
  status: 'active',
  createdBy: 'sa',
  createdAt: '',
  updatedAt: '',
};

function fakeApi() {
  const api: AgentsAdminApi = {
    fetchAdminAgents: vi.fn(() => Promise.resolve([AGENT])),
    saveAgent: vi.fn((_t, id, input) => Promise.resolve({ ...AGENT, ...input, id: id ?? 'new' })),
    fetchIntegrations: vi.fn(() => Promise.resolve([INTEGRATION])),
    saveIntegration: vi.fn((_t, id, input) => Promise.resolve({ ...INTEGRATION, ...input, id })),
    setIntegrationToken: vi.fn(() => Promise.resolve()),
    testIntegrationOperation: vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        bytes: 42,
        durationMs: 12,
        preview: '{"lecturer":"[EMAIL_1]"}',
        error: null,
      }),
    ),
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

describe('AgentsPage', () => {
  it('creates an agent with integration tools', async () => {
    const api = fakeApi();
    render(<AgentsPage canEdit getToken={getToken} api={api} />);
    const agents = await screen.findByRole('region', { name: 'Agent' });
    expect(agents).toHaveTextContent('Trợ lý đào tạo');
    expect(agents).toHaveTextContent('Khoa Kinh tế quốc tế');

    fireEvent.click(screen.getByText('+ Thêm agent'));
    fireEvent.change(screen.getByLabelText('Tên agent'), { target: { value: 'Trợ lý mới' } });
    fireEvent.change(screen.getByLabelText('Chỉ dẫn'), { target: { value: 'Giúp cán bộ.' } });
    fireEvent.click(screen.getByLabelText('LMS thử nghiệm › Thông tin học phần'));
    fireEvent.click(screen.getByLabelText('Ngày giờ hiện tại'));
    fireEvent.change(screen.getByLabelText('Mã kho tri thức'), { target: { value: 'kb1, kb2' } });
    fireEvent.click(screen.getByText('Lưu agent'));
    expect(await screen.findByText('Đã lưu agent Trợ lý mới.')).toBeInTheDocument();
    expect(vi.mocked(api.saveAgent).mock.calls[0]!.slice(1)).toEqual([
      null,
      expect.objectContaining({
        name: 'Trợ lý mới',
        tools: ['lms.get_course', 'current_datetime'],
        knowledgeBaseIds: ['kb1', 'kb2'],
      }),
    ]);
  });

  it('edits integrations, stores tokens write-only and tests operations', async () => {
    const api = fakeApi();
    render(<AgentsPage canEdit getToken={getToken} api={api} />);
    const section = await screen.findByRole('region', { name: 'Tích hợp' });
    expect(section).toHaveTextContent('…abcd');

    fireEvent.click(within(section).getByText('Sửa cấu hình'));
    const json = screen.getByLabelText('Cấu hình JSON') as HTMLTextAreaElement;
    expect(json.value).not.toContain('tokenLast4');
    fireEvent.change(json, { target: { value: json.value.replace('"GET"', '"POST"') } });
    fireEvent.click(screen.getByText('Lưu tích hợp'));
    expect(await screen.findByRole('alert')).toHaveTextContent('operations.0.method');
    expect(api.saveIntegration).not.toHaveBeenCalled();
    fireEvent.change(json, { target: { value: json.value.replace('"POST"', '"GET"') } });
    fireEvent.click(screen.getByText('Lưu tích hợp'));
    expect(await screen.findByText('Đã lưu tích hợp lms.')).toBeInTheDocument();

    const tokenInput = screen.getByLabelText('Token mới của lms') as HTMLInputElement;
    expect(tokenInput.type).toBe('password');
    fireEvent.change(tokenInput, { target: { value: 'fake-token-value' } });
    fireEvent.click(screen.getByText('Lưu token'));
    expect(await screen.findByText('Đã lưu token của lms.')).toBeInTheDocument();
    expect(api.setIntegrationToken).toHaveBeenCalledWith('t', 'lms', 'fake-token-value');
    expect(tokenInput.value).toBe('');

    fireEvent.change(screen.getByLabelText('Thao tác cần thử'), {
      target: { value: 'lms.get_course' },
    });
    fireEvent.change(screen.getByLabelText('Tham số thử (JSON)'), {
      target: { value: '{"courseId":"KT101"}' },
    });
    fireEvent.click(screen.getByText('Thử'));
    const result = await screen.findByLabelText('Kết quả thử');
    expect(result).toHaveTextContent('HTTP 200');
    expect(result).toHaveTextContent('[EMAIL_1]');
    expect(api.testIntegrationOperation).toHaveBeenCalledWith('t', 'lms', 'get_course', {
      courseId: 'KT101',
    });
  });

  it('is read-only for auditors', async () => {
    render(<AgentsPage canEdit={false} getToken={getToken} api={fakeApi()} />);
    await screen.findByText('Trợ lý đào tạo');
    expect(screen.queryByText('+ Thêm agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Sửa cấu hình')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token mới của lms')).not.toBeInTheDocument();
  });
});
