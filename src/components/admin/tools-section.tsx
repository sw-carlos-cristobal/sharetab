'use client';

import { useState } from 'react';
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
  const sendTestEmail = trpc.admin.sendTestEmail.useMutation();
  const expiredSplits = trpc.admin.getExpiredSplitCount.useQuery();
  const cleanupSplits = trpc.admin.cleanupExpiredSplits.useMutation({
    onSuccess: () => expiredSplits.refetch(),
  });
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const res = await fetch('/api/admin/export');
      if (!res.ok) {
        setExportResult(`Export failed: ${res.statusText}`);
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
      setExportResult('Export downloaded successfully.');
    } catch (err) {
      setExportResult(
        `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Admin Tools</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Download className="h-4 w-4" />
              Data Export
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Download a full JSON export of all data (excludes passwords).
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
              Export Data
            </Button>
            {exportResult && (
              <p
                className={`text-sm ${exportResult.includes('failed') ? 'text-destructive' : 'text-green-600'}`}
              >
                {exportResult}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Mail className="h-4 w-4" />
              Email Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Send a test email to verify SMTP configuration.
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
              Send Test Email
            </Button>
            {sendTestEmail.isSuccess && (
              <p className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Sent to {sendTestEmail.data.sentTo}
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
              Guest Split Cleanup
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {expiredSplits.data
                ? `${expiredSplits.data.expiredCount} expired of ${expiredSplits.data.totalCount} total guest splits.`
                : 'Loading...'}
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
              Purge Expired
            </Button>
            {cleanupSplits.isSuccess && (
              <p className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Deleted {cleanupSplits.data.deletedCount} expired splits
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
