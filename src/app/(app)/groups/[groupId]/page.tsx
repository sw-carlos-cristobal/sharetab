"use client";

import { use, useState } from "react";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Plus,
  Settings,
  UserPlus,
  ArrowRight,
  Receipt,
} from "lucide-react";
import Link from "next/link";
import { InviteDialog } from "@/components/groups/invite-dialog";

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email?.[0]?.toUpperCase() ?? "?";
}

export default function GroupDetailPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const [showInvite, setShowInvite] = useState(false);

  const group = trpc.groups.get.useQuery({ groupId });
  const expenses = trpc.expenses.list.useQuery({ groupId, limit: 10 });
  const debts = trpc.balances.getSimplifiedDebts.useQuery({ groupId });

  if (group.isLoading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!group.data) {
    return <p className="text-destructive">Group not found.</p>;
  }

  const g = group.data;
  const memberMap = new Map(g.members.map((m) => [m.user.id, m.user]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{g.emoji}</span>
          <div>
            <h1 className="text-2xl font-bold">{g.name}</h1>
            {g.description && (
              <p className="text-sm text-muted-foreground">{g.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowInvite(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite
          </Button>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/groups/${groupId}/settings`} />}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Members */}
      <div className="flex flex-wrap gap-2">
        {g.members.map((m) => (
          <div key={m.user.id} className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
            <Avatar className="h-5 w-5">
              <AvatarImage src={m.user.image ?? undefined} />
              <AvatarFallback className="text-[10px]">
                {getInitials(m.user.name, m.user.email)}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm">{m.user.name ?? m.user.email}</span>
            {m.role === "OWNER" && (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                Owner
              </Badge>
            )}
          </div>
        ))}
      </div>

      <Separator />

      {/* Simplified Debts */}
      {debts.data && debts.data.debts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Balances</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {debts.data.debts.map((debt, i) => {
              const from = memberMap.get(debt.from);
              const to = memberMap.get(debt.to);
              return (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{from?.name ?? "Unknown"}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{to?.name ?? "Unknown"}</span>
                  <span className="ml-auto font-semibold text-red-600">
                    {formatCents(debt.amount, g.currency)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {debts.data && debts.data.debts.length === 0 && (
        <Card>
          <CardContent className="py-4 text-center text-sm text-muted-foreground">
            All settled up!
          </CardContent>
        </Card>
      )}

      {/* Expenses */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Expenses</h2>
          <Button size="sm" render={<Link href={`/groups/${groupId}/expenses/new`} />}>
            <Plus className="mr-2 h-4 w-4" />
            Add Expense
          </Button>
        </div>

        {expenses.isLoading && <p className="text-muted-foreground">Loading...</p>}

        {expenses.data?.expenses.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center">
              <Receipt className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-muted-foreground">No expenses yet.</p>
              <Button
                className="mt-4"
                size="sm"
                render={<Link href={`/groups/${groupId}/expenses/new`} />}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add your first expense
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="space-y-2">
          {expenses.data?.expenses.map((expense) => (
            <Link key={expense.id} href={`/groups/${groupId}/expenses/${expense.id}`}>
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{expense.title}</p>
                    <p className="text-sm text-muted-foreground">
                      Paid by {expense.paidBy.name ?? "Unknown"}
                      {" · "}
                      {new Date(expense.expenseDate).toLocaleDateString()}
                    </p>
                  </div>
                  <p className="text-lg font-semibold">
                    {formatCents(expense.amount, g.currency)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <InviteDialog
        groupId={groupId}
        open={showInvite}
        onOpenChange={setShowInvite}
      />
    </div>
  );
}
