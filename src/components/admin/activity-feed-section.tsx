'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity } from 'lucide-react';

export function ActivityFeedSection() {
  const t = useTranslations("admin");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const activity = trpc.admin.getGlobalActivity.useQuery({
    limit: 20,
    cursor,
  });

  const TYPE_LABELS: Record<string, string> = {
    EXPENSE_CREATED: t("activity.typeExpenseCreated"),
    EXPENSE_UPDATED: t("activity.typeExpenseUpdated"),
    EXPENSE_DELETED: t("activity.typeExpenseDeleted"),
    SETTLEMENT_CREATED: t("activity.typeSettlementCreated"),
    MEMBER_JOINED: t("activity.typeMemberJoined"),
    MEMBER_LEFT: t("activity.typeMemberLeft"),
    GROUP_UPDATED: t("activity.typeGroupUpdated"),
    PLACEHOLDER_CREATED: t("activity.typePlaceholderCreated"),
    PLACEHOLDER_MERGED: t("activity.typePlaceholderMerged"),
    GROUP_ARCHIVED: t("activity.typeGroupArchived"),
    GROUP_UNARCHIVED: t("activity.typeGroupUnarchived"),
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Activity className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("activity.title")}</h2>
      </div>

      <Card>
        <CardContent className="p-0">
          {activity.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : activity.data?.items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t("activity.noActivity")}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">{t("activity.colType")}</th>
                      <th className="px-4 py-3 font-medium">{t("activity.colUser")}</th>
                      <th className="px-4 py-3 font-medium">{t("activity.colGroup")}</th>
                      <th className="px-4 py-3 font-medium">{t("activity.colTime")}</th>
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
                    {t("activity.loadMore")}
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
