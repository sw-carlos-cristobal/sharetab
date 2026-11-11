import { describe, test, expect } from 'vitest';
import { normalizeDate, receiptExpenseDate } from './normalize-date';

describe('normalizeDate', () => {
  // ── Passthrough ──
  test('returns undefined for undefined input', () => {
    expect(normalizeDate(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(normalizeDate('')).toBeUndefined();
  });

  test('passes through valid ISO dates unchanged', () => {
    expect(normalizeDate('2025-03-12')).toBe('2025-03-12');
  });

  test('trims whitespace from ISO dates', () => {
    expect(normalizeDate('  2025-03-12  ')).toBe('2025-03-12');
  });

  // ── Unambiguous (one number > 12) ──
  test('handles DD/MM/YYYY when day > 12', () => {
    expect(normalizeDate('25/03/2025')).toBe('2025-03-25');
  });

  test('handles MM/DD/YYYY when day > 12', () => {
    expect(normalizeDate('03/25/2025')).toBe('2025-03-25');
  });

  // ── 2-digit years ──
  test('expands 2-digit year < 50 to 2000s', () => {
    expect(normalizeDate('03/25/25')).toBe('2025-03-25');
  });

  test('expands 2-digit year >= 50 to 1900s', () => {
    expect(normalizeDate('03/25/99')).toBe('1999-03-25');
  });

  // ── #45: Separator-aware disambiguation ──
  test('dot separator treats ambiguous date as DD.MM (European)', () => {
    expect(normalizeDate('12.03.2025')).toBe('2025-03-12');
  });

  test('dash separator treats ambiguous date as DD-MM (European)', () => {
    expect(normalizeDate('05-04-2025')).toBe('2025-04-05');
  });

  test('slash separator treats ambiguous date as MM/DD (US)', () => {
    expect(normalizeDate('05/04/2025')).toBe('2025-05-04');
  });

  // ── #49: Unparseable dates return undefined ──
  test("returns undefined for written-out dates like 'April 5, 2026'", () => {
    expect(normalizeDate('April 5, 2026')).toBeUndefined();
  });

  test("returns undefined for '5 Apr 2026'", () => {
    expect(normalizeDate('5 Apr 2026')).toBeUndefined();
  });

  test("returns undefined for 'Mon 04/05/2026'", () => {
    expect(normalizeDate('Mon 04/05/2026')).toBeUndefined();
  });

  test('returns undefined for ISO timestamps with time', () => {
    expect(normalizeDate('2026-04-05T12:30:00')).toBeUndefined();
  });

  // ── Edge: invalid day/month range ──
  test('returns undefined for out-of-range month/day', () => {
    expect(normalizeDate('00/32/2025')).toBeUndefined();
  });
});

// #362: an expense made from a receipt is dated the receipt's day, and its rate looked up for it
describe('receiptExpenseDate', () => {
  const now = new Date('2026-11-11T15:30:00Z');

  test("a past receipt date dates the expense that day, and its rate is that day's", () => {
    expect(receiptExpenseDate('2026-10-15', now)).toEqual({
      expenseDate: new Date('2026-10-15T10:00:00Z'),
      rateDate: '2026-10-15',
    });
  });

  // Pages show an expense's date in the browser's time zone. 10:00 UTC is the receipt's day from
  // UTC−10 (Hawaii) to UTC+13 (New Zealand in summer, Tonga)
  test.each([
    'Pacific/Honolulu',
    'America/Los_Angeles',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Pacific/Auckland',
    'Pacific/Tongatapu',
  ])('it shows as the receipt date in %s', (timeZone) => {
    const { expenseDate } = receiptExpenseDate('2026-10-15', now);
    expect(expenseDate.toLocaleDateString('en-US', { timeZone })).toBe('10/15/2026');
  });

  test.each([undefined, '', 'not a date', '2026-02-30', '2026-13-01', '0026-10-15'])(
    'no usable date (%j) dates the expense now, at the latest rate',
    (date) => {
      expect(receiptExpenseDate(date, now)).toEqual({ expenseDate: now, rateDate: undefined });
    },
  );

  // After today (UTC): misread, or the local today in a time zone ahead of UTC
  test.each(['2026-11-12', '2027-10-15', '3026-01-01'])(
    'a date after today (%s) dates the expense now, at the latest rate',
    (date) => {
      expect(receiptExpenseDate(date, now)).toEqual({ expenseDate: now, rateDate: undefined });
    },
  );

  test("a receipt from today keeps today's rate, dated no later than now", () => {
    expect(receiptExpenseDate('2026-11-11', now)).toEqual({
      expenseDate: new Date('2026-11-11T10:00:00Z'),
      rateDate: '2026-11-11',
    });
    const early = new Date('2026-11-11T03:00:00Z');
    expect(receiptExpenseDate('2026-11-11', early)).toEqual({ expenseDate: early, rateDate: '2026-11-11' });
  });

  // Receipts scanned before the scan normalized its date (#33, #49) hold the text as it was read
  test.each([
    ['10/15/2026', '2026-10-15'],
    ['15.10.2026', '2026-10-15'],
    [' 2026-10-15 ', '2026-10-15'],
    ['2026-10-15T19:45:00', '2026-10-15'],
  ])('an older stored date (%j) is read as %s', (date, day) => {
    expect(receiptExpenseDate(date, now).rateDate).toBe(day);
  });
});
