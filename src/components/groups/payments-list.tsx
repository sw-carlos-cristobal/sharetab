'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowRight, Handshake, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

type PendingDelete = { id: string; from: string; to: string; amount: string; date: string };

/**
 * Payments recorded with Settle up, newest first. The payer, or a group
 * owner/admin, can delete a mistaken one (#261). Renders nothing until the
 * group has a payment.
 */
export function PaymentsList({
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
  const tc = useTranslations('common');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<PendingDelete | null>(null);

  const payments = trpc.settlements.list.useInfiniteQuery(
    { groupId, limit: 10 },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, initialCursor: undefined },
  );

  const remove = trpc.settlements.delete.useMutation({
    onSuccess: () => {
      toast.success(t('payments.deleted'));
      setPending(null);
      void utils.settlements.list.invalidate({ groupId });
      void utils.balances.getGroupBalances.invalidate({ groupId });
      void utils.balances.getSimplifiedDebts.invalidate({ groupId });
      void utils.balances.getDashboard.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const items = payments.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return null;

  return (
    <div data-testid="payments-section">
      <h2 className="mb-4 text-lg font-semibold">{t('payments.title')}</h2>
      <Card className="divide-y divide-border overflow-hidden">
        {items.map((p, index) => {
          const from = p.from.name ?? p.from.email ?? t('detail.unknown');
          const to = p.to.name ?? p.to.email ?? t('detail.unknown');
          // Same rule as the expense list: a payment in the group's currency has no base amount
          const amount = formatCents(p.amount, p.baseCurrencyAmount != null ? p.currency : groupCurrency, locale);
          const date = new Date(p.settledAt).toLocaleDateString(locale);
          const canDelete = !archived && (isOwnerOrAdmin || p.fromId === currentUserId);
          return (
            <div
              key={p.id}
              className={`flex items-center justify-between px-4 py-3 ${index % 2 === 1 ? 'bg-muted/20' : ''}`}
              data-testid="payment-row"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent">
                  <Handshake className="h-3.5 w-3.5 text-accent-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="flex min-w-0 items-center gap-1.5 font-medium">
                    <span className="truncate">{from}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{to}</span>
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {date}
                    {p.note && ` · ${p.note}`}
                  </p>
                </div>
              </div>
              <div className="ml-4 flex shrink-0 items-center gap-2">
                <p className="text-lg font-semibold tabular-nums">{amount}</p>
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('payments.deleteLabel', { from, to, amount })}
                    onClick={() => setPending({ id: p.id, from, to, amount, date })}
                    data-testid="delete-payment"
                  >
                    <Trash2 className="h-4 w-4" />
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
          {t('payments.showMore')}
        </Button>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('payments.deleteTitle')}</DialogTitle>
            {pending && (
              <DialogDescription>
                {t('payments.deleteDescription', {
                  from: pending.from,
                  to: pending.to,
                  amount: pending.amount,
                  date: pending.date,
                })}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              {tc('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => pending && remove.mutate({ groupId, settlementId: pending.id })}
              data-testid="confirm-delete-payment"
            >
              {remove.isPending ? t('payments.deleting') : tc('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
