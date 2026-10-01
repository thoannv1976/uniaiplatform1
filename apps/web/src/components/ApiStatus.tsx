import { useEffect, useState } from 'react';
import type { HealthResponse } from '@uniai/shared';
import { fetchHealth } from '../lib/api';

type State =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

export function ApiStatus({ load = fetchHealth }: { load?: typeof fetchHealth }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((health) => setState({ kind: 'ok', health }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [load]);

  if (state.kind === 'loading') {
    return <p role="status">Đang kiểm tra kết nối máy chủ…</p>;
  }
  if (state.kind === 'error') {
    return (
      <p role="status" className="text-red-700">
        Không kết nối được máy chủ: {state.message}
      </p>
    );
  }
  return (
    <p role="status" className="text-green-700">
      Máy chủ hoạt động bình thường ({state.health.service}, phiên bản {state.health.version})
    </p>
  );
}
