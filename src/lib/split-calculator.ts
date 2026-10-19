/**
 * Pure function to calculate per-person totals with proportional tax/tip distribution.
 * Used by both the authenticated receipt flow and the guest split flow.
 */
export function calculateSplitTotals(params: {
  items: { totalPrice: number }[];
  assignments: { itemIndex: number; personIndices: number[] }[];
  tax: number;
  tip: number;
  peopleCount: number;
  personWeights?: number[]; // weight for each person index (default all 1)
}): { personIndex: number; itemTotal: number; tax: number; tip: number; total: number }[] {
  const { items, assignments, tax, tip, personWeights } = params;

  // Calculate per-person item subtotals
  const personSubtotals = new Map<number, number>();

  for (const assignment of assignments) {
    const item = items[assignment.itemIndex];
    if (!item || assignment.personIndices.length === 0) continue;

    const amounts = splitItemPrice(item.totalPrice, assignment.personIndices, personWeights);
    for (const [i, personIdx] of assignment.personIndices.entries()) {
      personSubtotals.set(personIdx, (personSubtotals.get(personIdx) ?? 0) + amounts[i]!);
    }
  }

  const actualSubtotal = Array.from(personSubtotals.values()).reduce((a, b) => a + b, 0);
  const totalAmount = actualSubtotal + tax + tip;

  const results: { personIndex: number; itemTotal: number; tax: number; tip: number; total: number }[] = [];
  let allocated = 0;
  const entries = Array.from(personSubtotals.entries());

  for (const [i, [personIdx, itemTotal]] of entries.entries()) {
    if (i === entries.length - 1) {
      // Last person gets remainder to prevent off-by-one
      const total = totalAmount - allocated;
      results.push({
        personIndex: personIdx,
        itemTotal,
        tax: total - itemTotal - Math.round(tip * (actualSubtotal > 0 ? itemTotal / actualSubtotal : 0)),
        tip: Math.round(tip * (actualSubtotal > 0 ? itemTotal / actualSubtotal : 0)),
        total,
      });
    } else {
      const proportion = actualSubtotal > 0 ? itemTotal / actualSubtotal : 0;
      const personTax = Math.round(tax * proportion);
      const personTip = Math.round(tip * proportion);
      const total = itemTotal + personTax + personTip;
      results.push({ personIndex: personIdx, itemTotal, tax: personTax, tip: personTip, total });
      allocated += total;
    }
  }

  return results;
}

/**
 * How one item's price is divided among the people on it, in cents, in `personIndices` order.
 * `calculateSplitTotals` adds these up into each person's item total.
 */
function splitItemPrice(totalPrice: number, personIndices: number[], personWeights?: number[]): number[] {
  if (personWeights) {
    // Weighted proportional splitting: each share rounded down, the last person taking what's left
    const totalWeight = itemWeight(personIndices, personWeights);
    let allocated = 0;
    return personIndices.map((personIdx, i) => {
      const amount =
        i === personIndices.length - 1
          ? totalPrice - allocated
          : Math.floor((totalPrice * (personWeights[personIdx] ?? 1)) / totalWeight);
      allocated += amount;
      return amount;
    });
  }
  // Equal splitting (original behavior): the leftover cents go to the first people
  const perPerson = Math.floor(totalPrice / personIndices.length);
  const remainder = totalPrice - perPerson * personIndices.length;
  return personIndices.map((_, i) => perPerson + (i < remainder ? 1 : 0));
}

function itemWeight(personIndices: number[], personWeights: number[]): number {
  return Math.max(
    1,
    personIndices.reduce((sum, pi) => sum + (personWeights[pi] ?? 1), 0),
  );
}

/**
 * The items `personIndex` is on, each with the part of its price they pay (#278): the amounts
 * `calculateSplitTotals` adds up into their item total, so a summary that lists them adds up to
 * it. `share` is that part of the item as a reduced fraction.
 */
