'use client';

import { useEffect, useState } from 'react';
import { currencyStep, formatCents } from '@/lib/money';
import { evenPercentages, percentageSplitShares, percentTolerance } from '@/lib/expense-split';
import { Input } from '@/components/ui/input';

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; percentage: number };

export function PercentageSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
  initialPercentages,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
  /** Initial percentage strings per user ID (e.g. when editing an existing expense). */
  initialPercentages?: Record<string, string>;
}) {
  const [percentages, setPercentages] = useState<Record<string, string>>(() => {
    if (initialPercentages) return initialPercentages;
    // Pre-fill equal percentages so switching from Equal mode isn't jarring. They add up to
    // exactly 100, no one more than 0.01% above anyone else (#331).
    const even = evenPercentages(members.length);
    return Object.fromEntries(members.map((m, i) => [m.id, even[i]!]));
  });

  const pctOf = (id: string) => parseFloat(percentages[id] ?? '0') || 0;
  // Null until the percentages add up to 100%: no shares are reported, which keeps the submit
  // button disabled, and each row shows its percentage of the total as typed. Whole units in a
  // currency with no decimals (#335)
  const step = currencyStep(currency);
  const shares: ShareEntry[] | null = percentageSplitShares(
    totalCents,
    members.map((m) => ({ userId: m.id, pct: pctOf(m.id) })),
    step,
  );

  useEffect(() => {
    onChange(shares ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percentages, totalCents, step]);

  function setPct(id: string, value: string) {
    setPercentages((prev) => ({ ...prev, [id]: value }));
  }

  const totalPct = members.reduce((sum, m) => sum + pctOf(m.id), 0);
  // Mirror percentageSplitShares: only non-zero entries carry rounding drift.
  const participatingCount = members.filter((m) => pctOf(m.id) > 0).length;
  // Once the split is valid, each row shows the amount that's saved, leftover cents included
  const amounts = shares && new Map(shares.map((s) => [s.userId, s.amount]));

  return (
    <div className="space-y-2">
      {members.map((m) => {
        const pct = pctOf(m.id);
        const share = amounts ? (amounts.get(m.id) ?? 0) : Math.round((totalCents * pct) / 100);
        return (
          <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
            <span className="flex-1 text-sm">{m.name ?? 'Unnamed'}</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="0"
                className="w-20"
                value={percentages[m.id] ?? ''}
                onChange={(e) => setPct(m.id, e.target.value)}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {pct > 0 && totalCents > 0 && (
              <span className="w-20 text-right text-xs text-muted-foreground">
                {formatCents(share, currency, locale)}
              </span>
            )}
          </div>
        );
      })}
      <p
        className={`text-xs ${
          Math.abs(totalPct - 100) < percentTolerance(participatingCount) ? 'text-green-600' : 'text-amber-600'
        }`}
      >
        Total: {totalPct.toFixed(1)}%
        {Math.abs(totalPct - 100) >= percentTolerance(participatingCount) && ` (should be 100%)`}
      </p>
    </div>
  );
}
