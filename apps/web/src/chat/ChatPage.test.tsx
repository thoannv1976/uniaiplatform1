import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatStreamEvent, Conversation, ConversationDetail } from '@uniai/shared';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ChatPage, sortAndFilter, type ChatApi } from './ChatPage';

const conv = (id: string, title: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title,
  pinned: false,
  lastModelId: 'mock-economy',
  messageCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  expireAt: null,
  ...over,
});

const DETAIL: ConversationDetail = {
  conversation: conv('c9', 'Đề cương'),
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'Viết đề cương',
      status: 'complete',
      modelId: null,
      providerId: null,
      usage: null,
      cost: null,
      stopReason: null,
      error: null,
      latencyMs: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '## Đề cương\n\n| Tuần | Nội dung |\n|---|---|\n| 1 | Mở đầu |',
      status: 'complete',
      modelId: 'mock-economy',
      providerId: 'mock',
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
      cost: 1500,
      stopReason: 'end',
      error: null,
      latencyMs: 900,
      createdAt: '2026-10-01T00:00:01.000Z',
    },
  ],
};

function Location() {
  return <p data-testid="path">{useLocation().pathname}</p>;
}

function setup(
  stream: ChatApi['streamChat'],
  list = [conv('c9', 'Đề cương'), conv('c8', 'Dịch thư', { pinned: true })],
) {
  const calls: unknown[] = [];
  const api: ChatApi = {
    fetchConversations: vi.fn(() => Promise.resolve(list)),
    fetchConversation: vi.fn(() => Promise.resolve(DETAIL)),
    updateConversation: vi.fn(
      (_t, id, patch) => (calls.push(['update', id, patch]), Promise.resolve(list[0]!)),
    ),
    deleteConversation: vi.fn((_t, id) => (calls.push(['delete', id]), Promise.resolve())),
    fetchChatModels: vi.fn(() =>
      Promise.resolve([
        {
          id: 'mock-economy',
          displayName: 'Mock Economy',
          providerId: 'mock' as const,
          tier: 'economy' as const,
          capabilities: ['text'],
        },
      ]),
    ),
    streamChat: vi.fn(stream),
    fetchMyQuota: vi.fn(() =>
      Promise.resolve({
        uid: 'gv',
        period: '202610',
        tierId: 'standard' as const,
        limit: 2_000_000,
        premiumLimit: 500_000,
        used: 1_700_000,
        premiumUsed: 0,
        reserved: 0,
        premiumReserved: 0,
        departmentId: null,
        departmentPath: [],
        email: 'gv@ftu.edu.vn',
        name: 'GV',
        remaining: 300_000,
        premiumRemaining: 500_000,
        percentUsed: 85,
      }),
    ),
  };
  const ui = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/"
            element={<ChatPage getToken={() => Promise.resolve('tok')} api={api} />}
          />
          <Route
            path="/hoi-thoai/:conversationId"
            element={<ChatPage getToken={() => Promise.resolve('tok')} api={api} />}
          />
        </Routes>
        <Location />
      </MemoryRouter>,
    );
  return { api, calls, ui };
}

const META: ChatStreamEvent = {
  type: 'meta',
  conversationId: 'c1',
  userMessageId: 'u1',
  messageId: 'm1',
  model: { id: 'mock-economy', displayName: 'Mock Economy', providerId: 'mock', tier: 'economy' },
  routeReason: 'AUTO',
};

