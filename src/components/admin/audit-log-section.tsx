'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ScrollText } from 'lucide-react';

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  USER_DELETED: { label: 'User Deleted', color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  USER_SUSPENDED: { label: 'User Suspended', color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
  USER_UNSUSPENDED: { label: 'User Unsuspended', color: 'bg-green-500/10 text-green-700 dark:text-green-400' },
  GROUP_DELETED: { label: 'Group Deleted', color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  ORPHANS_CLEANED: { label: 'Orphans Cleaned', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  IMPERSONATION_STARTED: { label: 'Impersonation', color: 'bg-purple-500/10 text-purple-700 dark:text-purple-400' },
  INVITE_CREATED: { label: 'Invite Created', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  INVITE_REVOKED: { label: 'Invite Revoked', color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
  ANNOUNCEMENT_SET: { label: 'Announcement', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  REGISTRATION_MODE_CHANGED: { label: 'Reg. Mode Changed', color: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  EXPORT_CREATED: { label: 'Data Export', color: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
  TEST_EMAIL_SENT: { label: 'Test Email', color: 'bg-teal-500/10 text-teal-700 dark:text-teal-400' },
  EXPIRED_SPLITS_CLEANED: { label: 'Splits Cleaned', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  MERIDIAN_LOGIN_STARTED: { label: 'Meridian Login', color: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400' },
  MERIDIAN_LOGIN_COMPLETED: { label: 'Meridian Logged In', color: 'bg-green-500/10 text-green-700 dark:text-green-400' },
  MERIDIAN_LOGIN_FAILED: { label: 'Meridian Login Failed', color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  MERIDIAN_LOGOUT: { label: 'Meridian Logout', color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
  MERIDIAN_NOTIFY_PREFERENCE_CHANGED: { label: 'Notify Pref Changed', color: 'bg-violet-500/10 text-violet-700 dark:text-violet-400' },
  AI_PROVIDER_TESTED: { label: 'AI Provider Test', color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
};

export function AuditLogSection() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const auditLog = trpc.admin.getAuditLog.useQuery({ limit: 20, cursor });

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Audit Log</h2>
      </div>

      <Card>
        <CardContent className="p-0">
          {auditLog.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : auditLog.data?.items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No audit log entries yet.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Action</th>
                      <th className="px-4 py-3 font-medium">Admin</th>
                      <th className="px-4 py-3 font-medium">Details</th>
                      <th className="px-4 py-3 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLog.data?.items.map((entry) => {
                      const actionInfo = ACTION_LABELS[entry.action] ?? {
                        label: entry.action,
                        color: 'bg-gray-500/10 text-gray-700',
                      };
                      return (
                        <tr key={entry.id} className="border-b last:border-0">
                          <td className="px-4 py-3">
                            <Badge
                              variant="secondary"
                              className={actionInfo.color}
                            >
                              {actionInfo.label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {entry.adminName}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {formatMetadata(entry.metadata)}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {auditLog.data?.nextCursor && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCursor(auditLog.data?.nextCursor)}
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

function formatMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '---';
  const parts: string[] = [];
  if (metadata.email) parts.push(`${metadata.email}`);
  if (metadata.name) parts.push(`"${metadata.name}"`);
  if (metadata.mode) parts.push(`mode: ${metadata.mode}`);
  if (metadata.code) parts.push(`code: ${metadata.code}`);
  if (metadata.targetEmail) parts.push(`${metadata.targetEmail}`);
  if (metadata.message !== undefined) {
    parts.push(
      metadata.message ? `"${String(metadata.message).slice(0, 50)}"` : '(cleared)'
    );
  }
  if (metadata.deletedCount !== undefined) {
    parts.push(`${metadata.deletedCount} files`);
  }
  if (metadata.to) parts.push(`to: ${metadata.to}`);
  if (metadata.provider) parts.push(`${metadata.provider}`);
  if (metadata.durationMs !== undefined) parts.push(`${metadata.durationMs}ms`);
  if (metadata.success === false && metadata.error) parts.push(`error: ${metadata.error}`);
  return parts.join(', ') || '---';
}
