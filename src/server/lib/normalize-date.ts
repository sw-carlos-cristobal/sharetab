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
  // The regex above has exactly 4 unconditional capture groups, so all four
  // are always present when `match` succeeds — this just narrows the type.
  if (a === undefined || separator === undefined || b === undefined || yearStr === undefined) {
    return undefined;
  }
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
    if (separator === '/') {
      month = n1;
      day = n2;
    } else {
      day = n1;
      month = n2;
    }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Pages show an expense's date in the browser's time zone, so a day with no time of its own is
// stored at an hour that is still that day from UTC−10 (Hawaii) to UTC+13 (New Zealand in summer,
// Tonga). Only UTC−11 (American Samoa, Niue) and UTC+14 (Kiribati's Line Islands) see another day
const DAY_ONLY_UTC_HOUR = 10;

/**
 * The date an expense made from a receipt takes, and the day its exchange rate is looked up for
 * (#362): the receipt's own date when the scan read one, else now, at the latest rate.
 *
 * A date that isn't a real calendar day, or is after today, counts as none. A date after today can
 * be misread, and Frankfurter answers one with its latest rate, or, more than about two weeks
 * ahead, with no rate at all. "Today" is UTC's day, whatever the server's time zone. So in a time
 * zone ahead of UTC, from local midnight until UTC's day catches up, a receipt from the local today
 * counts as after today and is dated now, which a viewer in that zone sees as that day; for the
 * rest of the local day it is dated its own day like any other. A receipt from today is dated no
 * later than now.
 */
export function receiptExpenseDate(
  date: string | undefined,
  now: Date,
): { expenseDate: Date; rateDate: string | undefined } {
  // The scan stores normalizeDate's output (#33, #49); a receipt scanned before then holds the text
  // as it was read, perhaps an ISO date followed by a time, which the first 10 characters leave out
  const day = normalizeDate(date?.trim().slice(0, 10));
  const today = now.toISOString().slice(0, 10);
  if (!day || day > today) {
    return { expenseDate: now, rateDate: undefined };
  }

  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const stored = new Date(Date.UTC(year, month - 1, dayOfMonth, DAY_ONLY_UTC_HOUR));
  // Date.UTC rolls an impossible day over (February 30 to March 2) and reads years 0-99 as 1900-1999
  if (stored.toISOString().slice(0, 10) !== day) {
    return { expenseDate: now, rateDate: undefined };
  }
  return { expenseDate: stored < now ? stored : now, rateDate: day };
}
