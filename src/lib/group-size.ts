// How many people a claim-session person stands for (a couple joins as 2). It weights their share
// of the items they split with others (groupSizeWeights in split-calculator.ts)
export const MIN_GROUP_SIZE = 1;
export const MAX_GROUP_SIZE = 20;

/**
 * The group size typed into a claim-page field, or null when the text isn't a whole number from
 * MIN_GROUP_SIZE to MAX_GROUP_SIZE. An empty field is null too: the pages keep the text as typed,
 * so it can be cleared and retyped (#410), and refuse a value out of range rather than changing it.
 */
export function parseGroupSize(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_GROUP_SIZE && value <= MAX_GROUP_SIZE ? value : null;
}
