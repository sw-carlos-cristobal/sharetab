import { describe, it, expect } from "vitest";
import {
  parseExtractedData,
  parseGuestItems,
  parseGuestPeople,
  parseGuestAssignments,
} from "./json-schemas";

describe("parseExtractedData", () => {
  it("parses valid data", () => {
    const result = parseExtractedData({
      merchantName: "Cafe",
      subtotal: 1000,
      tax: 80,
      tip: 200,
      total: 1280,
      currency: "USD",
    });
    expect(result.subtotal).toBe(1000);
    expect(result.tax).toBe(80);
    expect(result.currency).toBe("USD");
  });

  it("defaults missing numeric fields to 0", () => {
    const result = parseExtractedData({});
    expect(result.subtotal).toBe(0);
    expect(result.tax).toBe(0);
    expect(result.tip).toBe(0);
    expect(result.total).toBe(0);
    expect(result.currency).toBe("USD");
  });

  it("handles null input", () => {
    const result = parseExtractedData(null);
    expect(result.subtotal).toBe(0);
  });

  it("passes through extra fields", () => {
    const result = parseExtractedData({ subtotal: 100, customField: "hello" });
    expect((result as Record<string, unknown>).customField).toBe("hello");
  });
});

describe("parseGuestItems", () => {
  it("parses valid items array", () => {
    const items = parseGuestItems([
      { name: "Pizza", quantity: 1, unitPrice: 1200, totalPrice: 1200 },
      { name: "Soda", quantity: 2, unitPrice: 300, totalPrice: 600 },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("Pizza");
  });

  it("rejects item with missing name", () => {
    expect(() => parseGuestItems([{ quantity: 1, unitPrice: 100, totalPrice: 100 }])).toThrow();
  });

  it("rejects item with zero quantity", () => {
    expect(() => parseGuestItems([{ name: "X", quantity: 0, unitPrice: 100, totalPrice: 100 }])).toThrow();
  });
});

describe("parseGuestPeople", () => {
  it("parses valid people array", () => {
    const people = parseGuestPeople([
      { name: "Alice" },
      { name: "Bob", personToken: "abc-123", groupSize: 2 },
    ]);
    expect(people).toHaveLength(2);
    expect(people[1].groupSize).toBe(2);
  });

  it("rejects person without name", () => {
    expect(() => parseGuestPeople([{}])).toThrow();
  });
});

describe("parseGuestAssignments", () => {
  it("parses valid assignments", () => {
    const assignments = parseGuestAssignments([
      { itemIndex: 0, personIndices: [0, 1] },
      { itemIndex: 1, personIndices: [0] },
    ]);
    expect(assignments).toHaveLength(2);
    expect(assignments[0].personIndices).toEqual([0, 1]);
  });

  it("rejects assignment with missing fields", () => {
    expect(() => parseGuestAssignments([{ itemIndex: 0 }])).toThrow();
  });
});
