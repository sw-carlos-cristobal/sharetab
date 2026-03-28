"use client";

import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowUpRight, ArrowDownLeft, Plus } from "lucide-react";
import Link from "next/link";

export default function DashboardPage() {
  const dashboard = trpc.balances.getDashboard.useQuery();
  const groups = trpc.groups.list.useQuery();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button render={<Link href="/groups/new" />}>
          <Plus className="mr-2 h-4 w-4" />
          New Group
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">You are owed</CardTitle>
            <ArrowDownLeft className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {dashboard.data ? formatCents(dashboard.data.totalOwed) : "..."}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">You owe</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {dashboard.data ? formatCents(dashboard.data.totalOwing) : "..."}
            </div>
          </CardContent>
        </Card>
      </div>

      <Separator />

      <div>
        <h2 className="mb-4 text-lg font-semibold">Your Groups</h2>
        {groups.isLoading && <p className="text-muted-foreground">Loading...</p>}
        {groups.data?.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No groups yet. Create one to get started!</p>
              <Button className="mt-4" render={<Link href="/groups/new" />}>
                <Plus className="mr-2 h-4 w-4" />
                Create Group
              </Button>
            </CardContent>
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {groups.data?.map((group) => {
            const balance = dashboard.data?.perGroup.find((g) => g.groupId === group.id);
            return (
              <Link key={group.id} href={`/groups/${group.id}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span>{group.emoji}</span>
                      {group.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {group.members.length} member{group.members.length !== 1 ? "s" : ""}
                      </span>
                      {balance && balance.balance !== 0 && (
                        <span
                          className={balance.balance > 0 ? "text-green-600" : "text-red-600"}
                        >
                          {balance.balance > 0 ? "+" : ""}
                          {formatCents(balance.balance)}
                        </span>
                      )}
                      {balance && balance.balance === 0 && (
                        <span className="text-muted-foreground">Settled up</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
