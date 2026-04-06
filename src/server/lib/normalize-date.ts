/**
 * Normalize a date string from any common format to ISO YYYY-MM-DD.
 * Handles: MM/DD/YYYY (slash), DD.MM.YYYY (dot), DD-MM-YYYY (dash), YYYY-MM-DD, and 2-digit years.
 *
 * Separator-aware disambiguation for ambiguous dates (both parts <= 12):
 * - Dot/dash → DD.MM / DD-MM (European convention)
 * - Slash → MM/DD (US convention)
 *
 * Returns undefined if the date cannot be parsed.
 */
export function normalizeDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const trimmed = date.trim();

  // Already ISO format (YYYY-MM-DD only, no time component)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Match common patterns: DD/MM/YYYY, MM/DD/YYYY, DD.MM.YYYY, DD-MM-YYYY
  const match = trimmed.match(/^(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})$/);
  if (!match) return undefined;

  const [, a, separator, b, yearStr] = match;
  let year = parseInt(yearStr, 10);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  const n1 = parseInt(a, 10);
  const n2 = parseInt(b, 10);

  let month: number, day: number;
  if (n1 > 12) {
    // First number can't be a month — must be DD/MM
    day = n1;
    month = n2;
  } else if (n2 > 12) {
    // Second number can't be a month — must be MM/DD
    month = n1;
    day = n2;
  } else {
    // Ambiguous: use separator to disambiguate
    // Dot/dash → European (day first), slash → US (month first)
    if (separator === "/") {
      month = n1;
      day = n2;
    } else {
      day = n1;
      month = n2;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
