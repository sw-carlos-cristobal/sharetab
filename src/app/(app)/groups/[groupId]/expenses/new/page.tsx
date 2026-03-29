"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { parseToCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { EqualSplit } from "@/components/expenses/equal-split";
import { ExactSplit } from "@/components/expenses/exact-split";
import { PercentageSplit } from "@/components/expenses/percentage-split";
import { SharesSplit } from "@/components/expenses/shares-split";

type SplitMode = "EQUAL" | "EXACT" | "PERCENTAGE" | "SHARES";

type MemberInfo = {
  id: string;
  name: string | null;
};

type ShareEntry = {
  userId: string;
  amount: number;
  shares?: number;
  percentage?: number;
};

const SPLIT_MODES: { value: SplitMode; label: string; description: string }[] = [
  { value: "EQUAL", label: "Equal", description: "Split evenly among selected members" },
  { value: "EXACT", label: "Exact", description: "Enter each person's share" },
  { value: "PERCENTAGE", label: "Percentage", description: "Split by percentage" },
  { value: "SHARES", label: "Shares", description: "Split by share units" },
];

export default function NewExpensePage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const router = useRouter();
  const group = trpc.groups.get.useQuery({ groupId });

  const [title, setTitle] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [category, setCategory] = useState("");
  const [paidById, setPaidById] = useState("");
  const [splitMode, setSplitMode] = useState<SplitMode>("EQUAL");
  const [shares, setShares] = useState<ShareEntry[]>([]);

  const createExpense = trpc.expenses.create.useMutation({
    onSuccess: () => {
      router.push(`/groups/${groupId}`);
    },
  });

  const members: MemberInfo[] =
    group.data?.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
    })) ?? [];

  const amountCents = parseToCents(amountStr);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || amountCents <= 0 || shares.length === 0) return;

    createExpense.mutate({
      groupId,
      title,
      amount: amountCents,
      category: category || undefined,
      paidById,
      splitMode,
      shares,
    });
  }

  if (group.isLoading) return <p className="text-muted-foreground">Loading...</p>;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <a
          href={`/groups/${groupId}`}
          className="inline-flex shrink-0 items-center justify-center rounded-lg size-8 hover:bg-muted hover:text-foreground transition-all [&_svg]:pointer-events-none"
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <h1 className="text-2xl font-bold">Add Expense</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expense details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Description</Label>
              <Input
                id="title"
                placeholder="e.g., Dinner, Groceries, Uber"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category (optional)</Label>
              <Input
                id="category"
                placeholder="e.g., Food, Transport"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="paidBy">Paid by</Label>
              <select
                id="paidBy"
                value={paidById}
                onChange={(e) => setPaidById(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select member</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? "Unnamed"}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>Split mode</Label>
              <div className="grid grid-cols-2 gap-2">
                {SPLIT_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setSplitMode(mode.value)}
                    className={`rounded-md border p-2 text-left text-sm transition-colors ${
                      splitMode === mode.value
                        ? "border-primary bg-primary/10"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <div className="font-medium">{mode.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {mode.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Split between</Label>
              {splitMode === "EQUAL" && (
                <EqualSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                />
              )}
              {splitMode === "EXACT" && (
                <ExactSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                />
              )}
              {splitMode === "PERCENTAGE" && (
                <PercentageSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                />
              )}
              {splitMode === "SHARES" && (
                <SharesSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                />
              )}
            </div>

            {createExpense.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {createExpense.error.message}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={createExpense.isPending || amountCents <= 0 || shares.length === 0}
            >
              {createExpense.isPending ? "Adding..." : "Add Expense"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
