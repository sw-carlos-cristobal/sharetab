'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

/**
 * The group's deleted expenses and payments (#327), closed until asked for. An expense
 * opens its page, which offers Restore; a payment has no page, so it's restored here, by
 * its payer or a group owner/admin, as it was deleted. An archived group refuses restores.
 */
export function DeletedRecords({
  groupId,
  groupCurrency,
  currentUserId,
  isOwnerOrAdmin,
  archived,
}: {
  groupId: string;
  groupCurrency: string;
  currentUserId: string | undefined;
  isOwnerOrAdmin: boolean;
  archived: boolean;
}) {
  const t = useTranslations('groups');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);

  const expenses = trpc.expenses.list.useInfiniteQuery(
    { groupId, limit: 10, deleted: true },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, enabled: open },
  );
  const payments = trpc.settlements.list.useInfiniteQuery(
    { groupId, limit: 10, deleted: true },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, initialCursor: undefined, enabled: open },
  );

  const restore = trpc.settlements.restore.useMutation({
    onSuccess: () => {
      toast.success(t('deleted.paymentRestored'));
      void utils.settlements.list.invalidate({ groupId });
      void utils.balances.getGroupBalances.invalidate({ groupId });
      void utils.balances.getSimplifiedDebts.invalidate({ groupId });
      void utils.balances.getDashboard.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const expenseItems = expenses.data?.pages.flatMap((page) => page.expenses) ?? [];
  const paymentItems = payments.data?.pages.flatMap((page) => page.items) ?? [];
  const loaded = expenses.isSuccess && payments.isSuccess;
  const deletedLine = (deletedAt: Date | null, deletedBy: { name: string | null } | null) => {
    const date = deletedAt ? new Date(deletedAt).toLocaleDateString(locale) : '';
    return deletedBy?.name ? t('deleted.deletedBy', { name: deletedBy.name, date }) : t('deleted.deletedOn', { date });
  };

  return (
    <div data-testid="deleted-section">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronRight className="mr-1 h-4 w-4" />}
        {t('deleted.title')}
      </Button>

      {open && (
        <div className="mt-2 space-y-4">
          {loaded && expenseItems.length === 0 && paymentItems.length === 0 && (
            <p className="px-3 text-sm text-muted-foreground">{t('deleted.empty')}</p>
          )}
          {(expenses.isError || payments.isError) && (
            <p role="alert" className="px-3 text-sm text-destructive">
              {(expenses.error ?? payments.error)?.message}
            </p>
          )}

          {expenseItems.length > 0 && (
            <div>
              <h3 className="mb-2 px-3 text-sm font-medium text-muted-foreground">{t('deleted.expenses')}</h3>
              <Card className="divide-y divide-border overflow-hidden">
                {expenseItems.map((expense) => (
                  <Link
                    key={expense.id}
                    href={`/groups/${groupId}/expenses/${expense.id}`}
                    className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-muted/50"
                    data-testid="deleted-expense-row"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{expense.title}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {deletedLine(expense.deletedAt, expense.deletedBy)}
                      </p>
                    </div>
                    <p className="ml-4 shrink-0 font-semibold tabular-nums text-muted-foreground">
                      {formatCents(
                        expense.amount,
                        expense.baseCurrencyAmount != null ? expense.currency : groupCurrency,
                        locale,
                      )}
                    </p>
                  </Link>
                ))}
              </Card>
              {expenses.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  disabled={expenses.isFetchingNextPage}
                  onClick={() => void expenses.fetchNextPage()}
                >
                  {t('deleted.showMore')}
                </Button>
              )}
            </div>
          )}

          {paymentItems.length > 0 && (
            <div>
              <h3 className="mb-2 px-3 text-sm font-medium text-muted-foreground">{t('deleted.payments')}</h3>
              <Card className="divide-y divide-border overflow-hidden">
                {paymentItems.map((p) => {
                  const from = p.from.name ?? p.from.email ?? t('detail.unknown');
                  const to = p.to.name ?? p.to.email ?? t('detail.unknown');
                  // Same rule as the payments list: one in the group's currency has no base amount
                  const amount = formatCents(
                    p.amount,
                    p.baseCurrencyAmount != null ? p.currency : groupCurrency,
                    locale,
                  );
                  const canRestore = !archived && (isOwnerOrAdmin || p.fromId === currentUserId);
                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between px-4 py-3"
                      data-testid="deleted-payment-row"
                    >
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-center gap-1.5 font-medium">
                          <span className="truncate">{from}</span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{to}</span>
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {deletedLine(p.deletedAt, p.deletedBy)}
                        </p>
                      </div>
                      <div className="ml-4 flex shrink-0 items-center gap-2">
                        <p className="font-semibold tabular-nums text-muted-foreground">{amount}</p>
                        {canRestore && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('deleted.restorePaymentLabel', { from, to, amount })}
                            disabled={restore.isPending}
                            onClick={() => restore.mutate({ groupId, settlementId: p.id })}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            {t('deleted.restore')}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Card>
              {payments.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  disabled={payments.isFetchingNextPage}
                  onClick={() => void payments.fetchNextPage()}
                >
                  {t('deleted.showMore')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
