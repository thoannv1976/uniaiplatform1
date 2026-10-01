import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiStatus } from './ApiStatus';

describe('ApiStatus', () => {
  it('shows the API service and version when healthy', async () => {
    render(
      <ApiStatus
        load={() =>
          Promise.resolve({ status: 'ok', service: 'uniai-api', version: 'v1', time: '' })
        }
      />,
    );
    expect(await screen.findByText(/Máy chủ hoạt động bình thường/)).toHaveTextContent(
      'uniai-api, phiên bản v1',
    );
  });

  it('shows an error in Vietnamese when the API is unreachable', async () => {
    render(<ApiStatus load={() => Promise.reject(new Error('API trả về mã 503'))} />);
    expect(await screen.findByText(/Không kết nối được máy chủ/)).toHaveTextContent('503');
  });
});
