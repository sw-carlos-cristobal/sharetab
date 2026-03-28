"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import { Input } from "@/components/ui/input";

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; shares: number };

export function SharesSplit({
  members,
  totalCents,
  onChange,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
}) {
  const [shareUnits, setShareUnits] = useState<Record<string, string>>(
    () => Object.fromEntries(members.map((m) => [m.id, "1"]))
  );

  useEffect(() => {
    const entries = members
      .map((m) => ({
        userId: m.id,
        units: parseInt(shareUnits[m.id] ?? "0") || 0,
      }))
      .filter((e) => e.units > 0);

    const totalUnits = entries.reduce((sum, e) => sum + e.units, 0);
    if (totalUnits === 0 || totalCents <= 0) {
      onChange([]);
      return;
    }

    let allocated = 0;
    const shares: ShareEntry[] = entries.map((entry, i) => {
      let amount: number;
      if (i === entries.length - 1) {
        amount = totalCents - allocated;
      } else {
        amount = Math.round((totalCents * entry.units) / totalUnits);
        allocated += amount;
      }
      return { userId: entry.userId, amount, shares: entry.units };
    });

    onChange(shares);
  }, [shareUnits, totalCents, members, onChange]);

  function setUnits(id: string, value: string) {
    setShareUnits((prev) => ({ ...prev, [id]: value }));
  }

  const totalUnits = members.reduce(
    (sum, m) => sum + (parseInt(shareUnits[m.id] ?? "0") || 0),
    0
  );

  return (
    <div className="space-y-2">
      {members.map((m) => {
        const units = parseInt(shareUnits[m.id] ?? "0") || 0;
        const share = totalUnits > 0 ? Math.round((totalCents * units) / totalUnits) : 0;
        return (
          <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
            <span className="flex-1 text-sm">{m.name ?? "Unnamed"}</span>
            <Input
              type="number"
              step="1"
              min="0"
              placeholder="1"
              className="w-20"
              value={shareUnits[m.id] ?? ""}
              onChange={(e) => setUnits(m.id, e.target.value)}
            />
            <span className="text-xs text-muted-foreground">shares</span>
            {units > 0 && totalCents > 0 && (
              <span className="w-20 text-right text-xs text-muted-foreground">
                {formatCents(share)}
              </span>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Total: {totalUnits} share{totalUnits !== 1 ? "s" : ""}
      </p>
    </div>
  );
}