export function personItemShares(
  personIndex: number,
  params: Pick<Parameters<typeof calculateSplitTotals>[0], 'items' | 'assignments' | 'personWeights'>,
): { itemIndex: number; amount: number; share: { numerator: number; denominator: number } }[] {
  const { items, assignments, personWeights } = params;
  const shares: ReturnType<typeof personItemShares> = [];
  for (const { itemIndex, personIndices } of assignments) {
    const item = items[itemIndex];
    if (!item || !personIndices.includes(personIndex)) continue;

    const amounts = splitItemPrice(item.totalPrice, personIndices, personWeights);
    let amount = 0;
    let numerator = 0;
    for (const [i, personIdx] of personIndices.entries()) {
      if (personIdx !== personIndex) continue;
      amount += amounts[i]!;
      numerator += personWeights ? (personWeights[personIdx] ?? 1) : 1;
    }
    const denominator = personWeights ? itemWeight(personIndices, personWeights) : personIndices.length;
    const divisor = greatestCommonDivisor(numerator, denominator);
    shares.push({ itemIndex, amount, share: { numerator: numerator / divisor, denominator: denominator / divisor } });
  }
  return shares;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The weights a split of these people is calculated with: their group sizes, or none while
 * everyone counts once. Finalizing a claim session, the claim page and the split summary all use
 * it, since an unweighted split rounds a shared item's cents differently from one weighted 1 to 1.
 */
export function groupSizeWeights(people: { groupSize?: number | undefined }[]): { personWeights?: number[] } {
  const personWeights = people.map((p) => p.groupSize ?? 1);
  return personWeights.some((w) => w > 1) ? { personWeights } : {};
}

/**
 * Per-person totals for a split some items may still be missing from (the claim page, #264).
 * Tax and tip are prorated over every item, claimed or not, and the part that belongs to the
 * unclaimed items comes back as `unclaimed`. Once nothing with a price is left unclaimed (on a bill
 * whose items are all free, once every item is claimed), the people are `calculateSplitTotals`'
 * unchanged, so the page shows what finalizing will store.
 */
export function calculateClaimTotals(params: Parameters<typeof calculateSplitTotals>[0]): {
  people: ReturnType<typeof calculateSplitTotals>;
  unclaimed: { itemTotal: number; tax: number; tip: number; total: number } | null;
} {
  const people = calculateSplitTotals(params);
  const billSubtotal = params.items.reduce((sum, item) => sum + item.totalPrice, 0);
  const claimedSubtotal = people.reduce((sum, p) => sum + p.itemTotal, 0);
  // When every item is free, tax and tip can't follow prices: they stay unclaimed until every item is claimed
  const freeBill = billSubtotal <= 0;
  if (freeBill) {
    const claimed = new Set(params.assignments.filter((a) => a.personIndices.length > 0).map((a) => a.itemIndex));
    const allClaimed = params.items.every((_, i) => claimed.has(i));
    if (allClaimed || (params.tax === 0 && params.tip === 0)) return { people, unclaimed: null };
  } else if (claimedSubtotal >= billSubtotal) {
    return { people, unclaimed: null };
  }

  const subtotals = [...people.map((p) => p.itemTotal), billSubtotal - claimedSubtotal];
  const weights = freeBill ? [...people.map(() => 0), 1] : subtotals;
  const taxes = allocateProportionally(params.tax, weights);
  const tips = allocateProportionally(params.tip, weights);
  const withShares = (itemTotal: number, i: number) => ({
    itemTotal,
    tax: taxes[i]!,
    tip: tips[i]!,
    total: itemTotal + taxes[i]! + tips[i]!,
  });

  return {
    people: people.map((p, i) => ({ personIndex: p.personIndex, ...withShares(p.itemTotal, i) })),
    unclaimed: withShares(subtotals[people.length]!, people.length),
  };
}

/**
 * Splits `amount` cents in proportion to `weights` (nonnegative, with a positive sum) so the
 * shares add up to `amount` exactly: each share is rounded down, and the cents left over go to
 * the largest remainders, earliest first on a tie. Rounding each share on its own could hand out
 * more than `amount` and leave the last share negative.
 */
function allocateProportionally(amount: number, weights: number[]): number[] {
  const sign = amount < 0 ? -1 : 1;
  const cents = Math.abs(amount);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((cents * w) / weightTotal));
  const remainders = weights.map((w, i) => ({ i, remainder: cents * w - shares[i]! * weightTotal }));
  remainders.sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let left = cents - shares.reduce((a, b) => a + b, 0);
  for (const { i } of remainders) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares.map((share) => share * sign);
}
