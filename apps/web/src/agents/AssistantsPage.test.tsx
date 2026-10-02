import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentStreamEvent } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { AssistantsPage, type AssistantsApi } from './AssistantsPage';

const AGENTS = [
  { id: 'a1', name: 'Trợ lý đào tạo', description: 'Tra cứu học phần', tools: ['lms.get_course'] },
  { id: 'a2', name: 'Trợ lý chung', description: '', tools: [] },
];
const getToken = () => Promise.resolve('t');

function fakeApi(stream: AssistantsApi['streamAgent']) {
  const api: AssistantsApi = {
    fetchMyAgents: vi.fn(() => Promise.resolve(AGENTS)),
    streamAgent: vi.fn(stream),
  };
  return api;
}

describe('AssistantsPage', () => {
  it('shows tool steps, the answer and the cost', async () => {
    const api = fakeApi((_t, _id, _req, onEvent) => {
      const events: AgentStreamEvent[] = [
        {
          type: 'meta',
          agent: { id: 'a1', name: 'Trợ lý đào tạo' },
          model: { id: 'gpt', displayName: 'GPT', providerId: 'openai', tier: 'standard' },
          routeReason: 'Agent',
        },
        {
          type: 'tool',
          step: 1,
          tool: 'lms.get_course',
          arguments: { courseId: 'KT101' },
          status: 'ok',
          message: 'Đã nhận 120 byte',
        },
        { type: 'delta', text: 'Học phần **KT101** có 3 tín chỉ.' },
        { type: 'done', steps: 2, cost: 1_500, stopReason: 'answer', latencyMs: 2300 },
      ];
      events.forEach(onEvent);
      return Promise.resolve();
    });
    render(<AssistantsPage getToken={getToken} api={api} />);
    expect(await screen.findByRole('heading', { name: 'Trợ lý đào tạo' })).toBeInTheDocument();
    expect(screen.getByText(/Công cụ: lms › get_course/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Câu hỏi cho trợ lý'), {
      target: { value: 'KT101 bao nhiêu tín chỉ?' },
    });
    fireEvent.click(screen.getByText('Gửi'));
    expect(await screen.findByText(/có 3 tín chỉ/)).toBeInTheDocument();
    expect(screen.getByLabelText('Các bước dùng công cụ')).toHaveTextContent(
      'lms › get_course (courseId: KT101) – Đã nhận 120 byte',
    );
    expect(screen.getByText(/2 bước · chi phí/)).toHaveTextContent('2.3 giây');
    expect(vi.mocked(api.streamAgent).mock.calls[0]![2]).toEqual({
      messages: [{ role: 'user', content: 'KT101 bao nhiêu tín chỉ?' }],
    });
  });

  it('asks before resending a DLP warning with dlpAcknowledged', async () => {
    let calls = 0;
    const api = fakeApi((_t, _id, _req, onEvent) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new ApiError(428, 'Tin nhắn có số CCCD.'));
      onEvent({ type: 'delta', text: 'Đã xử lý.' });
      return Promise.resolve();
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AssistantsPage getToken={getToken} api={api} />);
    await screen.findByRole('heading', { name: 'Trợ lý đào tạo' });
    fireEvent.change(screen.getByLabelText('Câu hỏi cho trợ lý'), { target: { value: 'Tra cứu' } });
    fireEvent.click(screen.getByText('Gửi'));
    expect(await screen.findByText('Đã xử lý.')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('Tin nhắn có số CCCD.');
    expect(vi.mocked(api.streamAgent).mock.calls[1]![2]).toMatchObject({ dlpAcknowledged: true });
    confirm.mockRestore();
  });

  it('says when no assistant is available', async () => {
    const api: AssistantsApi = {
      fetchMyAgents: vi.fn(() => Promise.resolve([])),
      streamAgent: vi.fn(),
    };
    render(<AssistantsPage getToken={getToken} api={api} />);
    expect(
      await screen.findByText('Chưa có trợ lý AI nào dành cho đơn vị của bạn.'),
    ).toBeInTheDocument();
  });
});
