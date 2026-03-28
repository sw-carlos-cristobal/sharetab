"use client";

import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Check, Users } from "lucide-react";

type Member = { id: string; name: string | null };

type Assignments = Record<string, Set<string>>; // receiptItemId -> Set<userId>

export function ItemAssignment({
  groupId,
  receiptId,
  members,
  onComplete,
}: {
  groupId: string;
  receiptId: string;
  members: Member[];
  onComplete: () => void;
}) {
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });

  const [assignments, setAssignments] = useState<Assignments>({});
  const [title, setTitle] = useState("");
  const [paidById, setPaidById] = useState("");
  const [tipOverride, setTipOverride] = useState<string>("");

  const createExpense = trpc.receipts.assignItemsAndCreateExpense.useMutation({
    onSuccess: onComplete,
  });

  // Initialize title from merchant name when data loads
  useMemo(() => {
    if (receiptData.data?.receipt.extractedData?.merchantName && !title) {
      setTitle(receiptData.data.receipt.extractedData.merchantName);
    }
  }, [receiptData.data, title]);

  if (receiptData.isLoading) {
    return <p className="text-muted-foreground">Loading items...</p>;
  }

  if (!receiptData.data) {
    return <p className="text-destructive">Could not load receipt data.</p>;
  }

  const { receipt, items } = receiptData.data;
  const extracted = receipt.extractedData;
  if (!extracted) {
    return <p className="text-destructive">No extracted data available.</p>;
  }

  const tip = tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : extracted.tip;

  function toggleAssignment(itemId: string, userId: string) {
    setAssignments((prev) => {
      const next = { ...prev };
      const current = new Set(next[itemId] ?? []);
      if (current.has(userId)) {
        current.delete(userId);
      } else {
        current.add(userId);
      }
      next[itemId] = current;
      return next;
    });
  }

  function assignAllToEveryone() {
    const next: Assignments = {};
    for (const item of items) {
      next[item.id] = new Set(members.map((m) => m.id));
    }
    setAssignments(next);
  }

  // Calculate per-person totals
  function getPerPersonTotals(): Map<string, number> {
    const userSubtotals = new Map<string, number>();

    for (const item of items) {
      const assigned = assignments[item.id];
      if (!assigned || assigned.size === 0) continue;

      const perPerson = Math.floor(item.totalPrice / assigned.size);
      const remainder = item.totalPrice - perPerson * assigned.size;
      const userIds = Array.from(assigned);

      for (let i = 0; i < userIds.length; i++) {
        const amount = perPerson + (i < remainder ? 1 : 0);
        userSubtotals.set(userIds[i], (userSubtotals.get(userIds[i]) ?? 0) + amount);
      }
    }

    const actualSubtotal = Array.from(userSubtotals.values()).reduce((a, b) => a + b, 0);
    const totalAmount = actualSubtotal + extracted!.tax + tip;

    const userTotals = new Map<string, number>();
    let allocated = 0;
    const entries = Array.from(userSubtotals.entries());

    for (let i = 0; i < entries.length; i++) {
      const [userId, itemTotal] = entries[i];
      if (i === entries.length - 1) {
        userTotals.set(userId, totalAmount - allocated);
      } else {
        const proportion = actualSubtotal > 0 ? itemTotal / actualSubtotal : 0;
        const userTax = Math.round(extracted!.tax * proportion);
        const userTip = Math.round(tip * proportion);
        const total = itemTotal + userTax + userTip;
        userTotals.set(userId, total);
        allocated += total;
      }
    }

    return userTotals;
  }

  const perPersonTotals = getPerPersonTotals();
  const assignedItemCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = assignedItemCount === items.length;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || !allAssigned) return;

    createExpense.mutate({
      groupId,
      receiptId,
      title,
      paidById,
      tipOverride: tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : undefined,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
        })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Receipt summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Receipt Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {extracted.merchantName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Merchant</span>
              <span>{extracted.merchantName}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCents(extracted.subtotal, extracted.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tax</span>
            <span>{formatCents(extracted.tax, extracted.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tip</span>
            <span>{formatCents(tip, extracted.currency)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCents(extracted.subtotal + extracted.tax + tip, extracted.currency)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Expense details */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title">Expense title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Dinner at Restaurant"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paidBy">Paid by</Label>
            <select
              id="paidBy"
              value={paidById}
              onChange={(e) => setPaidById(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
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
            <Label htmlFor="tip">Tip override (optional)</Label>
            <Input
              id="tip"
              type="number"
              step="0.01"
              min="0"
              placeholder={`Detected: ${(extracted.tip / 100).toFixed(2)}`}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Quick actions */}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={assignAllToEveryone}>
          <Users className="mr-2 h-4 w-4" />
          Split all equally
        </Button>
      </div>

      {/* Item assignment */}
      <div className="space-y-2">
        <Label>Assign items ({assignedItemCount}/{items.length} assigned)</Label>
        {items.map((item) => {
          const assigned = assignments[item.id] ?? new Set();
          return (
            <Card key={item.id} className={assigned.size === 0 ? "border-amber-300" : ""}>
              <CardContent className="py-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <span className="font-medium">{item.name}</span>
                    {item.quantity > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        x{item.quantity}
                      </span>
                    )}
                  </div>
                  <span className="font-semibold">
                    {formatCents(item.totalPrice, extracted.currency)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {members.map((m) => {
                    const isAssigned = assigned.has(m.id);
                    const initials = m.name
                      ? m.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)
                      : "?";
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleAssignment(item.id, m.id)}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                          isAssigned
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[8px]">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        {m.name?.split(" ")[0] ?? "?"}
                        {isAssigned && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Per-person summary */}
      {perPersonTotals.size > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Per-person totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {members.map((m) => {
              const total = perPersonTotals.get(m.id);
              if (!total) return null;
              return (
                <div key={m.id} className="flex justify-between text-sm">
                  <span>{m.name ?? "Unnamed"}</span>
                  <span className="font-medium">
                    {formatCents(total, extracted.currency)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {createExpense.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {createExpense.error.message}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={createExpense.isPending || !allAssigned || !paidById}
      >
        {createExpense.isPending
          ? "Creating expense..."
          : !allAssigned
            ? `Assign all items (${items.length - assignedItemCount} remaining)`
            : "Create Expense from Receipt"}
      </Button>
    </form>
  );
}
