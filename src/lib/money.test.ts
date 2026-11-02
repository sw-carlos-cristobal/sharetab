import { describe, test, expect } from 'vitest';
import { formatCents, parseToCents, centsToDecimal, allocateProportionally } from './money';

describe('formatCents', () => {
  test('formats whole dollar amounts', () => {
    expect(formatCents(1000)).toBe('$10.00');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(0)).toBe('$0.00');
  });

  test('formats cents correctly', () => {
    expect(formatCents(1299)).toBe('$12.99');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(50)).toBe('$0.50');
  });

  test('formats large amounts', () => {
    expect(formatCents(10000000)).toBe('$100,000.00');
    expect(formatCents(999999)).toBe('$9,999.99');
  });

  test('formats negative amounts', () => {
    expect(formatCents(-1299)).toBe('-$12.99');
  });

  test('respects currency parameter', () => {
    expect(formatCents(1000, 'EUR')).toBe('€10.00');
    expect(formatCents(1000, 'GBP')).toBe('£10.00');
  });

  test('formats JPY without decimals', () => {
    const result = formatCents(1000, 'JPY');
    expect(result).toContain('10');
  });

  test('respects locale parameter for formatting', () => {
    const result = formatCents(123456, 'EUR', 'de-DE');
    expect(result).toContain('1.234,56');
  });

  test('defaults to configured app locale when not specified', () => {
    expect(formatCents(1299, 'USD')).toBe('$12.99');
    expect(formatCents(1299, 'USD', 'en-US')).toBe('$12.99');
  });

  test('maps app locale codes to regional money locales', () => {
    const result = formatCents(123456, 'EUR', 'es');
    expect(result).toContain('1234,56');
  });

  test('maps all supported app locales to regional money locales', () => {
    // Normalize whitespace variants (NBSP, narrow NBSP) to ASCII space
    // to avoid flaky assertions across Node/ICU versions
    const norm = (s: string) => s.replace(/[  ]/g, ' ');

    // Swedish
    const sv = formatCents(123456, 'SEK', 'sv');
    expect(norm(sv)).toContain('1 234,56');

    // French
    const fr = formatCents(123456, 'EUR', 'fr');
    expect(norm(fr)).toContain('1 234,56');

    // German
    const de = formatCents(123456, 'EUR', 'de');
    expect(de).toContain('1.234,56');

    // Portuguese (Brazil)
    const ptBR = formatCents(123456, 'BRL', 'pt-BR');
    expect(ptBR).toContain('1.234,56');

    // Japanese
    const ja = formatCents(100000, 'JPY', 'ja');
    expect(ja).toContain('1,000');

    // Chinese (Simplified)
    const zhCN = formatCents(123456, 'CNY', 'zh-CN');
    expect(zhCN).toContain('1,234.56');

    // Korean
    const ko = formatCents(123456, 'KRW', 'ko');
    expect(ko).toContain('1,235');
  });
});

describe('parseToCents', () => {
  test('parses whole numbers', () => {
    expect(parseToCents('10')).toBe(1000);
    expect(parseToCents('1')).toBe(100);
    expect(parseToCents('0')).toBe(0);
  });

  test('parses decimal amounts', () => {
    expect(parseToCents('12.99')).toBe(1299);
    expect(parseToCents('0.01')).toBe(1);
    expect(parseToCents('0.50')).toBe(50);
  });

  test('truncates beyond two decimal places', () => {
    expect(parseToCents('12.999')).toBe(1299);
    expect(parseToCents('12.994')).toBe(1299);
    expect(parseToCents('0.005')).toBe(0);
  });

  test('avoids floating-point corruption', () => {
    expect(parseToCents('1.005')).toBe(100);
    expect(parseToCents('2.675')).toBe(267);
    expect(parseToCents('1.15')).toBe(115);
  });

  test('returns 0 for invalid input', () => {
    expect(parseToCents('')).toBe(0);
    expect(parseToCents('abc')).toBe(0);
    expect(parseToCents('not-a-number')).toBe(0);
  });

  test('handles negative values', () => {
    expect(parseToCents('-10.50')).toBe(-1050);
  });
});

