import { allocateProportionally } from './money';

/**
 * What the expense form's Equal, Shares and Percentage editors save (#331). They divide the amount
 * with `allocateProportionally`, so each share is within a cent of its exact value and the leftover
 * cents go to the largest remainders, the first person on a tie, rather than all to the last.
 * `step` is the expense currency's `currencyStep`: 100 makes every share a whole unit (#335).
 */

/** The Equal editor's split: the total among `userIds` evenly, the extra cents to the first. */
export function equalSplitShares(
  totalCents: number,
  userIds: string[],
  step = 1,
): { userId: string; amount: number }[] {
  if (userIds.length === 0 || totalCents <= 0) return [];
  const amounts = allocateProportionally(totalCents, Array<number>(userIds.length).fill(1), step);
  return userIds.map((userId, i) => ({ userId, amount: amounts[i]! }));
}

/** The Shares editor's split: each person with shares pays the total in proportion to them. */
export function sharesSplitShares(
  totalCents: number,
  entries: { userId: string; units: number }[],
  step = 1,
): { userId: string; amount: number; shares: number }[] {
  const withShares = entries.filter((e) => e.units > 0);
  if (withShares.length === 0 || totalCents <= 0) return [];
  const amounts = allocateProportionally(
    totalCents,
    withShares.map((e) => e.units),
    step,
  );
  return withShares.map((e, i) => ({ userId: e.userId, amount: amounts[i]!, shares: e.units }));
}

/**
 * How far from 100% the percentages may add up to and still be a split. The even prefill adds up
 * to exactly 100, but a split opened from a saved expense carries the stored percentages (basis
 * points), and those can each be 0.005 off from rounding, so the tolerance grows with the people
 * at more than 0%. The amounts follow the percentages as entered, so the difference is spread over
 * everyone in proportion rather than landing on one person.
 */
export function percentTolerance(participantCount: number): number {
  return Math.max(0.05, participantCount * 0.005 + 0.001);
}

/**
 * The Percentage editor's split, or null while the percentages don't add up to 100% (within
 * `percentTolerance`): otherwise 30% and 30% of $100 would come to $50 each. Percentages are kept
 * in basis points (50.00% = 5000), and the amount is divided in proportion to them. People at 0%,
 * and anyone whose share comes to less than a cent (a unit, with a `step` of 100), are left out.
 */
export function percentageSplitShares(
  totalCents: number,
  entries: { userId: string; pct: number }[],
  step = 1,
): { userId: string; amount: number; percentage: number }[] | null {
  const participating = entries.filter((e) => e.pct > 0);
  const totalPct = participating.reduce((sum, e) => sum + e.pct, 0);
  if (participating.length === 0 || Math.abs(totalPct - 100) >= percentTolerance(participating.length)) return null;

  const basisPoints = participating.map((e) => Math.round(e.pct * 100));
  const amounts = allocateProportionally(totalCents, basisPoints, step);
  return participating
    .map((e, i) => ({ userId: e.userId, amount: amounts[i]!, percentage: basisPoints[i]! }))
    .filter((share) => share.amount > 0);
}

/**
 * The Percentage editor's opening values for `count` people, as the input shows them: 100% in
 * basis points shared as evenly as it goes, the extra hundredths to the first people, so no one is
 * more than 0.01% above anyone else and they add up to exactly 100 (7 people: four at 14.29% and
 * three at 14.28%).
 */
export function evenPercentages(count: number): string[] {
  if (count <= 0) return [];
  return allocateProportionally(10000, Array<number>(count).fill(1)).map((bp) => String(bp / 100));
}
