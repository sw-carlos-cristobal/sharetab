"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import { Input } from "@/components/ui/input";

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; percentage: number };

// Acceptable deviation from 100%. The equal prefill is normalized to sum to
// exactly 100, but splits seeded from saved expenses carry stored percentages
// (basis points) that can drift by up to 0.005 per member from rounding, so
// the tolerance scales accordingly. The monetary skew this admits is bounded
// at 0.005% of the total per member — rounding dust, absorbed by the last
// share like all other rounding in this component.
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
    // Pre-fill equal percentages so switching from Equal mode isn't jarring.
    // The last member absorbs the rounding difference so the prefill sums to
    // exactly 100 (e.g. 19 members: 18 x 5.26 + 5.32) — the validation
    // tolerance never has to accommodate generated values.
    if (members.length === 0) return {};
    const per = Math.floor(10000 / members.length) / 100;
    const last = Math.round((100 - per * (members.length - 1)) * 100) / 100;
    return Object.fromEntries(
      members.map((m, i) => [
        m.id,
        String(i === members.length - 1 ? last : per),
      ])
    );
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
    // Tolerance scales with the number of participating (non-zero) members
    // to accept splits whose stored 2-decimal percentages carry rounding
    // drift of up to 0.005 per member (see percentTolerance above) — zero
    // entries contribute no drift, so counting them would over-widen the
    // tolerance in large groups. The equal prefill itself is normalized to
    // sum to exactly 100 and needs no tolerance.
    const totalPct = entries.reduce((sum, e) => sum + e.pct, 0);
    if (Math.abs(totalPct - 100) >= percentTolerance(entries.length)) {
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
  // Mirror the emit logic: only non-zero entries carry rounding drift.
  const participatingCount = members.filter(
    (m) => (parseFloat(percentages[m.id] ?? "0") || 0) > 0
  ).length;

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
          Math.abs(totalPct - 100) < percentTolerance(participatingCount)
            ? "text-green-600"
            : "text-amber-600"
        }`}
      >
        Total: {totalPct.toFixed(1)}%
        {Math.abs(totalPct - 100) >= percentTolerance(participatingCount) && ` (should be 100%)`}
      </p>
    </div>
  );
}
