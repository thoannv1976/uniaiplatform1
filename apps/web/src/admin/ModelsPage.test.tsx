import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelView, Price } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ModelsPage, parseUsd, perMTok, type ModelsApi } from './ModelsPage';

const price = (over: Partial<Price> = {}): Price => ({
  id: 'p1',
  inputPerMTok: 1_000_000,
  outputPerMTok: 5_000_000,
  cachedInputPerMTok: 100_000,
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'seed',
  ...over,
});
const MODEL: ModelView = {
  id: 'claude-haiku-4-5',
  providerId: 'anthropic',
  apiModelId: 'claude-haiku-4-5@20251001',
  displayName: 'Claude Haiku 4.5',
  tier: 'standard',
  status: 'disabled',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: ['text'],
  priority: 100,
  rateLimitPerMinute: null,
  defaultParams: {},
  notes: 'Cần xác minh giá',
  updatedAt: null,
  updatedBy: null,
  currentPrice: price(),
  nextPrice: null,
};

function fakeApi() {
  const calls: unknown[] = [];
  const api: ModelsApi = {
    fetchModels: vi.fn(() => Promise.resolve([MODEL])),
    createModel: vi.fn((_t, input) => (calls.push(['create', input]), Promise.resolve(MODEL))),
    updateModel: vi.fn(
      (_t, id, patch) => (calls.push(['update', id, patch]), Promise.resolve(MODEL)),
    ),
    seedModels: vi.fn(() => Promise.resolve(['gpt-6-luna'])),
    fetchPrices: vi.fn(() => Promise.resolve([price()])),
    addPrice: vi.fn((_t, id, p) => (calls.push(['price', id, p]), Promise.resolve(price()))),
    testModel: vi.fn(() =>
      Promise.resolve({
        ok: true,
        modelId: MODEL.id,
        apiModelId: MODEL.apiModelId,
        transport: 'vertex' as const,
        text: 'Xin chào thầy cô!',
        stopReason: 'end',
        usage: { inputTokens: 12, outputTokens: 6, cachedInputTokens: 0 },
        cost: 42,
        latencyMs: 800,
        error: null,
      }),
    ),
  };
  return { api, calls };
}
const getToken = () => Promise.resolve('tok');

describe('money input and display', () => {
  it('parses USD with a dot or a comma into micro-USD and shows exact prices', () => {
    expect(parseUsd('0.25')).toBe(250_000);
    expect(parseUsd('0,075')).toBe(75_000);
    expect(parseUsd('-1')).toBeNull();
    expect(parseUsd('abc')).toBeNull();
    expect(parseUsd('')).toBeNull();
    expect(perMTok(75_000)).toBe('$0.075');
    expect(perMTok(null)).toBe('–');
  });
});

describe('ModelsPage', () => {
  it('lists models with prices and enables one', async () => {
    const { api, calls } = fakeApi();
    render(<ModelsPage canEdit getToken={getToken} api={api} />);
    expect(await screen.findByText('Claude Haiku 4.5')).toBeInTheDocument();
    expect(screen.getByText('$1 / $5 / $0.1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bật claude-haiku-4-5' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([['update', 'claude-haiku-4-5', { status: 'active' }]]),
    );
  });

  it('adds a scheduled price in micro-USD', async () => {
    const { api, calls } = fakeApi();
    render(<ModelsPage canEdit getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Giá claude-haiku-4-5' }));
    const form = (await screen.findByRole('button', { name: 'Thêm giá' })).closest('form')!;
    fireEvent.change(within(form).getByLabelText('Giá vào ($/1M)'), { target: { value: '0,8' } });
    fireEvent.change(within(form).getByLabelText('Giá ra ($/1M)'), { target: { value: '4' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Thêm giá' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        [
          'price',
          'claude-haiku-4-5',
          { inputPerMTok: 800_000, outputPerMTok: 4_000_000, cachedInputPerMTok: null },
        ],
      ]),
    );
  });

  it('runs a test call and shows tokens and cost', async () => {
    const { api } = fakeApi();
    render(<ModelsPage canEdit getToken={getToken} api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thử claude-haiku-4-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gửi thử' }));
    expect(await screen.findByText('Xin chào thầy cô!')).toBeInTheDocument();
    expect(screen.getByText(/42 micro-USD/)).toBeInTheDocument();
  });

  it('is read-only without edit rights but still shows the price history', async () => {
    const { api } = fakeApi();
    render(<ModelsPage canEdit={false} getToken={getToken} api={api} />);
    expect(await screen.findByText('Claude Haiku 4.5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bật/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nạp danh mục mẫu' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Giá claude-haiku-4-5' }));
    expect(await screen.findByText('seed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm giá' })).not.toBeInTheDocument();
  });
});
