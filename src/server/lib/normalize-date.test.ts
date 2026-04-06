import { describe, test, expect } from "vitest";
import { normalizeDate } from "./normalize-date";

describe("normalizeDate", () => {
  // ── Passthrough ──
  test("returns undefined for undefined input", () => {
    expect(normalizeDate(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(normalizeDate("")).toBeUndefined();
  });

  test("passes through valid ISO dates unchanged", () => {
    expect(normalizeDate("2025-03-12")).toBe("2025-03-12");
  });

  test("trims whitespace from ISO dates", () => {
    expect(normalizeDate("  2025-03-12  ")).toBe("2025-03-12");
  });

  // ── Unambiguous (one number > 12) ──
  test("handles DD/MM/YYYY when day > 12", () => {
    expect(normalizeDate("25/03/2025")).toBe("2025-03-25");
  });

  test("handles MM/DD/YYYY when day > 12", () => {
    expect(normalizeDate("03/25/2025")).toBe("2025-03-25");
  });

  // ── 2-digit years ──
  test("expands 2-digit year < 50 to 2000s", () => {
    expect(normalizeDate("03/25/25")).toBe("2025-03-25");
  });

  test("expands 2-digit year >= 50 to 1900s", () => {
    expect(normalizeDate("03/25/99")).toBe("1999-03-25");
  });

  // ── #45: Separator-aware disambiguation ──
  test("dot separator treats ambiguous date as DD.MM (European)", () => {
    expect(normalizeDate("12.03.2025")).toBe("2025-03-12");
  });

  test("dash separator treats ambiguous date as DD-MM (European)", () => {
    expect(normalizeDate("05-04-2025")).toBe("2025-04-05");
  });

  test("slash separator treats ambiguous date as MM/DD (US)", () => {
    expect(normalizeDate("05/04/2025")).toBe("2025-05-04");
  });

  // ── #49: Unparseable dates return undefined ──
  test("returns undefined for written-out dates like 'April 5, 2026'", () => {
    expect(normalizeDate("April 5, 2026")).toBeUndefined();
  });

  test("returns undefined for '5 Apr 2026'", () => {
    expect(normalizeDate("5 Apr 2026")).toBeUndefined();
  });

  test("returns undefined for 'Mon 04/05/2026'", () => {
    expect(normalizeDate("Mon 04/05/2026")).toBeUndefined();
  });

  test("returns undefined for ISO timestamps with time", () => {
    expect(normalizeDate("2026-04-05T12:30:00")).toBeUndefined();
  });

  // ── Edge: invalid day/month range ──
  test("returns undefined for out-of-range month/day", () => {
    expect(normalizeDate("00/32/2025")).toBeUndefined();
  });
});
