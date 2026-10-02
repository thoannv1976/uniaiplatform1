import { fireEvent, render, screen } from '@testing-library/react';
import type { ProviderView } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProvidersPage, type ProvidersApi } from './ProvidersPage';

const provider = (over: Partial<ProviderView>): ProviderView => ({
  id: 'openai',
  name: 'OpenAI',
  transport: 'direct',
  enabled: true,
  fallbackOrder: 1,
  key: { configured: false, last4: null, updatedAt: null, updatedBy: null },
  transports: ['direct'],
  keyRequired: true,
  ready: false,
  ...over,
});
const LIST = [
  provider({}),
  provider({
    id: 'anthropic',
    name: 'Anthropic Claude',
    transport: 'vertex',
    transports: ['vertex', 'direct'],
    keyRequired: false,
    ready: true,
    fallbackOrder: 3,
    key: {
      configured: true,
      last4: 'wxyz',
      updatedAt: '2026-10-01T03:00:00.000Z',
      updatedBy: 'sa',
    },
  }),
  provider({ id: 'mock', name: 'Mock', transports: ['direct'], keyRequired: false, ready: true }),
];

function fakeApi() {
  const calls: unknown[] = [];
  const api: ProvidersApi = {
    fetchProviders: vi.fn(() => Promise.resolve(LIST)),
    updateProvider: vi.fn(
      (_t, id, patch) => (calls.push(['update', id, patch]), Promise.resolve(LIST[0]!)),
    ),
    setProviderKey: vi.fn(
      (_t, id, key) => (calls.push(['key', id, key]), Promise.resolve(LIST[0]!)),
    ),
  };
  return { api, calls };
}
const getToken = () => Promise.resolve('tok');

describe('ProvidersPage', () => {
  it('shows status and masked keys, never a key value', async () => {
    const { api } = fakeApi();
    render(<ProvidersPage canEdit canSetKey getToken={getToken} api={api} />);
    expect(await screen.findByText('Thiếu API key')).toBeInTheDocument();
    expect(screen.getByText('…wxyz')).toBeInTheDocument();
    expect(screen.queryByLabelText('API key mới cho Mock')).not.toBeInTheDocument();
  });

  it('saves a key write-only and clears the field', async () => {
    const { api, calls } = fakeApi();
    render(<ProvidersPage canEdit canSetKey getToken={getToken} api={api} />);
    const input = await screen.findByLabelText('API key mới cho OpenAI');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: '  sk-test-0123456789abcdefgh ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Lưu key' })[0]!);
    await vi.waitFor(() =>
      expect(calls).toEqual([['key', 'openai', 'sk-test-0123456789abcdefgh']]),
    );
    await vi.waitFor(() => expect(input).toHaveValue(''));
    expect(await screen.findByRole('status')).toHaveTextContent('Đã lưu API key mới cho OpenAI');
  });

  it('switches transport and toggles providers', async () => {
    const { api, calls } = fakeApi();
    render(<ProvidersPage canEdit canSetKey={false} getToken={getToken} api={api} />);
    fireEvent.change(await screen.findByLabelText('Cách gọi Anthropic Claude'), {
      target: { value: 'direct' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tắt OpenAI' }));
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ['update', 'anthropic', { transport: 'direct' }],
        ['update', 'openai', { enabled: false }],
      ]),
    );
    expect(screen.queryByRole('button', { name: 'Lưu key' })).not.toBeInTheDocument();
  });

  it('is read-only for auditors', async () => {
    const { api } = fakeApi();
    render(<ProvidersPage canEdit={false} canSetKey={false} getToken={getToken} api={api} />);
    expect(await screen.findByLabelText('Cách gọi Anthropic Claude')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Tắt/ })).not.toBeInTheDocument();
  });
});
