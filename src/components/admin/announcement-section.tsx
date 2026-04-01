'use client';

import { useState, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Megaphone } from 'lucide-react';

export function AnnouncementSection() {
  const utils = trpc.useUtils();
  const announcement = trpc.admin.getAnnouncement.useQuery();
  const setAnnouncement = trpc.admin.setAnnouncement.useMutation({
    onSuccess: () => {
      utils.admin.getAnnouncement.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [draft, setDraft] = useState('');
  const lastSyncedRef = useRef<string | null>(null);

  // Sync draft from server data without useEffect
  const serverMessage = announcement.data?.message ?? '';
  if (serverMessage !== lastSyncedRef.current) {
    lastSyncedRef.current = serverMessage;
    if (serverMessage && draft !== serverMessage) {
      setDraft(serverMessage);
    }
  }

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Announcement Banner</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {announcement.data?.message
              ? 'Currently showing'
              : 'No active announcement'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            rows={3}
            placeholder="Enter an announcement message to show to all users..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {draft.length}/500 characters
            </span>
            <div className="flex gap-2">
              {announcement.data?.message && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setAnnouncement.isPending}
                  onClick={() => {
                    setAnnouncement.mutate({ message: '' });
                    setDraft('');
                  }}
                >
                  Clear
                </Button>
              )}
              <Button
                size="sm"
                disabled={
                  setAnnouncement.isPending ||
                  draft.trim() === (announcement.data?.message ?? '')
                }
                onClick={() =>
                  setAnnouncement.mutate({ message: draft.trim() })
                }
              >
                {setAnnouncement.isPending && (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                )}
                Save
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
