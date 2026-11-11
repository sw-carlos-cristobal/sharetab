'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { amountInputStep, centsToDecimal, currencyStep, formatCents, parseToCents } from '@/lib/money';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Member = { id: string; name: string | null };

export function SettleDialog({
  groupId,
  members,
  payerId,
  suggestedFrom,
  suggestedTo,
  suggestedAmount,
  currency,
  open,
  onOpenChange,
}: {
  groupId: string;
  members: Member[];
  /** Fixes From to this person, shown rather than chosen: a plain member may record only
   * payments they made, and the server refuses any other (#341) */
  payerId?: string;
  suggestedFrom?: string;
  suggestedTo?: string;
  suggestedAmount?: number;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('groups');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settle.title')}</DialogTitle>
          <DialogDescription>{t('settle.description')}</DialogDescription>
        </DialogHeader>

        {/* Mounted only while open so each open starts from the current
            suggestions (fresh useState initializers — no reset effect). */}
        {open && (
          <SettleForm
            groupId={groupId}
            members={members}
            {...(payerId !== undefined ? { payerId } : {})}
            {...(suggestedFrom !== undefined ? { suggestedFrom } : {})}
            {...(suggestedTo !== undefined ? { suggestedTo } : {})}
            {...(suggestedAmount !== undefined ? { suggestedAmount } : {})}
            currency={currency}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettleForm({
  groupId,
  members,
  payerId,
  suggestedFrom,
  suggestedTo,
  suggestedAmount,
  currency,
  onOpenChange,
}: {
  groupId: string;
  members: Member[];
  payerId?: string;
  suggestedFrom?: string;
  suggestedTo?: string;
  suggestedAmount?: number;
  currency: string;
  onOpenChange: (open: boolean) => void;
}) {
  const locale = useLocale();
  const t = useTranslations('groups');
  const [fromId, setFromId] = useState(payerId ?? suggestedFrom ?? '');
  const [toId, setToId] = useState(suggestedTo ?? '');
  // In the currency's decimals: "333" for a ¥333 debt (#335). A debt with hundredths in a
  // currency that has none (left by amounts saved before #335, or a receipt expense's shares) is
  // offered as it is, "333.33", since no whole amount could pay it off: the server takes a payment
  // with hundredths only when it is a debt the group page lists, all the payer owes, or all the
  // payee is owed, and refuses any other with a message shown below
  const exactSuggestion = suggestedAmount !== undefined && suggestedAmount % currencyStep(currency) !== 0;
  const fieldCurrency = exactSuggestion ? undefined : currency;
  const [amountStr, setAmountStr] = useState(suggestedAmount ? centsToDecimal(suggestedAmount, fieldCurrency) : '');
  const [note, setNote] = useState('');

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

  // A fixed payer wins over the one picked, even when it arrives while the dialog is
  // open (its owner became a member), so what is sent is what From shows.
  const effectiveFromId = payerId ?? fromId;

  // The server refuses a payment from someone to themselves; say so before sending it.
  const samePerson = effectiveFromId !== '' && effectiveFromId === toId;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseToCents(amountStr, fieldCurrency);
    if (!toId || amount <= 0 || samePerson) return;
    settle.mutate({
      groupId,
      fromId: effectiveFromId || undefined,
      toId,
      amount,
      currency,
      note: note || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="from">{t('settle.from')}</Label>
        {payerId !== undefined ? (
          <Input id="from" readOnly value={members.find((m) => m.id === payerId)?.name ?? t('settle.unnamed')} />
        ) : (
          <select
            id="from"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            required
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">{t('settle.selectMember')}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? t('settle.unnamed')}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="to">{t('settle.to')}</Label>
        <select
          id="to"
          value={toId}
          onChange={(e) => setToId(e.target.value)}
          required
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">{t('settle.selectMember')}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? t('settle.unnamed')}
            </option>
          ))}
        </select>
        {samePerson && (
          <p className="text-sm text-destructive" data-testid="settle-same-person">
            {t('settle.samePerson')}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="settle-amount">{t('settle.amount')}</Label>
        <Input
          id="settle-amount"
          type="number"
          step={amountInputStep(fieldCurrency)}
          min={amountInputStep(fieldCurrency)}
          placeholder={centsToDecimal(0, currency)}
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          required
        />
        {suggestedAmount && (
          <button
            type="button"
            onClick={() => setAmountStr(centsToDecimal(suggestedAmount, fieldCurrency))}
            className="text-xs text-primary hover:underline"
          >
            {t('settle.useSuggested', { amount: formatCents(suggestedAmount, currency, locale) })}
          </button>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="note">{t('settle.note')}</Label>
        <Input
          id="note"
          placeholder={t('settle.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {settle.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{settle.error.message}</div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={settle.isPending || samePerson}
        data-testid="record-payment-btn"
      >
        {settle.isPending ? t('settle.submitting') : t('settle.submit')}
      </Button>
    </form>
  );
}
