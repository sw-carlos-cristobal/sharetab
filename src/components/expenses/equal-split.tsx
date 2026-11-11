'use client';

import { useEffect, useState } from 'react';
import { currencyStep, formatCents } from '@/lib/money';
import { equalSplitShares } from '@/lib/expense-split';

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number };

export function EqualSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
  initialSelected,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
  /** User IDs to pre-select (e.g. when editing an existing expense). Defaults to all members. */
  initialSelected?: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? members.map((m) => m.id)));

  // Whole units in a currency with no decimals (#335); each row shows the amount that's saved
  const step = currencyStep(currency);
  const shares: ShareEntry[] = equalSplitShares(totalCents, Array.from(selected), step);

  useEffect(() => {
    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, totalCents, step]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const perPerson = selected.size > 0 ? totalCents / selected.size : 0;
  const amounts = new Map(shares.map((s) => [s.userId, s.amount]));

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <label
          key={m.id}
          className="flex cursor-pointer items-center justify-between rounded-md border p-3 hover:bg-muted/50"
        >
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(m.id)}
              onChange={() => toggle(m.id)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm">{m.name ?? 'Unnamed'}</span>
          </div>
          {amounts.has(m.id) && (
            <span className="text-sm text-muted-foreground">{formatCents(amounts.get(m.id)!, currency, locale)}</span>
          )}
        </label>
      ))}
      {selected.size > 0 && totalCents > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatCents(Math.round(perPerson), currency, locale)} per person ({selected.size} selected)
        </p>
      )}
    </div>
  );
}
