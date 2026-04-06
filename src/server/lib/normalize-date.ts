/**
 * Normalize a date string from any common format to ISO YYYY-MM-DD.
 * Handles: MM/DD/YYYY, DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD, and 2-digit years.
 */
export function normalizeDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const trimmed = date.trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Match common patterns: DD/MM/YYYY, MM/DD/YYYY, DD.MM.YYYY, DD-MM-YYYY
  const match = trimmed.match(/^(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})$/);
  if (match) {
    const [, a, , b, yearStr] = match;
    let year = parseInt(yearStr, 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const n1 = parseInt(a, 10);
    const n2 = parseInt(b, 10);

    let month: number, day: number;
    if (n1 > 12) {
      day = n1; month = n2;
    } else if (n2 > 12) {
      month = n1; day = n2;
    } else {
      // Ambiguous — assume MM/DD (US convention)
      month = n1; day = n2;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Couldn't parse — return as-is
  return trimmed;
}
