'use client';

import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, BrainCircuit } from 'lucide-react';

export function AIStatsSection() {
  const t = useTranslations("admin");
  const stats = trpc.admin.getAIStats.useQuery();

  if (stats.isLoading) {
    return (
      <section>
        <div className="mb-4 flex items-center gap-2">
          <BrainCircuit className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t("aiStats.title")}</h2>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </section>
    );
  }

  const data = stats.data;

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <BrainCircuit className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("aiStats.title")}</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("aiStats.totalProcessed")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.total ?? 0}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {data?.byStatus &&
                Object.entries(data.byStatus).map(([status, count]) => (
                  <Badge key={status} variant="outline" className="text-xs">
                    {status}: {count}
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("aiStats.byProvider")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data?.byProvider &&
            Object.keys(data.byProvider).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(data.byProvider).map(([provider, count]) => (
                  <div
                    key={provider}
                    className="flex items-center justify-between"
                  >
                    <span className="text-sm font-medium">{provider}</span>
                    <span className="text-sm text-muted-foreground">
                      {count}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("aiStats.noData")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("aiStats.recentTrends")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">{t("aiStats.last7Days")}</span>
                <span className="text-sm font-medium">
                  {data?.last7Days ?? 0}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t("aiStats.last30Days")}</span>
                <span className="text-sm font-medium">
                  {data?.last30Days ?? 0}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
