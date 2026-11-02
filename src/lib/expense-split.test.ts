import { describe, test, expect } from 'vitest';
import { evenPercentages, percentageSplitShares, sharesSplitShares } from './expense-split';

// #331: the shares and percentage editors rounded each share on its own and gave the last person
// whatever was left, so the last person could pay several cents more or less than everyone else
describe('sharesSplitShares', () => {
  const sevenOnes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((userId) => ({ userId, units: 1 }));

  test('$100 by equal shares among 7: four owe $14.29 and three owe $14.28', () => {
    expect(sharesSplitShares(10000, sevenOnes).map((s) => s.amount)).toEqual([
      1429, 1429, 1429, 1429, 1428, 1428, 1428,
    ]);
  });

  test('gives the leftover cents to the largest remainders and adds up to the total', () => {
    // $10.01 by 3:1:2 is 500.50, 166.83 and 333.67 cents
    const shares = sharesSplitShares(1001, [
      { userId: 'a', units: 3 },
      { userId: 'b', units: 1 },
      { userId: 'c', units: 2 },
    ]);
    expect(shares).toEqual([
      { userId: 'a', amount: 500, shares: 3 },
      { userId: 'b', amount: 167, shares: 1 },
      { userId: 'c', amount: 334, shares: 2 },
    ]);
  });

  test('leaves out people with no shares', () => {
    expect(
      sharesSplitShares(1000, [
        { userId: 'a', units: 1 },
        { userId: 'b', units: 0 },
        { userId: 'c', units: 1 },
      ]),
    ).toEqual([
      { userId: 'a', amount: 500, shares: 1 },
      { userId: 'c', amount: 500, shares: 1 },
    ]);
  });

  test('no shares, or nothing to split: no split', () => {
    expect(sharesSplitShares(1000, [{ userId: 'a', units: 0 }])).toEqual([]);
    expect(sharesSplitShares(0, sevenOnes)).toEqual([]);
  });
});

describe('evenPercentages', () => {
  test('7 people: no one more than 0.01% above anyone else, adding up to exactly 100', () => {
    const percentages = evenPercentages(7);
    expect(percentages).toEqual(['14.29', '14.29', '14.29', '14.29', '14.28', '14.28', '14.28']);
    const basisPoints = percentages.map((p) => Math.round(Number(p) * 100));
    expect(basisPoints.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.max(...basisPoints) - Math.min(...basisPoints)).toBeLessThanOrEqual(1);
  });

  test('19 people, whose last member the old prefill gave 5.32% to everyone else 5.26%', () => {
    const basisPoints = evenPercentages(19).map((p) => Math.round(Number(p) * 100));
    expect(basisPoints.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.max(...basisPoints) - Math.min(...basisPoints)).toBeLessThanOrEqual(1);
  });

  test('splits that come out even read as plain numbers', () => {
    expect(evenPercentages(2)).toEqual(['50', '50']);
    expect(evenPercentages(3)).toEqual(['33.34', '33.33', '33.33']);
    expect(evenPercentages(8)).toEqual(Array<string>(8).fill('12.5'));
  });

  test('no one, no percentages', () => {
    expect(evenPercentages(0)).toEqual([]);
  });
});

describe('percentageSplitShares', () => {
  const people = (pcts: number[]) => pcts.map((pct, i) => ({ userId: `u${i}`, pct }));

  test('the even prefill for 7 on $100: four owe $14.29 and three $14.28', () => {
    const shares = percentageSplitShares(10000, people(evenPercentages(7).map(Number)));
    expect(shares?.map((s) => s.amount)).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
    expect(shares?.map((s) => s.percentage)).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
  });

  test('stores each percentage in basis points', () => {
    expect(percentageSplitShares(10000, people([60, 40]))).toEqual([
      { userId: 'u0', amount: 6000, percentage: 6000 },
      { userId: 'u1', amount: 4000, percentage: 4000 },
    ]);
  });

  test('percentages a little off 100 spread the difference instead of handing it to the last person', () => {
    // Three people at 33.33% (99.99%, within the tolerance) of $1,000.00: each pays a third
    const shares = percentageSplitShares(100000, people([33.33, 33.33, 33.33]));
    expect(shares?.map((s) => s.amount)).toEqual([33334, 33333, 33333]);
  });

  test('keeps each share within a cent of the total times its part of the percentages', () => {
    const pcts = [12.5, 37.5, 49.99, 0.01];
    const shares = percentageSplitShares(999, people(pcts)) ?? [];
    const bps = pcts.map((p) => Math.round(p * 100));
    const bpTotal = bps.reduce((a, b) => a + b, 0);
    expect(shares.reduce((sum, s) => sum + s.amount, 0)).toBe(999);
    for (const share of shares) {
      const i = Number(share.userId.slice(1));
      expect(Math.abs(share.amount - (999 * bps[i]!) / bpTotal)).toBeLessThan(1);
    }
  });

  test('leaves out people at 0%, and anyone whose share comes to nothing', () => {
    expect(percentageSplitShares(1, people([50, 0, 50]))).toEqual([{ userId: 'u0', amount: 1, percentage: 5000 }]);
  });

  test("percentages that don't add up to 100 make no split", () => {
    expect(percentageSplitShares(10000, people([30, 30]))).toBeNull();
    expect(percentageSplitShares(10000, people([]))).toBeNull();
  });
});
