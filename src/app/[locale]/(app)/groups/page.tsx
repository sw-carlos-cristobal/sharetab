"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Archive, ArchiveRestore, Plus, Search } from "lucide-react";

const GROUPS_PER_PAGE = 12;

export default function GroupsPage() {
  const searchParams = useSearchParams();
  const [showArchived, setShowArchived] = useState(searchParams.get("archived") === "1");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const groups = trpc.groups.list.useQuery();
  const archivedGroups = trpc.groups.listArchived.useQuery(undefined, { enabled: showArchived });
  const unarchive = trpc.groups.unarchive.useMutation({
    onSuccess: () => {
      groups.refetch();
      archivedGroups.refetch();
    },
  });

  const activeList = showArchived ? archivedGroups.data : groups.data;
  const isLoading = showArchived ? archivedGroups.isLoading : groups.isLoading;
  const hasGroups = (groups.data?.length ?? 0) > 0 || (archivedGroups.data?.length ?? 0) > 0;

  const filteredGroups = activeList?.filter((group) =>
    group.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Groups</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your shared expenses
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/groups/new" />}>
          <Plus className="mr-2 h-4 w-4" />
          New Group
        </Button>
      </div>

      {hasGroups && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search groups..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => { setShowArchived(!showArchived); setShowAll(false); }}
            className="shrink-0"
          >
            <Archive className="mr-2 h-4 w-4" />
            Archived
          </Button>
        </div>
      )}

      {isLoading && <p className="text-muted-foreground">Loading...</p>}

      {!isLoading && activeList?.length === 0 && !search && (
        <Card>
          <CardContent className="py-12 text-center">
            {showArchived ? (
              <p className="text-muted-foreground">No archived groups.</p>
            ) : (
              <>
                <p className="text-muted-foreground">No groups yet.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create a group to start splitting expenses with friends.
                </p>
                <Button nativeButton={false} className="mt-4" render={<Link href="/groups/new" />}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create your first group
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {hasGroups && filteredGroups?.length === 0 && search && (
        <p className="text-center text-muted-foreground">
          No groups match your search.
        </p>
      )}

      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
        {(search || showAll ? filteredGroups : filteredGroups?.slice(0, GROUPS_PER_PAGE))?.map((group) => (
          <Link key={group.id} href={`/groups/${group.id}`}>
            <Card className={`border-l-[3px] transition-all duration-200 hover:-translate-y-px hover:shadow-md ${
              showArchived
                ? "border-l-muted-foreground/40 border-dashed opacity-75"
                : "border-l-primary/60 hover:border-l-primary"
            }`}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2.5 text-base">
                  <span className="text-2xl leading-none">{group.emoji}</span>
                  <span className="flex-1 truncate">{group.name}</span>
                  {showArchived && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      <Archive className="mr-1 h-3 w-3" />
                      Archived
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {group.description && (
                  <p className="mb-1.5 truncate text-sm text-muted-foreground">
                    {group.description}
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {group.members.length} member{group.members.length !== 1 ? "s" : ""}
                    {" · "}
                    {group._count.expenses} expense{group._count.expenses !== 1 ? "s" : ""}
                  </p>
                  {showArchived && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={(e) => {
                        e.preventDefault();
                        unarchive.mutate({ groupId: group.id });
                      }}
                      disabled={unarchive.isPending}
                    >
                      <ArchiveRestore className="mr-1 h-3 w-3" />
                      Unarchive
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {!search && !showAll && (filteredGroups?.length ?? 0) > GROUPS_PER_PAGE && (
        <div className="text-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAll(true)}
          >
            Show all {filteredGroups?.length} groups
          </Button>
        </div>
      )}
    </div>
  );
}
