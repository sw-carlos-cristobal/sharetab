"use client";

import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Trash2,
  Loader2,
  Ban,
  CheckCircle2,
  UserCheck,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

type UserSortBy = "name" | "email" | "groupCount" | "createdAt";
type UserStatus = "all" | "active" | "suspended" | "placeholder";
type SortDirection = "asc" | "desc";

function SortIcon({
  column,
  currentSort,
  currentDirection,
}: {
  column: UserSortBy;
  currentSort: UserSortBy;
  currentDirection: SortDirection;
}) {
  if (column !== currentSort) {
    return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 text-muted-foreground/50" />;
  }
  return currentDirection === "asc" ? (
    <ArrowUp className="ml-1 inline h-3.5 w-3.5" />
  ) : (
    <ArrowDown className="ml-1 inline h-3.5 w-3.5" />
  );
}

export function UserManagementSection({
  currentUserEmail,
}: {
  currentUserEmail?: string | null;
}) {
  const utils = trpc.useUtils();

  // Filter / search / sort state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<UserStatus>("all");
  const [sortBy, setSortBy] = useState<UserSortBy>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Infinite query with cursor pagination
  const users = trpc.admin.listUsers.useInfiniteQuery(
    {
      limit: 20,
      search: debouncedSearch || undefined,
      status,
      sortBy,
      sortDirection,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const allUsers = users.data?.pages.flatMap((p) => p.users) ?? [];
  const totalCount = users.data?.pages[0]?.totalCount ?? 0;

  // Mutations
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

  const handleImpersonate = async (userId: string) => {
    setImpersonating(true);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        const [, locale] = window.location.pathname.split("/");
        window.location.href = locale ? `/${locale}/dashboard` : "/dashboard";
      }
    } finally {
      setImpersonating(false);
    }
  };

  const handleSort = (column: UserSortBy) => {
    if (sortBy === column) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDirection("asc");
    }
  };

  const statuses: { value: UserStatus; label: string }[] = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "suspended", label: "Suspended" },
    { value: "placeholder", label: "Placeholder" },
  ];

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">User Management</h2>
        <Badge variant="secondary">{totalCount} users</Badge>
      </div>

      {/* Filters toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Status filter buttons */}
        <div className="flex gap-1">
          {statuses.map((s) => (
            <Button
              key={s.value}
              size="sm"
              variant={status === s.value ? "default" : "outline"}
              onClick={() => setStatus(s.value)}
              className="h-7 px-2.5 text-xs"
            >
              {s.label}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search users"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 pl-8 text-xs"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {users.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : users.isError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-destructive">
              <p>Failed to load users.</p>
              <Button variant="outline" size="sm" onClick={() => users.refetch()}>
                Retry
              </Button>
            </div>
          ) : allUsers.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No users found.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex items-center hover:text-foreground"
                          onClick={() => handleSort("name")}
                        >
                          Name
                          <SortIcon
                            column="name"
                            currentSort={sortBy}
                            currentDirection={sortDirection}
                          />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex items-center hover:text-foreground"
                          onClick={() => handleSort("email")}
                        >
                          Email
                          <SortIcon
                            column="email"
                            currentSort={sortBy}
                            currentDirection={sortDirection}
                          />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium text-right">
                        <button
                          type="button"
                          className="inline-flex items-center hover:text-foreground"
                          onClick={() => handleSort("groupCount")}
                        >
                          Groups
                          <SortIcon
                            column="groupCount"
                            currentSort={sortBy}
                            currentDirection={sortDirection}
                          />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex items-center hover:text-foreground"
                          onClick={() => handleSort("createdAt")}
                        >
                          Created
                          <SortIcon
                            column="createdAt"
                            currentSort={sortBy}
                            currentDirection={sortDirection}
                          />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers.map((user) => (
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
                        <td className="px-4 py-3 text-right">
                          {user.groupCount}
                        </td>
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
                                  aria-label={`Unsuspend ${user.name ?? user.email}`}
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
                                  aria-label={`Suspend ${user.name ?? user.email}`}
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
                                  aria-label={`Impersonate ${user.name ?? user.email}`}
                                  onClick={() => handleImpersonate(user.id)}
                                  disabled={impersonating}
                                >
                                  <UserCheck className="h-4 w-4 text-purple-600" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${user.name ?? user.email}`}
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
              {users.hasNextPage && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => users.fetchNextPage()}
                    disabled={users.isFetchingNextPage}
                  >
                    {users.isFetchingNextPage && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
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
