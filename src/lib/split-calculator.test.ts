import { describe, test, expect } from "vitest";
import { calculateSplitTotals } from "./split-calculator";

describe("calculateSplitTotals", () => {
  test("splits single item between two people equally", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0].itemTotal).toBe(500);
    expect(results[1].itemTotal).toBe(500);
    expect(results[0].total).toBe(500);
    expect(results[1].total).toBe(500);
  });

  test("handles odd-cent splits with remainder going to first person", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1001 }], // $10.01 — can't split evenly
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    expect(results).toHaveLength(2);
    // First person gets the extra cent
    expect(results[0].itemTotal + results[1].itemTotal).toBe(1001);
    expect(Math.abs(results[0].itemTotal - results[1].itemTotal)).toBe(1);
  });

  test("distributes tax proportionally", () => {
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

  test("distributes tip proportionally", () => {
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

  test("total of all persons equals items + tax + tip", () => {
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

  test("handles person with no items assigned", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [{ itemIndex: 0, personIndices: [0] }], // Only person 0
      tax: 100,
      tip: 100,
      peopleCount: 3, // 3 people but only 1 assigned
    });

    // Only person 0 should appear in results
    expect(results).toHaveLength(1);
    expect(results[0].personIndex).toBe(0);
    expect(results[0].total).toBe(1200);
  });

  test("handles empty assignments", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 1000 }],
      assignments: [],
      tax: 100,
      tip: 100,
      peopleCount: 2,
    });

    expect(results).toHaveLength(0);
  });

  test("handles zero-price items", () => {
    const results = calculateSplitTotals({
      items: [{ totalPrice: 0 }],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });

    // Both get 0
    expect(results).toHaveLength(2);
    expect(results[0].total).toBe(0);
    expect(results[1].total).toBe(0);
  });

  test("three-way split with tax and tip totals correctly", () => {
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
});
