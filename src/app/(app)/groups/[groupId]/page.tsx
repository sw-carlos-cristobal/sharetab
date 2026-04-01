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
  Handshake,
  Camera,
  Tag,
  Archive,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { InviteDialog } from "@/components/groups/invite-dialog";
import { SettleDialog } from "@/components/groups/settle-dialog";

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

export default function GroupDetailPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const [showInvite, setShowInvite] = useState(false);
  const [settleState, setSettleState] = useState<{
    open: boolean;
    from?: string;
    to?: string;
    amount?: number;
  }>({ open: false });

  const group = trpc.groups.get.useQuery({ groupId });
  const expenses = trpc.expenses.list.useQuery({ groupId, limit: 10 });
  const debts = trpc.balances.getSimplifiedDebts.useQuery({ groupId });
  const pendingReceipts = trpc.receipts.listPending.useQuery({ groupId });
  const deletePending = trpc.receipts.deletePending.useMutation({
    onSuccess: () => pendingReceipts.refetch(),
  });

  if (group.isLoading) {
    return <p className="text-muted-foreground">Loading...</p>;
  }

  if (!group.data) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Receipt className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">Group not found</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          This group doesn&apos;t exist or you don&apos;t have access to it.
        </p>
        <Button nativeButton={false} render={<Link href="/groups" />}>
          Back to Groups
        </Button>
      </div>
    );
  }

  const g = group.data;
  const memberMap = new Map(g.members.map((m) => [m.user.id, m.user]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-accent">
            <span className="text-4xl leading-none">{g.emoji}</span>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold leading-tight">{g.name}</h1>
            {g.description && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{g.description}</p>
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
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/settings`} />}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Members */}
      <div className="flex flex-wrap gap-2">
        {g.members.map((m) => (
          <div
            key={m.user.id}
            className={`flex items-center gap-2 rounded-full py-1 pr-3 pl-1 ${
              m.user.isPlaceholder
                ? "border border-dashed border-muted-foreground/40 bg-muted/50"
                : "bg-muted"
            }`}
          >
            {m.user.image ? (
              <Avatar className="h-6 w-6">
                <AvatarImage src={m.user.image} />
                <AvatarFallback className="text-[10px]">
                  {getInitials(m.user.placeholderName ?? m.user.name, m.user.email)}
                </AvatarFallback>
              </Avatar>
            ) : (
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium text-white ${avatarColor(m.user.id)}`}
              >
                {getInitials(m.user.placeholderName ?? m.user.name, m.user.email)}
              </div>
            )}
            <span className="text-sm font-medium">
              {m.user.placeholderName ?? m.user.name ?? m.user.email}
            </span>
            {m.role === "OWNER" && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Owner
              </span>
            )}
            {m.user.isPlaceholder && (
              <Badge variant="outline" className="ml-0.5 text-[10px]">
                Pending
              </Badge>
            )}
          </div>
        ))}
      </div>

      {g.archivedAt && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
          <Archive className="h-4 w-4 shrink-0" />
          <span>This group is archived. Expenses cannot be added.</span>
          <Button
            variant="link"
            size="sm"
            className="ml-auto h-auto p-0 text-amber-800 dark:text-amber-200"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/settings`} />}
          >
            Manage
          </Button>
        </div>
      )}

      <Separator />

      {/* Simplified Debts */}
      {debts.data && debts.data.debts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Balances</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSettleState({ open: true })}
              >
                <Handshake className="mr-2 h-4 w-4" />
                Settle up
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {debts.data.debts.map((debt, i) => {
              const from = memberMap.get(debt.from);
              const to = memberMap.get(debt.to);
              return (
                <button
                  key={i}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg p-2.5 text-sm transition-all hover:bg-muted/70 hover:shadow-sm"
                  onClick={() =>
                    setSettleState({
                      open: true,
                      from: debt.from,
                      to: debt.to,
                      amount: debt.amount,
                    })
                  }
                >
                  <span className="truncate text-xs font-medium text-red-600 sm:text-sm dark:text-red-400">
                    {from?.name ?? from?.email ?? "Unknown"}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium text-emerald-600 sm:text-sm dark:text-emerald-400">
                    {to?.name ?? to?.email ?? "Unknown"}
                  </span>
                  <span className="ml-auto shrink-0 font-semibold tabular-nums text-red-600 dark:text-red-400">
                    {formatCents(debt.amount, g.currency)}
                  </span>
                </button>
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

      {/* Pending Receipts */}
      {pendingReceipts.data && pendingReceipts.data.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-semibold">Pending Receipts</h2>
          <div className="space-y-2">
            {pendingReceipts.data.map((r) => (
              <Card key={r.id} className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between py-3">
                  <Link href={`/groups/${groupId}/scan?receiptId=${r.id}`} className="flex-1 min-w-0">
                    <p className="font-medium">
                      {r.extractedData?.merchantName ?? "Receipt"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {r.extractedData?.date ?? new Date(r.createdAt).toLocaleDateString()}
                      {" · "}Saved for later
                    </p>
                  </Link>
                  <div className="flex items-center gap-3 ml-3">
                    <p className="text-lg font-semibold">
                      {r.extractedData
                        ? formatCents(r.extractedData.total, g.currency)
                        : "—"}
                    </p>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                      onClick={() => {
                        if (confirm("Delete this pending receipt?")) {
                          deletePending.mutate({ receiptId: r.id });
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Expenses */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Expenses</h2>
          {!g.archivedAt && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link href={`/groups/${groupId}/scan`} />}
              >
                <Camera className="mr-2 h-4 w-4" />
                Scan Receipt
              </Button>
              <Button size="sm" nativeButton={false} render={<Link href={`/groups/${groupId}/expenses/new`} />}>
                <Plus className="mr-2 h-4 w-4" />
                Add Expense
              </Button>
            </div>
          )}
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
                nativeButton={false}
                render={<Link href={`/groups/${groupId}/expenses/new`} />}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add your first expense
              </Button>
            </CardContent>
          </Card>
        )}

        {expenses.data && expenses.data.expenses.length > 0 && (
        <Card className="divide-y divide-border overflow-hidden">
          {expenses.data.expenses.map((expense, index) => (
            <Link
              key={expense.id}
              href={`/groups/${groupId}/expenses/${expense.id}`}
              className="block"
            >
              <div
                className={`flex items-center justify-between px-4 py-3 transition-colors hover:bg-muted/50 ${
                  index % 2 === 1 ? "bg-muted/20" : ""
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent">
                    <Tag className="h-3.5 w-3.5 text-accent-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{expense.title}</p>
                    <p className="text-sm text-muted-foreground">
                      Paid by {expense.paidBy.name ?? expense.paidBy.email ?? "Unknown"}
                      {" · "}
                      {new Date(expense.expenseDate).toLocaleDateString()}
                      {expense.category && (
                        <span className="ml-1 text-muted-foreground/70">
                          {" · "}{expense.category}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <p className="ml-4 shrink-0 text-lg font-semibold tabular-nums">
                  {formatCents(expense.amount, g.currency)}
                </p>
              </div>
            </Link>
          ))}
        </Card>
        )}
      </div>

      <InviteDialog
        groupId={groupId}
        open={showInvite}
        onOpenChange={setShowInvite}
      />

      <SettleDialog
        groupId={groupId}
        members={g.members.map((m) => ({ id: m.user.id, name: m.user.name ?? m.user.email }))}
        suggestedFrom={settleState.from}
        suggestedTo={settleState.to}
        suggestedAmount={settleState.amount}
        currency={g.currency}
        open={settleState.open}
        onOpenChange={(open) => setSettleState((s) => ({ ...s, open }))}
      />
    </div>
  );
}
