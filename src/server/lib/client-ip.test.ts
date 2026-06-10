import { describe, test, expect } from "vitest";
import { getClientIp } from "./client-ip";

describe("getClientIp", () => {
  test("returns x-forwarded-for when it contains a single IP", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  test("returns first IP from comma-separated x-forwarded-for list", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 198.51.100.2, 192.0.2.1",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  test("trims whitespace around the first x-forwarded-for entry", () => {
    const headers = new Headers({
      "x-forwarded-for": "  203.0.113.7 , 198.51.100.2",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  test("prefers x-forwarded-for over x-real-ip", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.2",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  test("prefers cf-connecting-ip over forwarded headers", () => {
    const headers = new Headers({
      "cf-connecting-ip": "192.0.2.99",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.2",
    });
    expect(getClientIp(headers)).toBe("192.0.2.99");
  });

  test("trims whitespace from cf-connecting-ip", () => {
    const headers = new Headers({ "cf-connecting-ip": " 192.0.2.99 " });
    expect(getClientIp(headers)).toBe("192.0.2.99");
  });

  test("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.2" });
    expect(getClientIp(headers)).toBe("198.51.100.2");
  });

  test("trims whitespace from x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": " 198.51.100.2 " });
    expect(getClientIp(headers)).toBe("198.51.100.2");
  });

  test("falls back to x-real-ip when x-forwarded-for is empty", () => {
    const headers = new Headers({
      "x-forwarded-for": "  ",
      "x-real-ip": "198.51.100.2",
    });
    expect(getClientIp(headers)).toBe("198.51.100.2");
  });

  test("returns the default fallback when no headers are present", () => {
    expect(getClientIp(new Headers())).toBe("global");
  });

  test("returns the default fallback when headers are empty strings", () => {
    const headers = new Headers({ "x-forwarded-for": "", "x-real-ip": "" });
    expect(getClientIp(headers)).toBe("global");
  });

  test("takes only the first comma entry from cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "192.0.2.99, 203.0.113.7",
    });
    expect(getClientIp(headers)).toBe("192.0.2.99");
  });

  test("takes only the first comma entry from x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.2, 203.0.113.7" });
    expect(getClientIp(headers)).toBe("198.51.100.2");
  });

  test("falls through when cf-connecting-ip is only whitespace and commas", () => {
    const headers = new Headers({
      "cf-connecting-ip": " , ",
      "x-forwarded-for": "203.0.113.7",
    });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  test("caps oversized header values at 64 characters", () => {
    const garbage = "a".repeat(10_000);
    const headers = new Headers({ "x-forwarded-for": garbage });
    const result = getClientIp(headers);
    expect(result.length).toBe(64);
    expect(result).toBe("a".repeat(64));
  });
});
