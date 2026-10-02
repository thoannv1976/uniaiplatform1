import type { AppNotification } from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchNotifications, markNotificationsRead } from '../lib/api';

export interface NotificationApi {
  fetchNotifications: typeof fetchNotifications;
  markNotificationsRead: typeof markNotificationsRead;
}
const defaultApi: NotificationApi = { fetchNotifications, markNotificationsRead };
const POLL_MS = 5 * 60_000;

/** In-app alerts (spec 8.13): quota 80 %, unit/university budget, forecast. */
export function NotificationBell({
  getToken,
  api = defaultApi,
}: {
  getToken: () => Promise<string>;
  api?: NotificationApi;
}) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      void getToken()
        .then((t) => api.fetchNotifications(t))
        .then((r) => {
          if (!active) return;
          setItems(r.notifications);
          setUnread(r.unread);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, getToken]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      void getToken()
        .then((t) => api.markNotificationsRead(t))
        .catch(() => undefined);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="text-sky-800 underline"
        aria-expanded={open}
        onClick={toggle}
      >
        Thông báo{unread > 0 ? ` (${unread})` : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-80 max-w-[90vw] rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          {items.length === 0 ? (
            <p className="p-2 text-sm text-slate-500">Chưa có thông báo.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="rounded p-2 text-sm hover:bg-slate-50">
                  <p className={n.read ? 'text-slate-700' : 'font-semibold text-slate-900'}>
                    {n.title}
                  </p>
                  <p className="text-slate-600">{n.message}</p>
                  <p className="text-xs text-slate-400">
                    {new Date(n.createdAt).toLocaleString('vi-VN')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
