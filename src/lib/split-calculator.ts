import { allocateProportionally } from './money';

/**
 * Pure function to calculate per-person totals with proportional tax/tip distribution.
 * Used by the guest split flow, and by the group receipt flow through `calculateReceiptSplitTotals`.
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

  const entries = Array.from(personSubtotals.entries());
  if (entries.length === 0) return [];

  // Tax and tip follow each person's items (#331: within a cent of their exact share, so nobody's
  // goes below zero and free items pay none). Someone whose items come to nothing or less (the
  // guest API takes a negative price) counts as free. When everyone does, they can't follow the
  // items, so they're shared by head, a group counting for as many people as it stands for.
  const subtotals = entries.map(([, itemTotal]) => Math.max(0, itemTotal));
  const weights = subtotals.some((s) => s > 0)
    ? subtotals
    : entries.map(([personIdx]) => personWeights?.[personIdx] ?? 1);
  const taxes = allocateProportionally(tax, weights);
  const tips = allocateProportionally(tip, weights);

  return entries.map(([personIndex, itemTotal], i) => {
    const personTax = taxes[i]!;
    const personTip = tips[i]!;
    return { personIndex, itemTotal, tax: personTax, tip: personTip, total: itemTotal + personTax + personTip };
  });
}

/**
 * What a Quick Split's bill comes to (#408): its items' prices added up, then tax and tip on top.
 * Once every item has someone, that is what everyone's totals from `calculateSplitTotals` add up
 * to. The subtotal and total a scan read stop matching as soon as an item is edited, added or
 * deleted, or the tip changes, so a split stores these instead and shows them as its Total bill.
 */
export function billTotals(
  items: { totalPrice: number }[],
  tax: number,
  tip: number,
): { subtotal: number; total: number } {
  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  return { subtotal, total: subtotal + tax + tip };
}

/** A receipt item and the people on it, in the order the split uses them */
export type ReceiptAssignment = { receiptItemId: string; userIds: string[] };

/**
 * Per-person totals for a group receipt whose items are assigned by id to people by user id:
 * what the group scan page previews and what `receipts.assignItemsAndCreateExpense` saves (#364).
 * Tax and tip are shared in proportion to the prices of the items assigned, not the subtotal the
 * scan read, which no longer adds up once an item is added, deleted or repriced. All of the tax
 * and tip goes to the people assigned, so the mutation requires every item to be. People come
 * back in the order they first appear in `assignments`, and a leftover cent that two people have
 * equal claim to goes to the one first in that order (for an item's own cents, first on the item),
 * so the page and the server must use the same list in the same order. An assignment to an item
 * that isn't in `items` is left out.
 */
export function calculateReceiptSplitTotals(params: {
  items: { id: string; totalPrice: number }[];
  assignments: ReceiptAssignment[];
  tax: number;
  tip: number;
}): { userId: string; itemTotal: number; tax: number; tip: number; total: number }[] {
  const itemIndices = new Map(params.items.map((item, i) => [item.id, i]));
  const userIds: string[] = [];
  const userIndices = new Map<string, number>();
  const userIndex = (userId: string) => {
    let index = userIndices.get(userId);
    if (index === undefined) {
      index = userIds.push(userId) - 1;
      userIndices.set(userId, index);
    }
    return index;
  };

  const assignments = params.assignments.flatMap(({ receiptItemId, userIds: assigned }) => {
    const itemIndex = itemIndices.get(receiptItemId);
    return itemIndex === undefined ? [] : [{ itemIndex, personIndices: assigned.map(userIndex) }];
  });
  const totals = calculateSplitTotals({
    items: params.items,
    assignments,
    tax: params.tax,
    tip: params.tip,
    peopleCount: userIds.length,
  });
  return totals.map(({ personIndex, ...rest }) => ({ userId: userIds[personIndex]!, ...rest }));
}

/**
 * The list the group scan page previews `calculateReceiptSplitTotals` with and sends to Create
 * Expense and Save for later (#364, #411): the receipt's items that have someone, in receipt
 * order, each with its people in the order the page holds them. The page's selections can still
 * hold an item deleted from the receipt, so they're read through `items`.
 */
export function receiptAssignmentList(
  items: { id: string }[],
  selected: Record<string, Iterable<string>>,
): ReceiptAssignment[] {
  return items.flatMap((item) => {
    const userIds = Array.from(selected[item.id] ?? []);
    return userIds.length > 0 ? [{ receiptItemId: item.id, userIds }] : [];
  });
}

/**
 * How one item's price is divided among the people on it, in cents, in `personIndices` order.
 * `calculateSplitTotals` adds these up into each person's item total.
 */
function splitItemPrice(totalPrice: number, personIndices: number[], personWeights?: number[]): number[] {
  // By group size when weighted, else equally; leftover cents go to the largest remainders, the
  // first people on the item on a tie (#331), so equal weights split it as no weights do
  return allocateProportionally(
    totalPrice,
    personIndices.map((personIdx) => personWeights?.[personIdx] ?? 1),
  );
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
 * it, so they agree on who stands for how many people.
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
  // As in calculateSplitTotals, someone whose items come to nothing or less takes no tax or tip
  const weights = freeBill ? [...people.map(() => 0), 1] : subtotals.map((s) => Math.max(0, s));
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
