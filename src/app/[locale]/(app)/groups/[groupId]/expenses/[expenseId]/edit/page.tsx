"use client";

import { use, useMemo, useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { parseToCents, centsToDecimal } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
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

export default function EditExpensePage({
  params,
}: {
  params: Promise<{ groupId: string; expenseId: string }>;
}) {
  const { groupId, expenseId } = use(params);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("expenses");
  const group = trpc.groups.get.useQuery({ groupId });
  const expense = trpc.expenses.get.useQuery({ groupId, expenseId });

  const splitModes = useMemo(() => [
    { value: "EQUAL" as SplitMode, label: t("new.splitEqual"), description: t("new.splitEqualDescription") },
    { value: "EXACT" as SplitMode, label: t("new.splitExact"), description: t("new.splitExactDescription") },
    { value: "PERCENTAGE" as SplitMode, label: t("new.splitPercentage"), description: t("new.splitPercentageDescription") },
    { value: "SHARES" as SplitMode, label: t("new.splitShares"), description: t("new.splitSharesDescription") },
  ], [t]);

  const [title, setTitle] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [category, setCategory] = useState("");
  const [paidById, setPaidById] = useState("");
  const [splitMode, setSplitMode] = useState<SplitMode>("EQUAL");
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (expense.data && !loaded) {
      const e = expense.data;
      setTitle(e.title);
      setAmountStr(centsToDecimal(e.amount));
      setCategory(e.category ?? "");
      setPaidById(e.paidById);
      if (e.splitMode !== "ITEM") {
        setSplitMode(e.splitMode as SplitMode);
      }
      setLoaded(true);
    }
  }, [expense.data, loaded]);

  const updateExpense = trpc.expenses.update.useMutation({
    onSuccess: () => {
      router.push(`/groups/${groupId}/expenses/${expenseId}`);
    },
  });

  const members: MemberInfo[] =
    group.data?.members.map((m) => ({
      id: m.user.id,
      name: m.user.placeholderName ?? m.user.name ?? m.user.email,
    })) ?? [];

  const amountCents = parseToCents(amountStr);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || amountCents <= 0 || shares.length === 0) return;

    updateExpense.mutate({
      groupId,
      expenseId,
      title,
      amount: amountCents,
      category: category || undefined,
      paidById,
      splitMode,
      shares,
    });
  }

  if (expense.isLoading || group.isLoading) {
    return <LoadingSpinner />;
  }
  if (!expense.data) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <ArrowLeft className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">{t("detail.notFound")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("detail.notFoundDescription")}
        </p>
        <Button nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          {t("detail.backToGroup")}
        </Button>
      </div>
    );
  }

  const isItemSplit = expense.data.splitMode === "ITEM";

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label={t("edit.backToExpense")} nativeButton={false} render={<Link href={`/groups/${groupId}/expenses/${expenseId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t("edit.title")}</h1>
      </div>

      {isItemSplit && (
        <Card className="border-amber-300">
          <CardContent className="py-4 text-sm text-amber-700">
            {t("edit.itemSplitWarning")}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("new.expenseDetails")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">{t("new.description")}</Label>
              <Input
                id="title"
                placeholder={t("new.descriptionPlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">{t("new.amount")}</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                placeholder={t("new.amountPlaceholder")}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">{t("new.category")}</Label>
              <Input
                id="category"
                placeholder={t("new.categoryPlaceholder")}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="paidBy">{t("new.paidBy")}</Label>
              <select
                id="paidBy"
                value={paidById}
                onChange={(e) => setPaidById(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t("new.selectMember")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? t("new.unnamed")}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>{t("new.splitType")}</Label>
              <div className="grid grid-cols-2 gap-2">
                {splitModes.map((mode) => (
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
              <Label>{t("new.splitBetween")}</Label>
              {splitMode === "EQUAL" && (
                <EqualSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={group.data?.currency}
                />
              )}
              {splitMode === "EXACT" && (
                <ExactSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={group.data?.currency}
                />
              )}
              {splitMode === "PERCENTAGE" && (
                <PercentageSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={group.data?.currency}
                />
              )}
              {splitMode === "SHARES" && (
                <SharesSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={group.data?.currency}
                />
              )}
            </div>

            {updateExpense.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {updateExpense.error.message}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={updateExpense.isPending || amountCents <= 0 || shares.length === 0}
            >
              {updateExpense.isPending ? t("edit.submitting") : t("edit.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
