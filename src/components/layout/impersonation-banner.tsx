'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { trpc } from '@/lib/trpc';
import { UserCheck } from 'lucide-react';

export function ImpersonationBanner() {
  const router = useRouter();
  const { data } = trpc.admin.getImpersonationStatus.useQuery(undefined, {
    staleTime: 30_000,
  });
  const [stopping, setStopping] = useState(false);

  if (!data?.isImpersonating) return null;

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch('/api/admin/impersonate', { method: 'DELETE' });
      router.refresh();
      window.location.href = '/admin';
    } catch {
      setStopping(false);
    }
  };

  return (
    <div className="bg-red-500/15 border-b border-red-500/30 px-4 py-2.5 text-sm text-red-800 dark:text-red-200">
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <UserCheck className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          Impersonating{' '}
          <strong>{data.targetName ?? data.targetEmail}</strong>
          {data.targetName && (
            <span className="text-red-600 dark:text-red-300">
              {' '}
              ({data.targetEmail})
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={handleStop}
          disabled={stopping}
          className="shrink-0 rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {stopping ? 'Stopping...' : 'Stop Impersonating'}
        </button>
      </div>
    </div>
  );
}
