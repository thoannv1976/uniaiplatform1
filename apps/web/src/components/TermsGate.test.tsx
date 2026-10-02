import { fireEvent, render, screen } from '@testing-library/react';
import { TERMS_VERSION } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { TermsGate } from './TermsGate';

describe('TermsGate', () => {
  it('needs the box ticked, then accepts the current version', async () => {
    const accept = vi.fn(() => Promise.resolve());
    const onAccepted = vi.fn();
    render(
      <TermsGate
        getToken={() => Promise.resolve('t')}
        onAccepted={onAccepted}
        onDecline={vi.fn()}
        accept={accept}
      />,
    );
    const go = screen.getByRole('button', { name: 'Đồng ý và tiếp tục' });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Tôi đã đọc và đồng ý với Điều khoản sử dụng.'));
    fireEvent.click(go);
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith('t', TERMS_VERSION);
  });

  it('signs out when declined and shows errors', async () => {
    const onDecline = vi.fn();
    render(
      <TermsGate
        getToken={() => Promise.resolve('t')}
        onAccepted={vi.fn()}
        onDecline={onDecline}
        accept={() => Promise.reject(new Error('Điều khoản đã được cập nhật.'))}
      />,
    );
    fireEvent.click(screen.getByLabelText('Tôi đã đọc và đồng ý với Điều khoản sử dụng.'));
    fireEvent.click(screen.getByRole('button', { name: 'Đồng ý và tiếp tục' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('đã được cập nhật');
    fireEvent.click(screen.getByText('Không đồng ý (đăng xuất)'));
    expect(onDecline).toHaveBeenCalled();
  });
});
