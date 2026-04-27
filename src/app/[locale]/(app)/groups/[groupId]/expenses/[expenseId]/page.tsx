"use client";

import { use } from "react";
import { useLocale } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Trash2, Pencil } from "lucide-react";

export default function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ groupId: string; expenseId: string }>;
}) {
  const { groupId, expenseId } = use(params);
  const locale = useLocale();
  const router = useRouter();

  const expense = trpc.expenses.get.useQuery({ groupId, expenseId });
  const deleteExpense = trpc.expenses.delete.useMutation({
    onSuccess: () => router.push(`/groups/${groupId}`),
  });

  if (expense.isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!expense.data) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Trash2 className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">Expense not found</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          This expense doesn&apos;t exist or has been deleted.
        </p>
        <Button nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          Back to Group
        </Button>
      </div>
    );
  }

  const e = expense.data;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{e.title}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{formatCents(e.amount, e.currency, locale)}</span>
            <Badge variant="secondary">{e.splitMode}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Paid by</p>
              <p className="font-medium">{e.paidBy.name ?? "Unknown"}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Date</p>
              <p className="font-medium">
                {new Date(e.expenseDate).toLocaleDateString()}
              </p>
            </div>
            {e.category && (
              <div>
                <p className="text-muted-foreground">Category</p>
                <p className="font-medium">{e.category}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">Added by</p>
              <p className="font-medium">{e.addedBy.name ?? "Unknown"}</p>
            </div>
          </div>

          {e.description && (
            <>
              <Separator />
              <p className="text-sm">{e.description}</p>
            </>
          )}

          <Separator />

          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">Split</p>
            <div className="space-y-1">
              {e.shares.map((share) => (
                <div
                  key={share.userId}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{share.user.name ?? "Unknown"}</span>
                  <span className="font-medium">
                    {formatCents(share.amount, e.currency, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="flex-1"
          nativeButton={false}
          render={<Link href={`/groups/${groupId}/expenses/${expenseId}/edit`} />}
        >
          <Pencil className="mr-2 h-4 w-4" />
          Edit Expense
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          onClick={() => {
            if (confirm("Delete this expense?")) {
              deleteExpense.mutate({ groupId, expenseId });
            }
          }}
          disabled={deleteExpense.isPending}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {deleteExpense.isPending ? "Deleting..." : "Delete"}
        </Button>
      </div>
    </div>
  );
}
