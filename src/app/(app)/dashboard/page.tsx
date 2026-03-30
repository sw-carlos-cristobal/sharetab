"use client";

import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowUpRight, ArrowDownLeft, Plus } from "lucide-react";
import Link from "next/link";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const avatarColors = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-fuchsia-500",
  "bg-lime-500",
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

export default function DashboardPage() {
  const dashboard = trpc.balances.getDashboard.useQuery();
  const overallDebts = trpc.balances.getOverallDebts.useQuery();
  const groups = trpc.groups.list.useQuery();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button nativeButton={false} render={<Link href="/groups/new" />}>
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">People who owe you</CardTitle>
          </CardHeader>
          <CardContent>
            {overallDebts.isLoading && (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
            {overallDebts.data?.owedToYou.length === 0 && (
              <p className="text-sm text-muted-foreground">All settled up</p>
            )}
            <div className="space-y-3">
              {overallDebts.data?.owedToYou.map((person) => (
                <div key={person.userId} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColor(person.userId)}`}
                    >
                      {getInitials(person.userName)}
                    </div>
                    <span className="text-sm font-medium">{person.userName}</span>
                  </div>
                  <span className="text-sm font-semibold text-green-600">
                    {formatCents(person.amount)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">People you owe</CardTitle>
          </CardHeader>
          <CardContent>
            {overallDebts.isLoading && (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
            {overallDebts.data?.youOwe.length === 0 && (
              <p className="text-sm text-muted-foreground">All settled up</p>
            )}
            <div className="space-y-3">
              {overallDebts.data?.youOwe.map((person) => (
                <div key={person.userId} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white ${avatarColor(person.userId)}`}
                    >
                      {getInitials(person.userName)}
                    </div>
                    <span className="text-sm font-medium">{person.userName}</span>
                  </div>
                  <span className="text-sm font-semibold text-red-600">
                    {formatCents(person.amount)}
                  </span>
                </div>
              ))}
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
              <Button nativeButton={false} className="mt-4" render={<Link href="/groups/new" />}>
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
