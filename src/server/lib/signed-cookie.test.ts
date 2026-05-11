import { describe, it, expect, beforeAll } from "vitest";
import { signPayload, verifyAndParse } from "./signed-cookie";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-signing";
});

describe("signPayload / verifyAndParse", () => {
  it("round-trips valid JSON", () => {
    const payload = JSON.stringify({ adminId: "abc", targetId: "xyz" });
    const signed = signPayload(payload);
    const parsed = verifyAndParse<{ adminId: string; targetId: string }>(signed);
    expect(parsed).toEqual({ adminId: "abc", targetId: "xyz" });
  });

  it("rejects tampered payload", () => {
    const signed = signPayload(JSON.stringify({ adminId: "abc" }));
    const tampered = signed.replace("abc", "xyz");
    expect(verifyAndParse(tampered)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const signed = signPayload(JSON.stringify({ adminId: "abc" }));
    const parts = signed.split(".");
    parts[parts.length - 1] = "0".repeat(64);
    expect(verifyAndParse(parts.join("."))).toBeNull();
  });

  it("rejects unsigned input (no dot separator)", () => {
    expect(verifyAndParse('{"adminId":"abc"}')).toBeNull();
  });

  it("rejects malformed JSON with valid-looking signature", () => {
    const signed = signPayload("not-valid-json");
    expect(verifyAndParse(signed)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifyAndParse("")).toBeNull();
  });

  it("rejects signature with wrong length", () => {
    const signed = signPayload(JSON.stringify({ test: true }));
    const lastDot = signed.lastIndexOf(".");
    const shortSig = signed.substring(0, lastDot) + ".abcd";
    expect(verifyAndParse(shortSig)).toBeNull();
  });
});