describe('centsToDecimal', () => {
  test('converts cents to decimal string', () => {
    expect(centsToDecimal(1299)).toBe('12.99');
    expect(centsToDecimal(1000)).toBe('10.00');
    expect(centsToDecimal(1)).toBe('0.01');
    expect(centsToDecimal(0)).toBe('0.00');
  });

  test('handles large amounts', () => {
    expect(centsToDecimal(10000000)).toBe('100000.00');
  });

  test('handles negative amounts', () => {
    expect(centsToDecimal(-1299)).toBe('-12.99');
  });
});

// #331: shares rounded one at a time, with the last person taking what's left, could leave that
// person several cents off everyone else, or below zero
describe('allocateProportionally', () => {
  test('$100 in 7 equal parts: four of $14.29 and three of $14.28, the extra cents first', () => {
    expect(allocateProportionally(10000, [1, 1, 1, 1, 1, 1, 1])).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
  });

  test('gives the leftover cents to the largest remainders, earliest first on a tie', () => {
    // 1000 by 2:1 is 666.67 and 333.33: the cent goes to the first
    expect(allocateProportionally(1000, [2, 1])).toEqual([667, 333]);
    // 100 by 1:1:1 is 33.33 each: a tie, so the first
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // 10 by 1:3:6 is exact
    expect(allocateProportionally(10, [1, 3, 6])).toEqual([1, 3, 6]);
  });

  test('keeps every share within a cent of its exact value and adds up exactly', () => {
    const cases: [number, number[]][] = [
      [101, [500, 500, 0]],
      [9999, [3, 7, 11, 13]],
      [1, [1, 1, 1]],
      [2_147_483_647, [1, 2, 3, 4, 5]],
      [12345, [10000, 1, 1]],
    ];
    for (const [amount, weights] of cases) {
      const shares = allocateProportionally(amount, weights);
      const weightTotal = weights.reduce((a, b) => a + b, 0);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      for (const [i, share] of shares.entries()) {
        expect(Math.abs(share - (amount * weights[i]!) / weightTotal)).toBeLessThan(1);
        expect(share).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('stays exact where an amount times a weight passes 2^53', () => {
    // A $21,474,836.47 expense converted, its shares as the weights
    const amount = 2_147_483_647;
    const weights = [1_073_741_823, 1_073_741_821, 3];
    const shares = allocateProportionally(amount, weights);
    const weightTotal = BigInt(1_073_741_823 + 1_073_741_821 + 3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
    for (const [i, share] of shares.entries()) {
      const exactTimesTotal = BigInt(amount) * BigInt(weights[i]!);
      const shareTimesTotal = BigInt(share) * weightTotal;
      const diff = exactTimesTotal - shareTimesTotal;
      expect(diff < weightTotal && -diff < weightTotal).toBe(true);
    }
  });

  test('a zero weight gets nothing', () => {
    expect(allocateProportionally(101, [500, 500, 0])).toEqual([51, 50, 0]);
    expect(allocateProportionally(2, [0, 1, 1, 1])).toEqual([0, 1, 1, 0]);
  });

  test('splits a negative amount the same way, mirrored', () => {
    expect(allocateProportionally(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  test('a zero amount is all zeros', () => {
    expect(allocateProportionally(0, [1, 2])).toEqual([0, 0]);
  });

  test('with no weight at all, splits equally rather than returning NaN', () => {
    expect(allocateProportionally(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  test('no weights, no shares; an amount with nobody to take it is refused', () => {
    expect(allocateProportionally(0, [])).toEqual([]);
    expect(() => allocateProportionally(100, [])).toThrow(RangeError);
  });
});
