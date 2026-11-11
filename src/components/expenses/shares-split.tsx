'use client';

import { useEffect, useState } from 'react';
import { currencyStep, formatCents } from '@/lib/money';
import { sharesSplitShares } from '@/lib/expense-split';
import { Input } from '@/components/ui/input';

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; shares: number };

export function SharesSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
  initialShareUnits,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
  /** Initial share-unit strings per user ID (e.g. when editing an existing expense). */
  initialShareUnits?: Record<string, string>;
}) {
  const [shareUnits, setShareUnits] = useState<Record<string, string>>(
    () => initialShareUnits ?? Object.fromEntries(members.map((m) => [m.id, '1'])),
  );

  const unitsOf = (id: string) => parseInt(shareUnits[id] ?? '0') || 0;
  // Each row shows the amount that's saved, leftover cents included (#331), in whole units in a
  // currency with no decimals (#335)
  const step = currencyStep(currency);
  const shares: ShareEntry[] = sharesSplitShares(
    totalCents,
    members.map((m) => ({ userId: m.id, units: unitsOf(m.id) })),
    step,
  );

  useEffect(() => {
    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareUnits, totalCents, step]);

  function setUnits(id: string, value: string) {
    setShareUnits((prev) => ({ ...prev, [id]: value }));
  }

  const totalUnits = members.reduce((sum, m) => sum + unitsOf(m.id), 0);
  const amounts = new Map(shares.map((s) => [s.userId, s.amount]));

  return (
    <div className="space-y-2">
      {members.map((m) => {
        const share = amounts.get(m.id);
        return (
          <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
            <span className="flex-1 text-sm">{m.name ?? 'Unnamed'}</span>
            <Input
              type="number"
              step="1"
              min="0"
              placeholder="1"
              className="w-20"
              value={shareUnits[m.id] ?? ''}
              onChange={(e) => setUnits(m.id, e.target.value)}
            />
            <span className="text-xs text-muted-foreground">shares</span>
            {share !== undefined && (
              <span className="w-20 text-right text-xs text-muted-foreground">
                {formatCents(share, currency, locale)}
              </span>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Total: {totalUnits} share{totalUnits !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
