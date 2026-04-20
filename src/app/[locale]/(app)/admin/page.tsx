"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Shield,
  Database,
  Package,
  Clock,
  Trash2,
  FolderOpen,
  HardDrive,
  FileWarning,
  Loader2,
  RefreshCw,
  Ban,
  CheckCircle2,
  UserCheck,
} from "lucide-react";

import { AuditLogSection } from "@/components/admin/audit-log-section";
import { RegistrationControlSection } from "@/components/admin/registration-control-section";
import { AnnouncementSection } from "@/components/admin/announcement-section";
import { ActivityFeedSection } from "@/components/admin/activity-feed-section";
import { AIStatsSection } from "@/components/admin/ai-stats-section";
import { ToolsSection } from "@/components/admin/tools-section";
import { ServerLogsSection } from "@/components/admin/server-logs-section";
import { AuthExpiryNotificationsSection } from "@/components/admin/auth-expiry-notifications-section";
import { MeridianAuthSection } from "@/components/admin/meridian-auth-section";
import { OpenAICodexAuthSection } from "@/components/admin/openai-codex-auth-section";

export default function AdminPage() {
  const { data: session } = useSession();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
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
        <Separator />
        <AIStatsSection />
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
  const health = trpc.admin.getSystemHealth.useQuery(undefined, {
    refetchInterval: 30000,
  });

  if (health.isLoading) return <SectionSkeleton title="System Health" />;

  const data = health.data;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">System Health</h2>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Database className="h-4 w-4" />
              Database
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
              Version
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium">v{data?.version}</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Clock className="h-4 w-4" />
              Uptime
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium">
              {data ? formatUptime(data.uptime) : "---"}
            </span>
            {data?.serverStartTime && (
              <p className="mt-1 text-xs text-muted-foreground">
                Started{" "}
                {new Date(data.serverStartTime).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ─── User Management ───────────────────────────────────────

function UserManagementSection({
  currentUserEmail,
}: {
  currentUserEmail?: string | null;
}) {
  const router = useRouter();
  const users = trpc.admin.listUsers.useQuery();
  const utils = trpc.useUtils();
  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
      setDeleteTarget(null);
    },
  });
  const suspendUser = trpc.admin.suspendUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });
  const unsuspendUser = trpc.admin.unsuspendUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string | null;
    email: string;
  } | null>(null);
  const [impersonating, setImpersonating] = useState(false);

  if (users.isLoading) return <SectionSkeleton title="User Management" />;

  const handleImpersonate = async (userId: string) => {
    setImpersonating(true);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        window.location.href = "/dashboard";
      }
    } finally {
      setImpersonating(false);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">User Management</h2>
        <Badge variant="secondary">
          {users.data?.totalCount ?? 0} users
        </Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Groups</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.users.map((user) => (
                  <tr key={user.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">
                      {user.name ?? "---"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.email}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {user.isPlaceholder ? (
                          <Badge variant="outline">Placeholder</Badge>
                        ) : (
                          <Badge variant="secondary">User</Badge>
                        )}
                        {user.isSuspended && (
                          <Badge variant="destructive">Suspended</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">{user.groupCount}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {user.email !== currentUserEmail && (
                        <div className="flex items-center gap-1">
                          {user.isSuspended ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Unsuspend user"
                              onClick={() =>
                                unsuspendUser.mutate({ userId: user.id })
                              }
                              disabled={unsuspendUser.isPending}
                            >
                              <CheckCircle2 className="h-4 w-4 text-green-600" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Suspend user"
                              onClick={() =>
                                suspendUser.mutate({ userId: user.id })
                              }
                              disabled={suspendUser.isPending}
                            >
                              <Ban className="h-4 w-4 text-orange-600" />
                            </Button>
                          )}
                          {!user.isPlaceholder && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="Impersonate user"
                              onClick={() => handleImpersonate(user.id)}
                              disabled={impersonating}
                            >
                              <UserCheck className="h-4 w-4 text-purple-600" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Delete user"
                            onClick={() =>
                              setDeleteTarget({
                                id: user.id,
                                name: user.name,
                                email: user.email,
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>{deleteTarget?.name ?? deleteTarget?.email}</strong>? This
              action cannot be undone. All their data will be permanently
              removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteUser.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget && deleteUser.mutate({ userId: deleteTarget.id })
              }
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Group Overview ────────────────────────────────────────

function GroupOverviewSection() {
  const groups = trpc.admin.listGroups.useQuery();
  const utils = trpc.useUtils();
  const deleteGroup = trpc.admin.deleteGroup.useMutation({
    onSuccess: () => {
      utils.admin.listGroups.invalidate();
      utils.admin.getAuditLog.invalidate();
      setDeleteTarget(null);
    },
  });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  if (groups.isLoading) return <SectionSkeleton title="Group Overview" />;

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Group Overview</h2>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">
            {groups.data?.totalCount ?? 0} groups
          </Badge>
          <Badge variant="secondary">
            {groups.data?.totalExpenses ?? 0} expenses
          </Badge>
          <Badge variant="secondary">
            {groups.data?.totalSettlements ?? 0} settlements
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium text-right">Members</th>
                  <th className="px-4 py-3 font-medium text-right">
                    Expenses
                  </th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                  <th className="px-4 py-3 font-medium">Last Activity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {groups.data?.groups.map((group) => (
                  <tr key={group.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{group.name}</td>
                    <td className="px-4 py-3 text-right">
                      {group.memberCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {group.expenseCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {formatCents(group.totalAmount)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(group.lastActivity).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {group.isArchived ? (
                        <Badge variant="outline">Archived</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          setDeleteTarget({
                            id: group.id,
                            name: group.name,
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Group</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
              This will permanently remove all expenses, settlements, and
              activity in this group.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteGroup.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteTarget &&
                deleteGroup.mutate({ groupId: deleteTarget.id })
              }
              disabled={deleteGroup.isPending}
            >
              {deleteGroup.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Storage Stats ─────────────────────────────────────────

function StorageStatsSection() {
  const storage = trpc.admin.getStorageStats.useQuery();
  const utils = trpc.useUtils();
  const cleanup = trpc.admin.cleanupOrphans.useMutation({
    onSuccess: () => {
      utils.admin.getStorageStats.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  if (storage.isLoading) return <SectionSkeleton title="Storage Stats" />;

  const data = storage.data;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">Storage Stats</h2>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              Receipts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.receiptCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              in database
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              Disk Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {data?.totalDiskUsageFormatted ?? "0 B"}
            </p>
            <p className="text-xs text-muted-foreground">
              {data?.diskFiles ?? 0} files on disk
            </p>
          </CardContent>
        </Card>

        <Card className="@2xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <FileWarning className="h-4 w-4" />
                Orphaned Files
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
                  Clean up
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.orphanCount ?? 0}</p>
            <p className="text-xs text-muted-foreground">
              files on disk not referenced by any receipt in the database
            </p>
            {cleanup.isSuccess && (
              <p className="mt-2 text-sm text-green-600">
                Cleaned up {cleanup.data.deletedCount} files (
                {cleanup.data.freedBytesFormatted} freed)
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
