import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatStreamEvent } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatTestPage, type ChatTestApi } from './ChatTestPage';

const META: ChatStreamEvent = {
  type: 'meta',
  conversationId: 'conv1',
  userMessageId: 'u1',
  messageId: 'm1',
  model: { id: 'mock-economy', displayName: 'Mock Economy', providerId: 'mock', tier: 'economy' },
  routeReason: 'AUTO: nhóm Tiết kiệm',
};
const getToken = () => Promise.resolve('tok');

function fakeApi(stream: ChatTestApi['streamChat']) {
  const api: ChatTestApi = {
    fetchChatModels: vi.fn(() =>
      Promise.resolve([
        {
          id: 'mock-advanced',
          displayName: 'Mock Advanced',
          providerId: 'mock' as const,
          tier: 'advanced' as const,
          capabilities: ['text'],
        },
      ]),
    ),
    streamChat: vi.fn(stream),
  };
  return api;
}

describe('ChatTestPage', () => {
  it('streams an answer, shows model, tokens and cost, then continues the conversation', async () => {
    const api = fakeApi((_t, _req, onEvent) => {
      onEvent(META);
      onEvent({ type: 'delta', text: 'Xin chào ' });
      onEvent({ type: 'delta', text: 'thầy cô!' });
      onEvent({
        type: 'done',
        messageId: 'm1',
        status: 'complete',
        stopReason: 'end',
        usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 0 },
        cost: 42,
        latencyMs: 1500,
      });
      return Promise.resolve();
    });
    render(<ChatTestPage getToken={getToken} api={api} />);
    expect(await screen.findByRole('option', { name: /Mock Advanced/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'Chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByText('Xin chào thầy cô!')).toBeInTheDocument();
    expect(screen.getByText(/42 micro-USD/)).toBeInTheDocument();
    expect(screen.getByText(/Mock Economy – AUTO: nhóm Tiết kiệm – xong/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'Tiếp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await vi.waitFor(() =>
      expect(api.streamChat).toHaveBeenLastCalledWith(
        'tok',
        { message: 'Tiếp', model: 'auto', conversationId: 'conv1' },
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
  });

  it('stops a running answer', async () => {
    const api = fakeApi(
      (_t, _req, onEvent, signal) =>
        new Promise<void>((_resolve, reject) => {
          onEvent(META);
          onEvent({ type: 'delta', text: '1… ' });
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    render(<ChatTestPage getToken={getToken} api={api} />);
    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: '[mock:slow=75]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dừng' }));
    expect(await screen.findByText(/chi phí phần đã sinh vẫn được ghi/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeInTheDocument();
  });

  it('shows API errors such as 503 without a stream', async () => {
    const api = fakeApi(() => Promise.reject(new Error('Chưa có model AI nào sẵn sàng.')));
    render(<ChatTestPage getToken={getToken} api={api} />);
    fireEvent.change(screen.getByLabelText('Tin nhắn'), { target: { value: 'Chào' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chưa có model AI nào sẵn sàng.');
  });
});
