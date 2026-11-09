import { describe, test, expect } from 'vitest';
import {
  billTotals,
  calculateClaimTotals,
  calculateReceiptSplitTotals,
  calculateSplitTotals,
  groupSizeWeights,
  personItemShares,
  receiptAssignmentList,
} from './split-calculator';

describe('calculateSplitTotals', () => {
  test('splits single item between two people equally', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.itemTotal).toBe(500);
    expect(results[1]!.itemTotal).toBe(500);
    expect(results[0]!.total).toBe(500);
    expect(results[1]!.total).toBe(500);
  });

  test('handles odd-cent splits with remainder going to first person', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1001 }], // $10.01 — can't split evenly
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    // First person gets the extra cent
    expect(results[0]!.itemTotal + results[1]!.itemTotal).toBe(1001);
    expect(Math.abs(results[0]!.itemTotal - results[1]!.itemTotal)).toBe(1);
  });

  // #331: the order decides who takes a tied cent, so the page and the server must agree on it
  test("an item's tied cent goes to the first person listed on it, not the lowest index", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1001 }],
      assignments: [{ itemIndex: 0, personIndices: [1, 0] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    expect(results.find((r) => r.personIndex === 1)!.itemTotal).toBe(501);
    expect(results.find((r) => r.personIndex === 0)!.itemTotal).toBe(500);
  });

  test('a tied tax cent goes to the person who comes first in the assignments', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }, { totalPrice: 1000 }, { totalPrice: 1000 }],
      assignments: [
        { itemIndex: 0, personIndices: [2] },
        { itemIndex: 1, personIndices: [0] },
        { itemIndex: 2, personIndices: [1] },
      ],
      tax: 100,
      tip: 0,
      peopleCount: 3,
    });

    expect(results.map((r) => [r.personIndex, r.tax])).toEqual([
      [2, 34],
      [0, 33],
      [1, 33],
    ]);
  });

  test('distributes tax proportionally', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 600 }, { totalPrice: 400 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] }, // Person 0 gets $6 item
        { itemIndex: 1, personIndices: [1] }, // Person 1 gets $4 item
      ],
      tax: 100, // $1 tax
      tip: 0,
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    // Person 0 has 60% of subtotal → 60% of tax
    expect(results.find((r) => r.personIndex === 0)!.tax).toBe(60);
    // Person 1 has 40% of subtotal → 40% of tax
    const person1 = results.find((r) => r.personIndex === 1)!;
    expect(person1.tax).toBe(40);
  });

  test('distributes tip proportionally', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 800 }, { totalPrice: 200 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      tax: 0,
      tip: 200, // $2 tip
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    // Person 0 has 80% → 80% of tip
    expect(results.find((r) => r.personIndex === 0)!.tip).toBe(160);
  });

  test('total of all persons equals items + tax + tip', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1500 }, { totalPrice: 2000 }, { totalPrice: 500 }],
      assignments: [
        { itemIndex: 0, personIndices: [0, 1] },
        { itemIndex: 1, personIndices: [1, 2] },
        { itemIndex: 2, personIndices: [0, 2] },
      ],
      tax: 350,
      tip: 500,
      peopleCount: 3,
    });

    const totalAll = results.reduce((sum, r) => sum + r.total, 0);
    expect(totalAll).toBe(1500 + 2000 + 500 + 350 + 500);
  });

  test('handles person with no items assigned', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0] }], // Only person 0
      tax: 100,
      tip: 100,
      peopleCount: 3, // 3 people but only 1 assigned
    });

    // Only person 0 should appear in results
    expect(results).toHaveLength(1);
    expect(results[0]!.personIndex).toBe(0);
    expect(results[0]!.total).toBe(1200);
  });

  test('handles empty assignments', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [],
      tax: 100,
      tip: 100,
      peopleCount: 2,
    });

    expect(results).toHaveLength(0);
  });

  test('handles zero-price items', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 0 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    // Both get 0
    expect(results).toHaveLength(2);
    expect(results[0]!.total).toBe(0);
    expect(results[1]!.total).toBe(0);
  });

  test('three-way split with tax and tip totals correctly', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 3333 }], // $33.33
      assignments: [{ itemIndex: 0, personIndices: [0, 1, 2] }],
      tax: 267, // $2.67
      tip: 500, // $5.00
      peopleCount: 3,
    });

    const totalAll = results.reduce((sum, r) => sum + r.total, 0);
    expect(totalAll).toBe(3333 + 267 + 500);
    expect(results).toHaveLength(3);
  });

  // --- personWeights tests ---

  test('weighted split: 2 people with weights [2, 1] splitting $30 item', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 3000 }], // $30.00
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
      personWeights: [2, 1],
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.personIndex === 0)!.itemTotal).toBe(2000); // 2/3 of $30
    expect(results.find((r) => r.personIndex === 1)!.itemTotal).toBe(1000); // 1/3 of $30
  });

  test('weighted split distributes tax/tip proportionally to subtotals', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 3000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 300, // $3 tax
      tip: 600, // $6 tip
      peopleCount: 2,
      personWeights: [2, 1],
    });

    expect(results).toHaveLength(2);
    const person0 = results.find((r) => r.personIndex === 0)!;
    const person1 = results.find((r) => r.personIndex === 1)!;
    // Person 0 has $20 subtotal (2/3), person 1 has $10 (1/3)
    // Tax: person 0 = $2, person 1 = $1
    expect(person0.tax).toBe(200);
    // Tip: person 0 = $4, person 1 = $2
    expect(person0.tip).toBe(400);
    // Totals sum correctly
    expect(person0.total + person1.total).toBe(3000 + 300 + 600);
  });

  test('weighted split with remainder handling (odd cents)', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }], // $10.00
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
      personWeights: [2, 1], // 666.67 and 333.33 cents
    });

    expect(results).toHaveLength(2);
    const person0 = results.find((r) => r.personIndex === 0)!;
    const person1 = results.find((r) => r.personIndex === 1)!;
    // #331: the leftover cent goes to the larger remainder (666.67), not to whoever is last
    expect(person0.itemTotal).toBe(667);
    expect(person1.itemTotal).toBe(333);
    expect(person0.itemTotal + person1.itemTotal).toBe(1000);
  });

  test('weighted split: individual items unaffected by weights', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 500 }, { totalPrice: 800 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] }, // Individual: person 0 only
        { itemIndex: 1, personIndices: [1] }, // Individual: person 1 only
      ],
      tax: 0,
      tip: 0,
      peopleCount: 2,
      personWeights: [3, 1], // Weights don't matter for individual items
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.personIndex === 0)!.itemTotal).toBe(500);
    expect(results.find((r) => r.personIndex === 1)!.itemTotal).toBe(800);
  });

  test('weighted split: mixed shared and individual items', () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 600 }, { totalPrice: 900 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] }, // Person 0 individual
        { itemIndex: 1, personIndices: [0, 1] }, // Shared between 0 and 1
      ],
      tax: 100,
      tip: 0,
      peopleCount: 2,
      personWeights: [2, 1], // Person 0 weight=2, person 1 weight=1
    });

    expect(results).toHaveLength(2);
    const person0 = results.find((r) => r.personIndex === 0)!;
    const person1 = results.find((r) => r.personIndex === 1)!;
    // Person 0: 600 individual + 900*2/3=600 shared = 1200
    // Person 1: 900*1/3=300 shared = 300
    expect(person0.itemTotal).toBe(1200);
    expect(person1.itemTotal).toBe(300);
    // Total sums
    expect(person0.total + person1.total).toBe(600 + 900 + 100);
  });

  test('weighted split: backward compat — no personWeights equals equal split', () => {
    const withoutWeights = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 100,
      tip: 50,
      peopleCount: 2,
    });

    const withEqualWeights = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 100,
      tip: 50,
      peopleCount: 2,
      personWeights: [1, 1],
    });

    // Equal weights should produce same result as no weights
    expect(withoutWeights).toEqual(withEqualWeights);
  });

  // #331: each person's tax and tip were rounded on their own and the last person took what was left
  describe('leftover cents of tax and tip', () => {
    test('$5.00, $5.00 and a free item, $1.01 tax: no share goes below zero and the free item pays none', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 500 }, { totalPrice: 500 }, { totalPrice: 0 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
          { itemIndex: 2, personIndices: [2] },
        ],
        tax: 101,
        tip: 0,
        peopleCount: 3,
      });

      expect(results).toEqual([
        { personIndex: 0, itemTotal: 500, tax: 51, tip: 0, total: 551 },
        { personIndex: 1, itemTotal: 500, tax: 50, tip: 0, total: 550 },
        { personIndex: 2, itemTotal: 0, tax: 0, tip: 0, total: 0 },
      ]);
    });

    test('a person whose items are all free pays no tip either, wherever they are in the order', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 0 }, { totalPrice: 333 }, { totalPrice: 667 }],
        assignments: [
          { itemIndex: 1, personIndices: [1] },
          { itemIndex: 2, personIndices: [2] },
          { itemIndex: 0, personIndices: [0] },
        ],
        tax: 99,
        tip: 199,
        peopleCount: 3,
      });

      expect(results.find((r) => r.personIndex === 0)).toEqual({
        personIndex: 0,
        itemTotal: 0,
        tax: 0,
        tip: 0,
        total: 0,
      });
    });

    test('three equal people and $1.00 tax: the extra cent goes to the first, not the last', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 1000 }, { totalPrice: 1000 }, { totalPrice: 1000 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
          { itemIndex: 2, personIndices: [2] },
        ],
        tax: 100,
        tip: 0,
        peopleCount: 3,
      });

      expect(results.map((r) => r.tax)).toEqual([34, 33, 33]);
    });

    test("tax and tip each add up on their own; the last person's tax no longer absorbs the tip's rounding", () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 1000 }, { totalPrice: 1000 }, { totalPrice: 1000 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
          { itemIndex: 2, personIndices: [2] },
        ],
        tax: 100,
        tip: 200,
        peopleCount: 3,
      });

      expect(results.map((r) => [r.tax, r.tip])).toEqual([
        [34, 67],
        [33, 67],
        [33, 66],
      ]);
    });

    test('every tax and tip share is within a cent of its exact value, and they add up', () => {
      const items = [{ totalPrice: 1001 }, { totalPrice: 333 }, { totalPrice: 2999 }, { totalPrice: 7 }];
      const assignments = [
        { itemIndex: 0, personIndices: [2, 0, 1] },
        { itemIndex: 1, personIndices: [1, 0] },
        { itemIndex: 2, personIndices: [0] },
        { itemIndex: 3, personIndices: [3] },
      ];
      const tax = 347;
      const tip = 611;
      const results = calculateSplitTotals({ items, assignments, tax, tip, peopleCount: 4 });
      const subtotal = results.reduce((sum, r) => sum + r.itemTotal, 0);

      expect(results.reduce((sum, r) => sum + r.tax, 0)).toBe(tax);
      expect(results.reduce((sum, r) => sum + r.tip, 0)).toBe(tip);
      for (const r of results) {
        expect(Math.abs(r.tax - (tax * r.itemTotal) / subtotal)).toBeLessThan(1);
        expect(Math.abs(r.tip - (tip * r.itemTotal) / subtotal)).toBeLessThan(1);
        expect(r.total).toBe(r.itemTotal + r.tax + r.tip);
      }
    });

    test('a bill whose items are all free shares tax and tip evenly instead of giving them to the last person', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 0 }, { totalPrice: 0 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
        ],
        tax: 101,
        tip: 50,
        peopleCount: 2,
      });

      expect(results).toEqual([
        { personIndex: 0, itemTotal: 0, tax: 51, tip: 25, total: 76 },
        { personIndex: 1, itemTotal: 0, tax: 50, tip: 25, total: 75 },
      ]);
    });

    // The guest API accepts a negative item price (a discount line), which the UI never sends
    test('a person whose items come to nothing or less pays no tax or tip, and nothing throws', () => {
      const cancelling = calculateSplitTotals({
        items: [{ totalPrice: 500 }, { totalPrice: -500 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
        ],
        tax: 100,
        tip: 0,
        peopleCount: 2,
      });
      expect(cancelling).toEqual([
        { personIndex: 0, itemTotal: 500, tax: 100, tip: 0, total: 600 },
        { personIndex: 1, itemTotal: -500, tax: 0, tip: 0, total: -500 },
      ]);

      const discounted = calculateSplitTotals({
        items: [{ totalPrice: 1000 }, { totalPrice: -300 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
        ],
        tax: 101,
        tip: 50,
        peopleCount: 2,
      });
      expect(discounted.map((r) => [r.tax, r.tip])).toEqual([
        [101, 50],
        [0, 0],
      ]);
    });

    test('a bill where nobody comes to more than nothing shares tax and tip by head', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: -500 }, { totalPrice: 0 }],
        assignments: [
          { itemIndex: 0, personIndices: [0] },
          { itemIndex: 1, personIndices: [1] },
        ],
        tax: 101,
        tip: 51,
        peopleCount: 2,
      });

      expect(results.map((r) => [r.tax, r.tip])).toEqual([
        [51, 26],
        [50, 25],
      ]);
    });

    test('on a free bill, a group counts for as many people as it stands for', () => {
      const results = calculateSplitTotals({
        items: [{ totalPrice: 0 }],
        assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
        tax: 300,
        tip: 0,
        peopleCount: 2,
        personWeights: [2, 1],
      });

      expect(results.map((r) => r.tax)).toEqual([200, 100]);
    });
  });
});

