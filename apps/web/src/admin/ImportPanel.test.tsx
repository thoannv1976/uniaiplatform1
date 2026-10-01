import { fireEvent, render, screen } from '@testing-library/react';
import type { ImportResult } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { ImportPanel } from './ImportPanel';

const result = (over: Partial<ImportResult> = {}): ImportResult => ({
  dryRun: true,
  applied: false,
  total: 2,
  created: 2,
  updated: 0,
  unchanged: 0,
  issues: [],
  ...over,
});

function choose(content: string) {
  const file = new File([content], 'can-bo.csv', { type: 'text/csv' });
  fireEvent.change(screen.getByLabelText('Tệp CSV'), { target: { files: [file] } });
}

describe('ImportPanel', () => {
  it('previews a file, then applies it', async () => {
    const submit = vi.fn((_csv: string, dryRun: boolean) =>
      Promise.resolve(result({ dryRun, applied: !dryRun })),
    );
    const onApplied = vi.fn();
    render(
      <ImportPanel
        title="Nhập cán bộ"
        templateHref="/t.csv"
        submit={submit}
        onApplied={onApplied}
      />,
    );
    choose('email\na@ftu.edu.vn');
    fireEvent.click(await screen.findByRole('button', { name: 'Áp dụng 2 thay đổi' }));
    expect(await screen.findByRole('status')).toHaveTextContent('thêm 2');
    expect(submit.mock.calls.map((c) => c[1])).toEqual([true, false]);
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('lists issues by line and offers no apply button', async () => {
    const submit = () =>
      Promise.resolve(
        result({ issues: [{ line: 3, column: 'ma_don_vi', message: 'Không có đơn vị X' }] }),
      );
    render(<ImportPanel title="Nhập" templateHref="/t.csv" submit={submit} onApplied={() => {}} />);
    choose('email\nx');
    expect(await screen.findByText('Không có đơn vị X')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('chưa ghi gì');
    expect(screen.queryByRole('button', { name: /Áp dụng/ })).not.toBeInTheDocument();
  });
});
