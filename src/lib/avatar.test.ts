import { describe, it, expect } from "vitest";
import { avatarColor, guestAvatarColor, getInitials } from "./avatar";

describe("avatarColor", () => {
  it("returns a Tailwind bg class", () => {
    expect(avatarColor("user-123")).toMatch(/^bg-\w+-500$/);
  });

  it("returns the same color for the same userId", () => {
    expect(avatarColor("abc")).toBe(avatarColor("abc"));
  });

  it("returns different colors for different userIds", () => {
    const colors = new Set(["a", "b", "c", "d", "e"].map(avatarColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("guestAvatarColor", () => {
  it("returns a guest color class", () => {
    expect(guestAvatarColor(0)).toContain("bg-");
    expect(guestAvatarColor(0)).toContain("text-");
  });

  it("wraps around at palette length", () => {
    expect(guestAvatarColor(0)).toBe(guestAvatarColor(8));
  });

  it("handles negative index", () => {
    expect(guestAvatarColor(-1)).toMatch(/^bg-/);
  });

  it("handles non-integer index", () => {
    expect(guestAvatarColor(1.7)).toMatch(/^bg-/);
  });
});

describe("getInitials", () => {
  it("returns first letters of name parts", () => {
    expect(getInitials("Alice Johnson")).toBe("AJ");
  });

  it("limits to 2 characters", () => {
    expect(getInitials("Alice Bob Charlie")).toBe("AB");
  });

  it("falls back to email initial", () => {
    expect(getInitials(null, "alice@test.com")).toBe("A");
  });

  it("returns ? when no name or email", () => {
    expect(getInitials(null, null)).toBe("?");
  });

  it("handles single name", () => {
    expect(getInitials("Alice")).toBe("A");
  });

  it("uppercases", () => {
    expect(getInitials("alice johnson")).toBe("AJ");
  });
});
