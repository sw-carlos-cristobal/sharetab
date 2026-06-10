"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import { Input } from "@/components/ui/input";

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; percentage: number };

// Acceptable deviation from 100%: the equal prefill rounds each member's
// percentage to 2 decimals, so the sum can legitimately drift by up to
// 0.005 per member (e.g. 19 x 5.26 = 99.94). Floor of 0.05 for tiny groups.
function percentTolerance(memberCount: number): number {
  return Math.max(0.05, memberCount * 0.005 + 0.001);
}

export function PercentageSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
}) {
  const [percentages, setPercentages] = useState<Record<string, string>>(() => {
    // Pre-fill equal percentages so switching from Equal mode isn't jarring
    const pct = members.length > 0 ? (100 / members.length).toFixed(2) : "0";
    return Object.fromEntries(members.map((m) => [m.id, pct]));
  });

  useEffect(() => {
    const shares: ShareEntry[] = [];
    let allocated = 0;

    const entries = members
      .map((m) => ({
        userId: m.id,
        pct: parseFloat(percentages[m.id] ?? "0") || 0,
      }))
      .filter((e) => e.pct > 0);

    // Only emit shares when percentages sum to ~100%. Otherwise the
    // last-person remainder would silently absorb the entire shortfall
    // (e.g. 30%/30% of $100 would submit $30/$70). Reporting no shares
    // keeps the submit button disabled until the split is valid.
    // Tolerance scales with member count: the equal prefill rounds each
    // entry to 2 decimals (toFixed(2)), so legitimate drift is up to
    // 0.005% per member (19 members -> 99.94, 24 -> 100.08).
    const totalPct = entries.reduce((sum, e) => sum + e.pct, 0);
    if (Math.abs(totalPct - 100) >= percentTolerance(members.length)) {
      onChange([]);
      return;
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const basisPoints = Math.round(entry.pct * 100); // 50.00% = 5000
      let amount: number;

      if (i === entries.length - 1) {
        // Last person gets the remainder to avoid rounding issues
        amount = totalCents - allocated;
      } else {
        amount = Math.round((totalCents * entry.pct) / 100);
        allocated += amount;
      }

      if (amount > 0) {
        shares.push({ userId: entry.userId, amount, percentage: basisPoints });
      }
    }

    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percentages, totalCents]);

  function setPct(id: string, value: string) {
    setPercentages((prev) => ({ ...prev, [id]: value }));
  }

  const totalPct = members.reduce(
    (sum, m) => sum + (parseFloat(percentages[m.id] ?? "0") || 0),
    0
  );

  return (
    <div className="space-y-2">
      {members.map((m) => {
        const pct = parseFloat(percentages[m.id] ?? "0") || 0;
        const share = Math.round((totalCents * pct) / 100);
        return (
          <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
            <span className="flex-1 text-sm">{m.name ?? "Unnamed"}</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="0"
                className="w-20"
                value={percentages[m.id] ?? ""}
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
          Math.abs(totalPct - 100) < percentTolerance(members.length)
            ? "text-green-600"
            : "text-amber-600"
        }`}
      >
        Total: {totalPct.toFixed(1)}%
        {Math.abs(totalPct - 100) >= percentTolerance(members.length) && ` (should be 100%)`}
      </p>
    </div>
  );
}
