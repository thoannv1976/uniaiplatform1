import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_KILL_SWITCH, type KillSwitch } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { KillSwitchPage, type KillSwitchApi } from './KillSwitchPage';

function fakeApi(initial: KillSwitch = DEFAULT_KILL_SWITCH) {
  const api: KillSwitchApi = {
    fetchKillSwitch: vi.fn(() => Promise.resolve(initial)),
    updateKillSwitch: vi.fn((_t, v) =>
      Promise.resolve({ ...DEFAULT_KILL_SWITCH, ...v, updatedBy: 'sa', updatedAt: null }),
    ),
    fetchModels: vi.fn(() => Promise.resolve([])),
  };
  return api;
}
const getToken = () => Promise.resolve('t');

describe('KillSwitchPage', () => {
  it('switches a provider off with a reason and turns everything back on', async () => {
    const api = fakeApi();
    render(<KillSwitchPage canEdit getToken={getToken} api={api} />);
    expect(await screen.findByRole('status')).toHaveTextContent('hoạt động bình thường');
    fireEvent.click(screen.getByLabelText('OpenAI'));
    fireEvent.change(screen.getByLabelText(/Lý do/), { target: { value: 'Sự cố OpenAI' } });
    fireEvent.click(screen.getByText('Lưu kill switch'));
    expect(await screen.findByText(/áp dụng trong vòng 5 giây/)).toBeInTheDocument();
    expect(api.updateKillSwitch).toHaveBeenCalledWith('t', {
      all: false,
      providers: ['openai'],
      models: [],
      tiers: [],
      reason: 'Sự cố OpenAI',
      autoBrakePercent: 100,
    });
    expect(screen.getByRole('status')).toHaveTextContent('tạm dừng một phần');
    fireEvent.click(screen.getByText('Bật lại toàn bộ AI'));
    await vi.waitFor(() =>
      expect(api.updateKillSwitch).toHaveBeenLastCalledWith(
        't',
        expect.objectContaining({ providers: [], reason: '' }),
      ),
    );
  });

  it('is read-only for auditors and shows the emergency brake', async () => {
    const api = fakeApi({
      ...DEFAULT_KILL_SWITCH,
      tiers: ['advanced', 'premium'],
      auto: true,
      reason: 'Phanh khẩn cấp',
    });
    render(<KillSwitchPage canEdit={false} getToken={getToken} api={api} />);
    expect(await screen.findByRole('status')).toHaveTextContent('phanh khẩn cấp tự bật');
    expect(screen.queryByText('Lưu kill switch')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tạm dừng TOÀN BỘ AI')).toBeDisabled();
  });
});
