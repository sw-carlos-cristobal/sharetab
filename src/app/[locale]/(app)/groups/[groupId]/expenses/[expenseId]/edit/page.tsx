"use client";

import { use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/router";
import { trpc } from "@/lib/trpc";
import { parseToCents, centsToDecimal, formatCents } from "@/lib/money";
import { COMMON_CURRENCIES } from "@/lib/currencies";
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

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ExpenseData = RouterOutputs["expenses"]["get"];
type GroupData = NonNullable<RouterOutputs["groups"]["get"]>;

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
  const t = useTranslations("expenses");
  const group = trpc.groups.get.useQuery({ groupId });
  const expense = trpc.expenses.get.useQuery({ groupId, expenseId });

  if (expense.isLoading || group.isLoading) {
    return <LoadingSpinner />;
  }
  if (!expense.data || !group.data) {
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

  return (
    <EditExpenseForm
      groupId={groupId}
      expenseId={expenseId}
      expense={expense.data}
      group={group.data}
    />
  );
}

// Rendered only once expense + group data is available, so all form state can
// be initialized directly from the loaded data (no sync-from-query effects).
function EditExpenseForm({
  groupId,
  expenseId,
  expense,
  group,
}: {
  groupId: string;
  expenseId: string;
  expense: ExpenseData;
  group: GroupData;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("expenses");

  const splitModes = useMemo(() => [
    { value: "EQUAL" as SplitMode, label: t("new.splitEqual"), description: t("new.splitEqualDescription") },
    { value: "EXACT" as SplitMode, label: t("new.splitExact"), description: t("new.splitExactDescription") },
    { value: "PERCENTAGE" as SplitMode, label: t("new.splitPercentage"), description: t("new.splitPercentageDescription") },
    { value: "SHARES" as SplitMode, label: t("new.splitShares"), description: t("new.splitSharesDescription") },
  ], [t]);

  const isItemSplit = expense.splitMode === "ITEM";
  const initiallyDifferentCurrency =
    expense.currency.toUpperCase() !== group.currency.toUpperCase();

  const [title, setTitle] = useState(expense.title);
  const [amountStr, setAmountStr] = useState(() => centsToDecimal(expense.amount));
  const [category, setCategory] = useState(expense.category ?? "");
  // The saved payer may have left the group (member removal preserves
  // financial history). Server-side membership validation would reject the
  // stale id, so start empty and force the user to pick a current member.
  const [paidById, setPaidById] = useState(() =>
    group.members.some((m) => m.user.id === expense.paidById)
      ? expense.paidById
      : ""
  );
  const [splitMode, setSplitMode] = useState<SplitMode>(
    isItemSplit ? "EQUAL" : (expense.splitMode as SplitMode)
  );
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [currency, setCurrency] = useState<string>(expense.currency);
  const [manualRate, setManualRate] = useState<string>(
    initiallyDifferentCurrency && expense.exchangeRate ? String(expense.exchangeRate) : ""
  );
  const [useManualRate, setUseManualRate] = useState(
    initiallyDifferentCurrency && !!expense.exchangeRate
  );

  // Seed the split editors with the saved shares so editing doesn't silently
  // rewrite the split. Only the saved mode is seeded; other modes keep their
  // new-expense defaults. (percentage is stored in basis points: 5000 = 50%)
  // Saved shares can reference users who have since left the group (member
  // removal preserves financial history). The editors only render current
  // members, so a hidden ex-member id would be unremovable and make every
  // save fail server-side membership validation. The ex-member portion is
  // reassigned to the payer when they're still a member (creating an entry
  // for them if needed), otherwise to the first remaining share-holder, or
  // the first current member when no saved shares survive at all — so EXACT
  // amounts still sum to the total and PERCENTAGE still sums to 100, keeping
  // the expense saveable — and a warning banner tells the user to review it.
  const { savedShares, hasFormerMemberShares } = useMemo(() => {
    const currentMemberIds = new Set(group.members.map((m) => m.user.id));
    const toSeed = (s: ExpenseData["shares"][number]): ShareEntry => ({
      userId: s.userId,
      amount: s.amount,
      ...(s.percentage != null ? { percentage: s.percentage } : {}),
      ...(s.shares != null ? { shares: s.shares } : {}),
    });
    const kept = expense.shares
      .filter((s) => currentMemberIds.has(s.userId))
      .map(toSeed);
    const dropped = expense.shares.filter((s) => !currentMemberIds.has(s.userId));
    if (dropped.length === 0) {
      return { savedShares: kept, hasFormerMemberShares: false };
    }
    const droppedAmount = dropped.reduce((sum, s) => sum + s.amount, 0);
    const droppedPct = dropped.reduce((sum, s) => sum + (s.percentage ?? 0), 0);
    const droppedUnits = dropped.reduce((sum, s) => sum + (s.shares ?? 0), 0);
    const targetId = currentMemberIds.has(expense.paidById)
      ? expense.paidById
      : kept[0]?.userId ?? group.members[0]?.user.id;
    if (!targetId) {
      return { savedShares: kept, hasFormerMemberShares: true };
    }
    const target = kept.find((s) => s.userId === targetId);
    if (!target) {
      return {
        savedShares: [
          ...kept,
          {
            userId: targetId,
            amount: droppedAmount,
            ...(droppedPct > 0 ? { percentage: droppedPct } : {}),
            ...(droppedUnits > 0 ? { shares: droppedUnits } : {}),
          },
        ],
        hasFormerMemberShares: true,
      };
    }
    return {
      savedShares: kept.map((s) =>
        s === target
          ? {
              ...s,
              amount: s.amount + droppedAmount,
              percentage:
                s.percentage != null || droppedPct > 0
                  ? (s.percentage ?? 0) + droppedPct
                  : s.percentage,
              shares: (s.shares ?? 1) + droppedUnits,
            }
          : s
      ),
      hasFormerMemberShares: true,
    };
  }, [expense, group]);
  const initialSelected = useMemo(
    () =>
      expense.splitMode === "EQUAL" && savedShares.length > 0
        ? savedShares.map((s) => s.userId)
        : undefined,
    [expense, savedShares]
  );
  const initialAmounts = useMemo(
    () =>
      expense.splitMode === "EXACT" && savedShares.length > 0
        ? Object.fromEntries(
            savedShares.map((s) => [s.userId, centsToDecimal(s.amount)])
          )
        : undefined,
    [expense, savedShares]
  );
  const initialPercentages = useMemo(
    () =>
      expense.splitMode === "PERCENTAGE" && savedShares.length > 0
        ? Object.fromEntries(
            savedShares.map((s) => [
              s.userId,
              s.percentage != null ? String(s.percentage / 100) : "0",
            ])
          )
        : undefined,
    [expense, savedShares]
  );
  const initialShareUnits = useMemo(
    () =>
      expense.splitMode === "SHARES" && savedShares.length > 0
        ? Object.fromEntries(
            savedShares.map((s) => [s.userId, String(s.shares ?? 1)])
          )
        : undefined,
    [expense, savedShares]
  );

  const updateExpense = trpc.expenses.update.useMutation({
    onSuccess: () => {
      router.push(`/groups/${groupId}/expenses/${expenseId}`);
    },
  });

  const members: MemberInfo[] = group.members.map((m) => ({
    id: m.user.id,
    name: m.user.placeholderName ?? m.user.name ?? m.user.email,
  }));

  const amountCents = parseToCents(amountStr);
  const groupCurrency = group.currency;
  const effectiveCurrency = currency || groupCurrency;
  const isDifferentCurrency = effectiveCurrency.toUpperCase() !== groupCurrency.toUpperCase();
  const parsedManualRate = parseFloat(manualRate);
  const manualRateValid = useManualRate && !isNaN(parsedManualRate) && parsedManualRate > 0;
  const currencyChanged = effectiveCurrency.toUpperCase() !== expense.currency.toUpperCase();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || amountCents <= 0 || shares.length === 0) return;

    updateExpense.mutate({
      groupId,
      expenseId,
      title,
      amount: amountCents,
      ...(currencyChanged ? { currency: effectiveCurrency } : {}),
      ...(isDifferentCurrency && manualRateValid ? { exchangeRate: parsedManualRate } : {}),
      category: category || undefined,
      paidById,
      splitMode,
      shares,
    });
  }

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

      {hasFormerMemberShares && (
        <Card className="border-amber-300">
          <CardContent className="py-4 text-sm text-amber-700">
            {t("edit.formerMemberSharesWarning")}
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

            <div className="grid grid-cols-[1fr_auto] gap-2">
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
                <Label htmlFor="currency">{t("new.currency")}</Label>
                <select
                  id="currency"
                  value={effectiveCurrency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setManualRate("");
                    setUseManualRate(false);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {COMMON_CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {isDifferentCurrency && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/50">
                <p className="text-blue-800 dark:text-blue-200">
                  {t("new.differentCurrencyNote", {
                    expenseCurrency: effectiveCurrency,
                    groupCurrency,
                  })}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-blue-700 dark:text-blue-300">
                    <input
                      type="checkbox"
                      checked={useManualRate}
                      onChange={(e) => setUseManualRate(e.target.checked)}
                      className="rounded"
                    />
                    {t("new.manualRateOverride")}
                  </label>
                </div>
                {useManualRate && (
                  <div className="mt-2">
                    <Input
                      type="number"
                      step="any"
                      min="0.000001"
                      placeholder={t("new.exchangeRatePlaceholder", {
                        from: effectiveCurrency,
                        to: groupCurrency,
                      })}
                      value={manualRate}
                      onChange={(e) => setManualRate(e.target.value)}
                    />
                    {manualRateValid && amountCents > 0 && (
                      <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                        {t("new.convertedAmount", {
                          amount: formatCents(
                            Math.round(amountCents * parsedManualRate),
                            groupCurrency,
                            locale
                          ),
                        })}
                      </p>
                    )}
                  </div>
                )}
                {!useManualRate && (
                  <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
                    {t("new.autoRateNote")}
                  </p>
                )}
              </div>
            )}

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
                  currency={effectiveCurrency}
                  initialSelected={initialSelected}
                />
              )}
              {splitMode === "EXACT" && (
                <ExactSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                  initialAmounts={initialAmounts}
                />
              )}
              {splitMode === "PERCENTAGE" && (
                <PercentageSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                  initialPercentages={initialPercentages}
                />
              )}
              {splitMode === "SHARES" && (
                <SharesSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                  initialShareUnits={initialShareUnits}
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