describe('sortAndFilter', () => {
  it('puts pinned first, newest next, and searches without diacritics', () => {
    const list = [
      conv('a', 'Tóm tắt quy chế', { updatedAt: '2026-10-02T00:00:00.000Z' }),
      conv('b', 'Đề cương môn học'),
      conv('c', 'Ghim', { pinned: true }),
    ];
    expect(sortAndFilter(list, '').map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(sortAndFilter(list, 'de cuong').map((c) => c.id)).toEqual(['b']);
    expect(sortAndFilter(list, 'QUY CHE').map((c) => c.id)).toEqual(['a']);
  });
});

describe('ChatPage', () => {
  it('starts a conversation, streams Markdown, shows cost and moves to the new address', async () => {
    const { ui } = setup((_t, req, onEvent) => {
      expect(req).toEqual({ message: 'Xin chào', model: 'auto' });
      onEvent(META);
      onEvent({ type: 'delta', text: '**Chào** thầy ' });
      onEvent({ type: 'delta', text: 'cô!' });
      onEvent({
        type: 'done',
        messageId: 'm1',
        status: 'complete',
        stopReason: 'end',
        usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 0 },
        cost: 2500,
        latencyMs: 800,
      });
      return Promise.resolve();
    });
    ui('/');
    expect(await screen.findByText('Bạn cần hỗ trợ gì hôm nay?')).toBeInTheDocument();
    expect(await screen.findByText('Định mức tháng: còn $0.30 / $2.00')).toHaveClass(
      'text-amber-700',
    );
    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'Xin chào' } });
    fireEvent.keyDown(screen.getByLabelText('Tin nhắn'), { key: 'Enter' });
    expect(await screen.findByText('Chào', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Chi phí $0.0025')).toBeInTheDocument();
    expect(screen.getByText('Mock Economy')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/hoi-thoai/c1');
  });

  it('loads a stored conversation with tables and continues it', async () => {
    const { api, ui } = setup((_t, req, onEvent) => {
      expect(req).toEqual({ message: 'Thêm tuần 2', model: 'auto', conversationId: 'c9' });
      onEvent({ ...META, conversationId: 'c9' });
      onEvent({
        type: 'done',
        messageId: 'm1',
        status: 'complete',
        stopReason: 'end',
        usage: null,
        cost: null,
        latencyMs: 1,
      });
      return Promise.resolve();
    });
    ui('/hoi-thoai/c9');
    expect(await screen.findByRole('cell', { name: 'Mở đầu' })).toBeInTheDocument();
    expect(screen.getByText('Chi phí $0.0015')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'Thêm tuần 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await vi.waitFor(() => expect(api.streamChat).toHaveBeenCalled());
    expect(api.fetchConversation).toHaveBeenCalledTimes(1);
  });

  it('renames, pins, searches and deletes conversations', async () => {
    const { calls, ui } = setup(() => Promise.resolve());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    ui('/hoi-thoai/c9');
    const sidebar = screen.getByRole('complementary', { name: 'Danh sách hội thoại' });
    const items = await within(sidebar).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Dịch thư');
    fireEvent.change(screen.getByLabelText('Tìm hội thoại'), { target: { value: 'de cuong' } });
    expect(within(sidebar).queryByText(/Dịch thư/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Đổi tên Đề cương'));
    fireEvent.change(screen.getByLabelText('Tên hội thoại'), {
      target: { value: 'Đề cương KTVM' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    fireEvent.click(await screen.findByLabelText('Ghim Đề cương'));
    fireEvent.click(screen.getByLabelText('Xóa Đề cương'));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['update', 'c9', { title: 'Đề cương KTVM' }],
        ['update', 'c9', { pinned: true }],
        ['delete', 'c9'],
      ]),
    );
    await vi.waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/));
  });

  it('gives the message back when the API refuses before streaming', async () => {
    const { ui } = setup(() => Promise.reject(new Error('Bạn đã dùng hết định mức tháng này.')));
    ui('/');
    fireEvent.change(await screen.findByLabelText('Tin nhắn'), { target: { value: 'Chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('hết định mức');
    expect(screen.getByLabelText('Tin nhắn')).toHaveValue('Chào');
  });

  it('stops a running answer and keeps the partial text', async () => {
    const { ui } = setup(
      (_t, _req, onEvent, signal) =>
        new Promise<void>((_resolve, reject) => {
          onEvent(META);
          onEvent({ type: 'delta', text: 'Một phần' });
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    ui('/');
    fireEvent.change(await screen.findByLabelText('Tin nhắn'), { target: { value: 'Dài' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dừng' }));
    expect(await screen.findByText('Đã dừng')).toBeInTheDocument();
    expect(screen.getByText('Một phần')).toBeInTheDocument();
  });
});
