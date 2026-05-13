"use client";

import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Shield,
  Database,
  Package,
  Clock,
  FolderOpen,
  HardDrive,
  FileWarning,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { AuditLogSection } from "@/components/admin/audit-log-section";
import { RegistrationControlSection } from "@/components/admin/registration-control-section";
import { AnnouncementSection } from "@/components/admin/announcement-section";
import { ActivityFeedSection } from "@/components/admin/activity-feed-section";
import { AIStatsSection } from "@/components/admin/ai-stats-section";
import { AIProviderTestSection } from "@/components/admin/ai-provider-test-section";
import { ToolsSection } from "@/components/admin/tools-section";
import { ServerLogsSection } from "@/components/admin/server-logs-section";
import { AuthExpiryNotificationsSection } from "@/components/admin/auth-expiry-notifications-section";
import { MeridianAuthSection } from "@/components/admin/meridian-auth-section";
import { OpenAICodexAuthSection } from "@/components/admin/openai-codex-auth-section";
import { UserManagementSection } from "@/components/admin/user-management-section";
import { GroupOverviewSection } from "@/components/admin/group-overview-section";
import { VenmoSettingsSection } from "@/components/admin/venmo-settings-section";

export default function AdminPage() {
  const { data: session } = useSession();
  const t = useTranslations("admin");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-bold">{t("title")}</h1>
      </div>

      <div className="grid gap-6 [&>*]:min-w-0">
        <SystemHealthSection />
        <MeridianAuthSection />
        <OpenAICodexAuthSection />
        <AuthExpiryNotificationsSection />
        <Separator />
        <UserManagementSection currentUserEmail={session?.user?.email} />
        <Separator />
        <GroupOverviewSection />
        <Separator />
        <StorageStatsSection />
        <Separator />
        <RegistrationControlSection />
        <Separator />
        <AnnouncementSection />
        <VenmoSettingsSection />
        <Separator />
        <AIStatsSection />
        <AIProviderTestSection />
        <Separator />
        <ActivityFeedSection />
        <Separator />
        <ToolsSection />
        <Separator />
        <ServerLogsSection />
        <Separator />
        <AuditLogSection />
      </div>
    </div>
  );
}

// ─── System Health ─────────────────────────────────────────

function SystemHealthSection() {
  const t = useTranslations("admin");
  const health = trpc.admin.getSystemHealth.useQuery(undefined, {
    refetchInterval: 30000,
  });

  if (health.isLoading) return <SectionSkeleton title={t("systemHealth.title")} />;

  const data = health.data;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{t("systemHealth.title")}</h2>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Database className="h-4 w-4" />
              {t("systemHealth.database")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  data?.dbStatus === "connected"
                    ? "bg-green-500"
                    : "bg-red-500"
                }`}
              />
              <span className="text-sm font-medium capitalize">
                {data?.dbStatus ?? "unknown"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Package className="h-4 w-4" />
              {t("systemHealth.version")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium">v{data?.version}</span>
            {data?.commitSha && data.commitSha !== "unknown" && (
              <span className="ml-2 text-xs text-muted-foreground font-mono">({data.commitSha})</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Clock className="h-4 w-4" />
              {t("systemHealth.uptime")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium">
              {data ? formatUptime(data.uptime) : "---"}
            </span>
            {data?.serverStartTime && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("systemHealth.started", { time: new Date(data.serverStartTime).toLocaleString() })}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ─── Storage Stats ─────────────────────────────────────────

function StorageStatsSection() {
  const t = useTranslations("admin");
  const storage = trpc.admin.getStorageStats.useQuery();
  const utils = trpc.useUtils();
  const cleanup = trpc.admin.cleanupOrphans.useMutation({
    onSuccess: () => {
      utils.admin.getStorageStats.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  if (storage.isLoading) return <SectionSkeleton title={t("storage.title")} />;

  const data = storage.data;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{t("storage.title")}</h2>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              {t("storage.receipts")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.receiptCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              {t("storage.inDatabase")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              {t("storage.diskUsage")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {data?.totalDiskUsageFormatted ?? "0 B"}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("storage.filesOnDisk", { count: data?.diskFiles ?? 0 })}
            </p>
          </CardContent>
        </Card>

        <Card className="@2xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <FileWarning className="h-4 w-4" />
                {t("storage.orphanedFiles")}
              </span>
              {(data?.orphanCount ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => cleanup.mutate()}
                  disabled={cleanup.isPending}
                >
                  {cleanup.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {t("storage.cleanUp")}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.orphanCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              {t("storage.orphanDescription")}
            </p>
            {cleanup.isSuccess && (
              <p className="mt-2 text-sm text-green-600">
                {t("storage.cleanedUp", { count: cleanup.data.deletedCount, size: cleanup.data.freedBytesFormatted })}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ─── Helpers ───────────────────────────────────────────────

function SectionSkeleton({ title }: { title: string }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </section>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
}