// #264: while items are unclaimed, tax and tip were all put on the people who had claimed something
describe('calculateClaimTotals', () => {
  const sumAll = (result: ReturnType<typeof calculateClaimTotals>) =>
    result.people.reduce((sum, p) => sum + p.total, 0) + (result.unclaimed?.total ?? 0);

  test('prorates tax and tip over every item and shows the rest as unclaimed', () => {
    // The issue's receipt: $25.24 claimed, $7.24 of items unclaimed, $2.60 tax, $5.00 tip
    const result = calculateClaimTotals({
      items: [{ totalPrice: 2524 }, { totalPrice: 500 }, { totalPrice: 224 }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      tax: 260,
      tip: 500,
      peopleCount: 2,
    });

    expect(result.people).toEqual([{ personIndex: 0, itemTotal: 2524, tax: 202, tip: 389, total: 3115 }]);
    expect(result.unclaimed).toEqual({ itemTotal: 724, tax: 58, tip: 111, total: 893 });
    expect(sumAll(result)).toBe(4008);
  });

  test('matches calculateSplitTotals and has no unclaimed row once every item is claimed', () => {
    const params = {
      items: [{ totalPrice: 1500 }, { totalPrice: 2000 }, { totalPrice: 500 }],
      assignments: [
        { itemIndex: 0, personIndices: [0, 1] },
        { itemIndex: 1, personIndices: [1, 2] },
        { itemIndex: 2, personIndices: [0, 2] },
      ],
      tax: 350,
      tip: 500,
      peopleCount: 3,
    };

    expect(calculateClaimTotals(params)).toEqual({ people: calculateSplitTotals(params), unclaimed: null });
  });

  test('an unclaimed item that costs nothing leaves the totals as finalizing would store them', () => {
    const params = {
      items: [{ totalPrice: 1000 }, { totalPrice: 0 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1, 2] }],
      tax: 100,
      tip: 0,
      peopleCount: 3,
    };

    expect(calculateClaimTotals(params)).toEqual({ people: calculateSplitTotals(params), unclaimed: null });
  });

  test('with nothing claimed, the whole bill is unclaimed', () => {
    const result = calculateClaimTotals({
      items: [{ totalPrice: 1000 }, { totalPrice: 500 }],
      assignments: [],
      tax: 120,
      tip: 300,
      peopleCount: 2,
    });

    expect(result.people).toEqual([]);
    expect(result.unclaimed).toEqual({ itemTotal: 1500, tax: 120, tip: 300, total: 1920 });
  });

  test('on a bill whose items are all free, tax and tip stay unclaimed until every item is claimed', () => {
    const params = { items: [{ totalPrice: 0 }, { totalPrice: 0 }], tax: 50, tip: 100, peopleCount: 2 };

    expect(calculateClaimTotals({ ...params, assignments: [] })).toEqual({
      people: [],
      unclaimed: { itemTotal: 0, tax: 50, tip: 100, total: 150 },
    });
    expect(calculateClaimTotals({ ...params, assignments: [{ itemIndex: 0, personIndices: [0] }] })).toEqual({
      people: [{ personIndex: 0, itemTotal: 0, tax: 0, tip: 0, total: 0 }],
      unclaimed: { itemTotal: 0, tax: 50, tip: 100, total: 150 },
    });
    const allClaimed = {
      ...params,
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
    };
    expect(calculateClaimTotals(allClaimed)).toEqual({ people: calculateSplitTotals(allClaimed), unclaimed: null });
  });

  test('a free bill with no tax or tip has nothing unclaimed', () => {
    expect(
      calculateClaimTotals({ items: [{ totalPrice: 0 }], assignments: [], tax: 0, tip: 0, peopleCount: 1 }),
    ).toEqual({ people: [], unclaimed: null });
  });

  test('rounding never makes a share negative, and the shares add up to the bill', () => {
    // Each claimant's exact tax share is 0.57 cents and the unclaimed share is 0.29:
    // rounding each claimant's share alone would hand out 3 cents of a 2-cent tax
    const result = calculateClaimTotals({
      items: [{ totalPrice: 2 }, { totalPrice: 2 }, { totalPrice: 2 }, { totalPrice: 1 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
        { itemIndex: 2, personIndices: [2] },
      ],
      tax: 2,
      tip: 0,
      peopleCount: 3,
    });

    const taxes = [...result.people.map((p) => p.tax), result.unclaimed!.tax];
    expect(taxes.every((tax) => tax >= 0)).toBe(true);
    expect(taxes.reduce((a, b) => a + b, 0)).toBe(2);
    expect(sumAll(result)).toBe(7 + 2);
  });

  test('a negative tax or tip is shared the same way, with every share on the same side of zero', () => {
    const result = calculateClaimTotals({
      items: [{ totalPrice: 600 }, { totalPrice: 400 }],
      assignments: [{ itemIndex: 0, personIndices: [0] }],
      tax: -101,
      tip: 0,
      peopleCount: 1,
    });

    expect(result.people[0]!.tax + result.unclaimed!.tax).toBe(-101);
    expect(result.people[0]!.tax).toBeLessThanOrEqual(0);
    expect(result.unclaimed!.tax).toBeLessThanOrEqual(0);
  });

  test('group sizes still weight a shared item', () => {
    const result = calculateClaimTotals({
      items: [{ totalPrice: 3000 }, { totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 400,
      tip: 0,
      peopleCount: 2,
      personWeights: [2, 1],
    });

    expect(result.people).toEqual([
      { personIndex: 0, itemTotal: 2000, tax: 200, tip: 0, total: 2200 },
      { personIndex: 1, itemTotal: 1000, tax: 100, tip: 0, total: 1100 },
    ]);
    expect(result.unclaimed).toEqual({ itemTotal: 1000, tax: 100, tip: 0, total: 1100 });
  });

  // #331: the guest API accepts a negative item price, which can't be given a share of the tax
  test('a person who claimed only a negative item pays no tax or tip, and nothing throws', () => {
    const result = calculateClaimTotals({
      items: [{ totalPrice: 1000 }, { totalPrice: -300 }, { totalPrice: 500 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [1] },
      ],
      tax: 150,
      tip: 300,
      peopleCount: 2,
    });

    expect(result.people).toEqual([
      { personIndex: 0, itemTotal: 1000, tax: 100, tip: 200, total: 1300 },
      { personIndex: 1, itemTotal: -300, tax: 0, tip: 0, total: -300 },
    ]);
    expect(result.unclaimed).toEqual({ itemTotal: 500, tax: 50, tip: 100, total: 650 });
  });
});

// #278: the split summary listed a shared item at its full price under each person on it
describe('personItemShares', () => {
  test("lists a shared item at the person's share of its price", () => {
    const params = {
      items: [{ totalPrice: 1600 }, { totalPrice: 375 }, { totalPrice: 900 }],
      assignments: [
        { itemIndex: 0, personIndices: [0] },
        { itemIndex: 1, personIndices: [0, 1] },
        { itemIndex: 2, personIndices: [1] },
      ],
    };

    expect(personItemShares(0, params)).toEqual([
      { itemIndex: 0, amount: 1600, share: { numerator: 1, denominator: 1 } },
      { itemIndex: 1, amount: 188, share: { numerator: 1, denominator: 2 } },
    ]);
    expect(personItemShares(1, params)).toEqual([
      { itemIndex: 1, amount: 187, share: { numerator: 1, denominator: 2 } },
      { itemIndex: 2, amount: 900, share: { numerator: 1, denominator: 1 } },
    ]);
  });

  test('weights a shared item by group size, the larger remainder taking the leftover cent', () => {
    // 66.67 and 33.33: the cent goes to the first, whose remainder is larger (#331). The last
    // person on the item used to take it (66 and 34)
    const params = {
      items: [{ totalPrice: 100 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      personWeights: [2, 1],
    };

    expect(personItemShares(0, params)).toEqual([
      { itemIndex: 0, amount: 67, share: { numerator: 2, denominator: 3 } },
    ]);
    expect(personItemShares(1, params)).toEqual([
      { itemIndex: 0, amount: 33, share: { numerator: 1, denominator: 3 } },
    ]);
  });

  test('reduces the share, and a group alone on an item pays all of it', () => {
    const params = {
      items: [{ totalPrice: 1000 }, { totalPrice: 500 }],
      assignments: [
        { itemIndex: 0, personIndices: [0, 1] },
        { itemIndex: 1, personIndices: [0] },
      ],
      personWeights: [2, 2],
    };

    expect(personItemShares(0, params)).toEqual([
      { itemIndex: 0, amount: 500, share: { numerator: 1, denominator: 2 } },
      { itemIndex: 1, amount: 500, share: { numerator: 1, denominator: 1 } },
    ]);
  });

  test('skips items the person is not on and assignments to items that do not exist', () => {
    const params = {
      items: [{ totalPrice: 1000 }],
      assignments: [
        { itemIndex: 0, personIndices: [1] },
        { itemIndex: 5, personIndices: [0] },
      ],
    };

    expect(personItemShares(0, params)).toEqual([]);
  });

  test.each([
    ['equal split', undefined],
    ['weighted split', [3, 1, 2]],
  ])("each person's shares add up to their item total (%s)", (_, personWeights) => {
    const items = [{ totalPrice: 1001 }, { totalPrice: 377 }, { totalPrice: 250 }, { totalPrice: 99 }];
    const assignments = [
      { itemIndex: 0, personIndices: [0, 1, 2] },
      { itemIndex: 1, personIndices: [2, 0] },
      { itemIndex: 2, personIndices: [1] },
      { itemIndex: 3, personIndices: [1, 2] },
    ];
    const weights = personWeights ? { personWeights } : {};
    const totals = calculateSplitTotals({ items, assignments, tax: 0, tip: 0, peopleCount: 3, ...weights });

    for (const person of totals) {
      const shares = personItemShares(person.personIndex, { items, assignments, ...weights });
      expect(shares.reduce((sum, s) => sum + s.amount, 0)).toBe(person.itemTotal);
    }
  });
});

describe('groupSizeWeights', () => {
  test('gives no weights while everyone counts once', () => {
    expect(groupSizeWeights([{ groupSize: 1 }, {}, { groupSize: 1 }])).toEqual({});
  });

  test('weights everyone by group size once someone is a group', () => {
    expect(groupSizeWeights([{ groupSize: 1 }, {}, { groupSize: 3 }])).toEqual({ personWeights: [1, 1, 3] });
  });
});

// #364: the receipt page's preview and the expense it saves both come from this
describe('calculateReceiptSplitTotals', () => {
  const items = [
    { id: 'i1', totalPrice: 1001 },
    { id: 'i2', totalPrice: 2000 },
    { id: 'i3', totalPrice: 999 },
  ];

  test('is calculateSplitTotals by item id and user id, in the order it returns people', () => {
    const totals = calculateReceiptSplitTotals({
      items,
      assignments: [
        { receiptItemId: 'i2', userIds: ['bob'] },
        { receiptItemId: 'i1', userIds: ['carol', 'alice'] },
        { receiptItemId: 'i3', userIds: ['alice'] },
      ],
      tax: 333,
      tip: 401,
    });
    const byIndex = calculateSplitTotals({
      items,
      assignments: [
        { itemIndex: 1, personIndices: [0] },
        { itemIndex: 0, personIndices: [1, 2] },
        { itemIndex: 2, personIndices: [2] },
      ],
      tax: 333,
      tip: 401,
      peopleCount: 3,
    });

    const userIds = ['bob', 'carol', 'alice'];
    expect(totals).toEqual(byIndex.map(({ personIndex, ...rest }) => ({ userId: userIds[personIndex], ...rest })));
  });

  test('shares tax over the item prices (the numbers in the issue)', () => {
    const totals = calculateReceiptSplitTotals({
      items: [
        { id: 'i1', totalPrice: 2000 },
        { id: 'i2', totalPrice: 2000 },
        { id: 'i3', totalPrice: 1000 },
      ],
      assignments: [
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: ['bob'] },
        { receiptItemId: 'i3', userIds: ['carol'] },
      ],
      tax: 400,
      tip: 0,
    });

    expect(totals.map((p) => [p.userId, p.tax, p.total])).toEqual([
      ['alice', 160, 2160],
      ['bob', 160, 2160],
      ['carol', 80, 1080],
    ]);
  });

  test('leaves out an assignment to an item that is not in the list', () => {
    const totals = calculateReceiptSplitTotals({
      items,
      assignments: [
        { receiptItemId: 'deleted', userIds: ['dave'] },
        { receiptItemId: 'i1', userIds: ['alice'] },
      ],
      tax: 0,
      tip: 0,
    });

    expect(totals).toEqual([{ userId: 'alice', itemTotal: 1001, tax: 0, tip: 0, total: 1001 }]);
  });

  test('gives the whole tax and tip to the items assigned, which is why the server requires every item', () => {
    const totals = calculateReceiptSplitTotals({
      items: [
        { id: 'i1', totalPrice: 1000 },
        { id: 'i2', totalPrice: 1000 },
      ],
      assignments: [{ receiptItemId: 'i1', userIds: ['alice'] }],
      tax: 200,
      tip: 100,
    });

    expect(totals).toEqual([{ userId: 'alice', itemTotal: 1000, tax: 200, tip: 100, total: 1300 }]);
  });

  test('returns people in the order they first appear, the first taking a leftover cent on a tie', () => {
    const totals = calculateReceiptSplitTotals({
      items: [
        { id: 'i1', totalPrice: 1000 },
        { id: 'i2', totalPrice: 1000 },
        { id: 'i3', totalPrice: 1000 },
      ],
      assignments: [
        { receiptItemId: 'i3', userIds: ['carol'] },
        { receiptItemId: 'i1', userIds: ['alice'] },
        { receiptItemId: 'i2', userIds: ['bob'] },
      ],
      tax: 100,
      tip: 0,
    });

    // 33.33 cents of tax each: the leftover cent goes to the first in the order (#331)
    expect(totals.map((p) => [p.userId, p.total])).toEqual([
      ['carol', 1034],
      ['alice', 1033],
      ['bob', 1033],
    ]);
  });

  test('returns nobody for no assignments', () => {
    expect(calculateReceiptSplitTotals({ items, assignments: [], tax: 100, tip: 50 })).toEqual([]);
  });
});

describe('receiptAssignmentList', () => {
  const items = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }];

  test('lists the items that have someone in receipt order, each with its people in the order held', () => {
    expect(receiptAssignmentList(items, { i3: new Set(['bob', 'alice']), i1: new Set(['alice']) })).toEqual([
      { receiptItemId: 'i1', userIds: ['alice'] },
      { receiptItemId: 'i3', userIds: ['bob', 'alice'] },
    ]);
  });

  // #411: removing an item kept its key, which was counted as assigned and sent
  test('leaves out an item deleted from the receipt and an item with nobody', () => {
    expect(receiptAssignmentList(items, { deleted: new Set(['alice']), i2: new Set(), i3: new Set(['bob']) })).toEqual([
      { receiptItemId: 'i3', userIds: ['bob'] },
    ]);
  });
});

// #408: Quick Split showed the scanned subtotal and total, which stop matching what people owe once
// an item is edited, added or deleted, or the tip changes
describe('billTotals', () => {
  const items = [{ totalPrice: 899 }, { totalPrice: 1250 }, { totalPrice: 401 }];

  test("is the items' prices added up, then tax and tip on top", () => {
    expect(billTotals(items, 204, 500)).toEqual({ subtotal: 2550, total: 3254 });
  });

  test('is what everyone owes once every item has someone', () => {
    const assignments = [
      { itemIndex: 0, personIndices: [0] },
      { itemIndex: 1, personIndices: [0, 1, 2] },
      { itemIndex: 2, personIndices: [2] },
    ];
    const owed = calculateSplitTotals({ items, assignments, tax: 333, tip: 777, peopleCount: 3 });
    expect(owed.reduce((sum, p) => sum + p.total, 0)).toBe(billTotals(items, 333, 777).total);
  });

  test('comes to the tax and tip alone with no items', () => {
    expect(billTotals([], 100, 50)).toEqual({ subtotal: 0, total: 150 });
  });
});
