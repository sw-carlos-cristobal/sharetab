'use client';

import { useState, useSyncExternalStore } from 'react';
import { trpc } from '@/lib/trpc';
import { X, Megaphone } from 'lucide-react';

const DISMISS_KEY = 'sharetab-announcement-dismissed';

function getDismissedMessage(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(DISMISS_KEY);
}

function subscribeDismiss(callback: () => void) {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

export function AnnouncementBanner() {
  const { data } = trpc.admin.getAnnouncement.useQuery(undefined, {
    staleTime: 60_000, // refetch at most every minute
  });
  const dismissedMessage = useSyncExternalStore(
    subscribeDismiss,
    getDismissedMessage,
    () => null
  );
  const [localDismissed, setLocalDismissed] = useState(false);

  const dismissed =
    localDismissed || (!!data?.message && dismissedMessage === data.message);

  if (!data?.message || dismissed) return null;

  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <Megaphone className="h-4 w-4 shrink-0" />
        <span className="flex-1">{data.message}</span>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, data.message!);
            setLocalDismissed(true);
          }}
          className="shrink-0 rounded p-0.5 hover:bg-amber-500/20 transition-colors"
          aria-label="Dismiss announcement"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
