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

    if (personWeights) {
      // Weighted proportional splitting
      const totalWeight = Math.max(
        1,
        assignment.personIndices.reduce((sum, pi) => sum + (personWeights[pi] ?? 1), 0)
      );
      let allocated = 0;
      for (let i = 0; i < assignment.personIndices.length; i++) {
        const personIdx = assignment.personIndices[i];
        const weight = personWeights[personIdx] ?? 1;
        let amount: number;
        if (i === assignment.personIndices.length - 1) {
          amount = item.totalPrice - allocated;
        } else {
          amount = Math.floor(item.totalPrice * weight / totalWeight);
        }
        allocated += amount;
        personSubtotals.set(personIdx, (personSubtotals.get(personIdx) ?? 0) + amount);
      }
    } else {
      // Equal splitting (original behavior)
      const perPerson = Math.floor(item.totalPrice / assignment.personIndices.length);
      const remainder = item.totalPrice - perPerson * assignment.personIndices.length;

      for (let i = 0; i < assignment.personIndices.length; i++) {
        const personIdx = assignment.personIndices[i];
        const amount = perPerson + (i < remainder ? 1 : 0);
        personSubtotals.set(personIdx, (personSubtotals.get(personIdx) ?? 0) + amount);
      }
    }
  }

  const actualSubtotal = Array.from(personSubtotals.values()).reduce((a, b) => a + b, 0);
  const totalAmount = actualSubtotal + tax + tip;

  const results: { personIndex: number; itemTotal: number; tax: number; tip: number; total: number }[] = [];
  let allocated = 0;
  const entries = Array.from(personSubtotals.entries());

  for (let i = 0; i < entries.length; i++) {
    const [personIdx, itemTotal] = entries[i];

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
