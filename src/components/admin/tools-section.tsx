'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Loader2,
  Download,
  Mail,
  Wrench,
  CheckCircle2,
  AlertCircle,
  Trash2,
} from 'lucide-react';

export function ToolsSection() {
  const t = useTranslations("admin");
  const sendTestEmail = trpc.admin.sendTestEmail.useMutation();
  const expiredSplits = trpc.admin.getExpiredSplitCount.useQuery();
  const cleanupSplits = trpc.admin.cleanupExpiredSplits.useMutation({
    onSuccess: () => expiredSplits.refetch(),
  });
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ message: string; isError: boolean } | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const res = await fetch('/api/admin/export');
      if (!res.ok) {
        setExportResult({ message: t("tools.exportFailed", { error: res.statusText }), isError: true });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition?.match(/filename="(.+)"/);
      a.download = match?.[1] ?? 'sharetab-export.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportResult({ message: t("tools.exportSuccess"), isError: false });
    } catch (err) {
      setExportResult({
        message: t("tools.exportFailed", { error: err instanceof Error ? err.message : 'Unknown error' }),
        isError: true,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("tools.title")}</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Download className="h-4 w-4" />
              {t("tools.exportTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("tools.exportDescription")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t("tools.exportButton")}
            </Button>
            {exportResult && (
              <p
                className={`text-sm ${exportResult.isError ? 'text-destructive' : 'text-green-600'}`}
              >
                {exportResult.message}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Mail className="h-4 w-4" />
              {t("tools.emailTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("tools.emailDescription")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendTestEmail.mutate()}
              disabled={sendTestEmail.isPending}
            >
              {sendTestEmail.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Mail className="mr-2 h-4 w-4" />
              )}
              {t("tools.emailButton")}
            </Button>
            {sendTestEmail.isSuccess && (
              <p className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {t("tools.emailSentTo", { email: sendTestEmail.data.sentTo })}
              </p>
            )}
            {sendTestEmail.isError && (
              <p className="flex items-center gap-1 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {sendTestEmail.error.message}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Trash2 className="h-4 w-4" />
              {t("tools.cleanupTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {expiredSplits.data
                ? t("tools.cleanupStats", {
                    expired: expiredSplits.data.expiredCount,
                    total: expiredSplits.data.totalCount,
                  })
                : t("tools.cleanupLoading")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => cleanupSplits.mutate()}
              disabled={cleanupSplits.isPending || (expiredSplits.data?.expiredCount ?? 0) === 0}
            >
              {cleanupSplits.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t("tools.cleanupButton")}
            </Button>
            {cleanupSplits.isSuccess && (
              <p className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {t("tools.cleanupSuccess", { count: cleanupSplits.data.deletedCount })}
              </p>
            )}
            {cleanupSplits.isError && (
              <p className="flex items-center gap-1 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {cleanupSplits.error.message}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
