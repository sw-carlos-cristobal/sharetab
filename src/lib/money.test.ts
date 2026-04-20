import { describe, test, expect } from "vitest";
import { formatCents, parseToCents, centsToDecimal } from "./money";

describe("formatCents", () => {
  test("formats whole dollar amounts", () => {
    expect(formatCents(1000)).toBe("$10.00");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(0)).toBe("$0.00");
  });

  test("formats cents correctly", () => {
    expect(formatCents(1299)).toBe("$12.99");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(50)).toBe("$0.50");
  });

  test("formats large amounts", () => {
    expect(formatCents(10000000)).toBe("$100,000.00");
    expect(formatCents(999999)).toBe("$9,999.99");
  });

  test("formats negative amounts", () => {
    expect(formatCents(-1299)).toBe("-$12.99");
  });

  test("respects currency parameter", () => {
    expect(formatCents(1000, "EUR")).toBe("€10.00");
    expect(formatCents(1000, "GBP")).toBe("£10.00");
  });

  test("formats JPY without decimals", () => {
    const result = formatCents(1000, "JPY");
    expect(result).toContain("10");
  });

  test("respects locale parameter for formatting", () => {
    const result = formatCents(123456, "EUR", "de-DE");
    expect(result).toContain("1.234,56");
  });

  test("defaults to en-US locale when not specified", () => {
    expect(formatCents(1299, "USD")).toBe("$12.99");
    expect(formatCents(1299, "USD", "en-US")).toBe("$12.99");
  });
});

describe("parseToCents", () => {
  test("parses whole numbers", () => {
    expect(parseToCents("10")).toBe(1000);
    expect(parseToCents("1")).toBe(100);
    expect(parseToCents("0")).toBe(0);
  });

  test("parses decimal amounts", () => {
    expect(parseToCents("12.99")).toBe(1299);
    expect(parseToCents("0.01")).toBe(1);
    expect(parseToCents("0.50")).toBe(50);
  });

  test("rounds to nearest cent", () => {
    expect(parseToCents("12.999")).toBe(1300);
    expect(parseToCents("12.994")).toBe(1299);
    expect(parseToCents("0.005")).toBe(1);
  });

  test("returns 0 for invalid input", () => {
    expect(parseToCents("")).toBe(0);
    expect(parseToCents("abc")).toBe(0);
    expect(parseToCents("not-a-number")).toBe(0);
  });

  test("handles negative values", () => {
    expect(parseToCents("-10.50")).toBe(-1050);
  });
});

describe("centsToDecimal", () => {
  test("converts cents to decimal string", () => {
    expect(centsToDecimal(1299)).toBe("12.99");
    expect(centsToDecimal(1000)).toBe("10.00");
    expect(centsToDecimal(1)).toBe("0.01");
    expect(centsToDecimal(0)).toBe("0.00");
  });

  test("handles large amounts", () => {
    expect(centsToDecimal(10000000)).toBe("100000.00");
  });

  test("handles negative amounts", () => {
    expect(centsToDecimal(-1299)).toBe("-12.99");
  });
});
