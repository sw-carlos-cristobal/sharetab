const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/** Parses a boolean env value (true/1/yes/on, false/0/no/off); null when empty or unrecognized. */
export function parseBooleanValue(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase() ?? '';
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return null;
}
