import { describe, test, expect } from 'vitest';
import { calculateClaimTotals, calculateSplitTotals, groupSizeWeights, personItemShares } from './split-calculator';

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
    // Person 1 has 40% of subtotal → gets remainder of tax
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
      personWeights: [2, 1], // 2/3 = 666.67 cents → floor to 666, remainder goes to last
    });

    expect(results).toHaveLength(2);
    const person0 = results.find((r) => r.personIndex === 0)!;
    const person1 = results.find((r) => r.personIndex === 1)!;
    // 1000 * 2/3 = 666.67 → floor = 666; last person gets 1000 - 666 = 334
    expect(person0.itemTotal).toBe(666);
    expect(person1.itemTotal).toBe(334);
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

  test('weights a shared item by group size, the last person on it taking the leftover cent', () => {
    const params = {
      items: [{ totalPrice: 100 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      personWeights: [1, 2],
    };

    expect(personItemShares(0, params)).toEqual([
      { itemIndex: 0, amount: 33, share: { numerator: 1, denominator: 3 } },
    ]);
    expect(personItemShares(1, params)).toEqual([
      { itemIndex: 0, amount: 67, share: { numerator: 2, denominator: 3 } },
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
