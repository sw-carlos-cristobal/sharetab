"use client";

import { useEffect, useState } from "react";
import { formatCents } from "@/lib/money";

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number };

export function EqualSplit({
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
  const [selected, setSelected] = useState<Set<string>>(
    new Set(members.map((m) => m.id))
  );

  useEffect(() => {
    if (selected.size === 0 || totalCents <= 0) {
      onChange([]);
      return;
    }

    const perPerson = Math.floor(totalCents / selected.size);
    const remainder = totalCents - perPerson * selected.size;
    const selectedArr = Array.from(selected);

    const shares: ShareEntry[] = selectedArr.map((userId, i) => ({
      userId,
      amount: perPerson + (i < remainder ? 1 : 0),
    }));

    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, totalCents]);

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
            <span className="text-sm">{m.name ?? "Unnamed"}</span>
          </div>
          {selected.has(m.id) && totalCents > 0 && (
            <span className="text-sm text-muted-foreground">
              {formatCents(Math.round(perPerson), currency, locale)}
            </span>
          )}
        </label>
      ))}
      {selected.size > 0 && totalCents > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatCents(Math.round(perPerson), currency, locale)} per person
          ({selected.size} selected)
        </p>
      )}
    </div>
  );
}
