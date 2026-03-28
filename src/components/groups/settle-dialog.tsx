"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { parseToCents, formatCents } from "@/lib/money";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Member = { id: string; name: string | null };

export function SettleDialog({
  groupId,
  members,
  suggestedFrom,
  suggestedTo,
  suggestedAmount,
  currency,
  open,
  onOpenChange,
}: {
  groupId: string;
  members: Member[];
  suggestedFrom?: string;
  suggestedTo?: string;
  suggestedAmount?: number;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [toId, setToId] = useState(suggestedTo ?? "");
  const [amountStr, setAmountStr] = useState(
    suggestedAmount ? (suggestedAmount / 100).toFixed(2) : ""
  );
  const [note, setNote] = useState("");

  const utils = trpc.useUtils();
  const settle = trpc.settlements.create.useMutation({
    onSuccess: () => {
      utils.balances.getGroupBalances.invalidate({ groupId });
      utils.balances.getSimplifiedDebts.invalidate({ groupId });
      utils.balances.getDashboard.invalidate();
      utils.settlements.list.invalidate({ groupId });
      onOpenChange(false);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseToCents(amountStr);
    if (!toId || amount <= 0) return;
    settle.mutate({ groupId, toId, amount, currency, note: note || undefined });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            Record a payment you made to settle a debt.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="to">Paid to</Label>
            <select
              id="to"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
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
            <Label htmlFor="settle-amount">Amount</Label>
            <Input
              id="settle-amount"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0.00"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              required
            />
            {suggestedAmount && (
              <button
                type="button"
                onClick={() => setAmountStr((suggestedAmount / 100).toFixed(2))}
                className="text-xs text-primary hover:underline"
              >
                Use suggested: {formatCents(suggestedAmount, currency)}
              </button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">Note (optional)</Label>
            <Input
              id="note"
              placeholder="e.g., Venmo, cash"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {settle.error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {settle.error.message}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={settle.isPending}>
            {settle.isPending ? "Recording..." : "Record Payment"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
