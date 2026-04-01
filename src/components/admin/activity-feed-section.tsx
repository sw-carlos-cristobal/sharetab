'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity } from 'lucide-react';

const TYPE_LABELS: Record<string, string> = {
  EXPENSE_CREATED: 'Expense Created',
  EXPENSE_UPDATED: 'Expense Updated',
  EXPENSE_DELETED: 'Expense Deleted',
  SETTLEMENT_CREATED: 'Settlement',
  MEMBER_JOINED: 'Member Joined',
  MEMBER_LEFT: 'Member Left',
  GROUP_UPDATED: 'Group Updated',
  PLACEHOLDER_CREATED: 'Placeholder Added',
  PLACEHOLDER_MERGED: 'Placeholder Merged',
  GROUP_ARCHIVED: 'Group Archived',
  GROUP_UNARCHIVED: 'Group Unarchived',
};

export function ActivityFeedSection() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const activity = trpc.admin.getGlobalActivity.useQuery({
    limit: 20,
    cursor,
  });

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Activity className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Global Activity Feed</h2>
      </div>

      <Card>
        <CardContent className="p-0">
          {activity.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : activity.data?.items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No activity yet.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Type</th>
                      <th className="px-4 py-3 font-medium">User</th>
                      <th className="px-4 py-3 font-medium">Group</th>
                      <th className="px-4 py-3 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data?.items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <Badge variant="outline">
                            {TYPE_LABELS[item.type] ?? item.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {item.userName}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {item.groupName}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(item.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {activity.data?.nextCursor && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCursor(activity.data?.nextCursor)}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
