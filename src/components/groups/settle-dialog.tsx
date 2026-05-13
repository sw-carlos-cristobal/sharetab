"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
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
  const locale = useLocale();
  const t = useTranslations("groups");
  const [fromId, setFromId] = useState(suggestedFrom ?? "");
  const [toId, setToId] = useState(suggestedTo ?? "");
  const [amountStr, setAmountStr] = useState(
    suggestedAmount ? (suggestedAmount / 100).toFixed(2) : ""
  );
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setFromId(suggestedFrom ?? "");
      setToId(suggestedTo ?? "");
      setAmountStr(suggestedAmount ? (suggestedAmount / 100).toFixed(2) : "");
      setNote("");
    }
  }, [open, suggestedFrom, suggestedTo, suggestedAmount]);

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
    settle.mutate({ groupId, fromId: fromId || undefined, toId, amount, currency, note: note || undefined });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settle.title")}</DialogTitle>
          <DialogDescription>
            {t("settle.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="from">{t("settle.from")}</Label>
            <select
              id="from"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">{t("settle.selectMember")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? t("settle.unnamed")}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="to">{t("settle.to")}</Label>
            <select
              id="to"
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">{t("settle.selectMember")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? t("settle.unnamed")}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settle-amount">{t("settle.amount")}</Label>
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
                {t("settle.useSuggested", { amount: formatCents(suggestedAmount, currency, locale) })}
              </button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">{t("settle.note")}</Label>
            <Input
              id="note"
              placeholder={t("settle.notePlaceholder")}
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
            {settle.isPending ? t("settle.submitting") : t("settle.submit")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
