"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function GroupsPage() {
  const groups = trpc.groups.list.useQuery();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Groups</h1>
        <Button nativeButton={false} render={<Link href="/groups/new" />}>
          <Plus className="mr-2 h-4 w-4" />
          New Group
        </Button>
      </div>

      {groups.isLoading && <p className="text-muted-foreground">Loading...</p>}

      {groups.data?.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No groups yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a group to start splitting expenses with friends.
            </p>
            <Button nativeButton={false} className="mt-4" render={<Link href="/groups/new" />}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first group
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groups.data?.map((group) => (
          <Link key={group.id} href={`/groups/${group.id}`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <span>{group.emoji}</span>
                  {group.name}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {group.members.length} member{group.members.length !== 1 ? "s" : ""}
                  {" · "}
                  {group._count.expenses} expense{group._count.expenses !== 1 ? "s" : ""}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
