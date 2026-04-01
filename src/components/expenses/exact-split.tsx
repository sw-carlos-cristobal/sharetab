"use client";

import { useEffect, useState } from "react";
import { formatCents, parseToCents } from "@/lib/money";
import { Input } from "@/components/ui/input";

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number };

export function ExactSplit({
  members,
  totalCents,
  onChange,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  useEffect(() => {
    const shares: ShareEntry[] = [];
    for (const m of members) {
      const cents = parseToCents(amounts[m.id] ?? "0");
      if (cents > 0) {
        shares.push({ userId: m.id, amount: cents });
      }
    }
    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amounts]);

  function setAmount(id: string, value: string) {
    setAmounts((prev) => ({ ...prev, [id]: value }));
  }

  const allocated = members.reduce(
    (sum, m) => sum + parseToCents(amounts[m.id] ?? "0"),
    0
  );
  const remaining = totalCents - allocated;

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
          <span className="flex-1 text-sm">{m.name ?? "Unnamed"}</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            className="w-28"
            value={amounts[m.id] ?? ""}
            onChange={(e) => setAmount(m.id, e.target.value)}
          />
        </div>
      ))}
      <p
        className={`text-xs ${
          remaining === 0
            ? "text-green-600"
            : remaining > 0
              ? "text-amber-600"
              : "text-destructive"
        }`}
      >
        {remaining === 0
          ? "Fully allocated"
          : remaining > 0
            ? `${formatCents(remaining)} remaining`
            : `${formatCents(-remaining)} over-allocated`}
      </p>
    </div>
  );
}
