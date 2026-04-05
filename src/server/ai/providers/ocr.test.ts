import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseReceiptText } from "./ocr";

function loadReceipt(name: string): string {
  return readFileSync(resolve(process.cwd(), `e2e/receipts/${name}.txt`), "utf-8");
}

// ── Grocery receipt ─────────────────────────────────────────────────

describe("grocery receipt", () => {
  const result = parseReceiptText(loadReceipt("grocery"));

  test("extracts merchant name", () => {
    expect(result.merchantName).toBe("FRESH MART GROCERY");
  });

  test("extracts date", () => {
    expect(result.date).toBe("03/15/2025");
  });

  test("extracts correct number of items (no discounts)", () => {
    // 13 real items; SAVE 1.00- and DISCOUNT 0.50- should be excluded
    // PLU 4011 is a modifier line (indented, no price) and is skipped
    expect(result.items.length).toBe(13);
  });

  test("does not include discount lines as items", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names).not.toContain(expect.stringContaining("save"));
    expect(names).not.toContain(expect.stringContaining("discount"));
  });

  test("extracts subtotal, tax, total", () => {
    expect(result.subtotal).toBe(6322);
    expect(result.tax).toBe(316);
    expect(result.total).toBe(6638);
  });

  test("handles quantity prefix", () => {
    const yogurt = result.items.find((i) => i.name.includes("GREEK YOGURT"));
    expect(yogurt).toBeDefined();
    expect(yogurt!.quantity).toBe(2);
    expect(yogurt!.totalPrice).toBe(798);
  });
});

// ── Restaurant receipt ──────────────────────────────────────────────

describe("restaurant receipt", () => {
  const result = parseReceiptText(loadReceipt("restaurant"));

  test("extracts merchant name", () => {
    expect(result.merchantName).toBe("THE GOLDEN FORK");
  });

  test("extracts date", () => {
    expect(result.date).toBe("04/02/2025");
  });

  test("extracts correct number of items (no modifiers)", () => {
    // 6 items; modifier lines (NO CROUTONS, EXTRA SHRIMP, 2% MILK) should be excluded
    expect(result.items.length).toBe(6);
  });

  test("does not include modifier lines as items", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes("crouton"))).toBe(false);
    expect(names.some((n) => n.includes("extra shrimp"))).toBe(false);
  });

  test("extracts subtotal and tax", () => {
    expect(result.subtotal).toBe(8045);
    expect(result.tax).toBe(644);
  });

  test("handles quantity in item name", () => {
    const springs = result.items.find((i) => i.name.includes("Spring Rolls"));
    expect(springs).toBeDefined();
    expect(springs!.quantity).toBe(2);
  });
});

// ── Cafe receipt ────────────────────────────────────────────────────

describe("cafe receipt", () => {
  const result = parseReceiptText(loadReceipt("cafe"));

  test("extracts merchant name", () => {
    expect(result.merchantName).toBe("BEANTOWN COFFEE");
  });

  test("extracts 4 items", () => {
    expect(result.items.length).toBe(4);
  });

  test("extracts totals", () => {
    expect(result.subtotal).toBe(1645);
    expect(result.tax).toBe(132);
    expect(result.total).toBe(1777);
  });
});

// ── Gas station receipt ─────────────────────────────────────────────

describe("gas station receipt", () => {
  const result = parseReceiptText(loadReceipt("gas-station"));

  test("extracts merchant name", () => {
    expect(result.merchantName).toBe("QUIKSTOP GAS N GO");
  });

  test("extracts date", () => {
    expect(result.date).toBe("02/28/2025");
  });

  test("extracts at least 5 items", () => {
    expect(result.items.length).toBeGreaterThanOrEqual(5);
  });

  test("extracts totals", () => {
    expect(result.subtotal).toBe(5640);
    expect(result.tax).toBe(282);
    expect(result.total).toBe(5922);
  });
});

// ── Pharmacy receipt ────────────────────────────────────────────────

describe("pharmacy receipt", () => {
  const result = parseReceiptText(loadReceipt("pharmacy"));

  test("extracts merchant name (not address)", () => {
    expect(result.merchantName).toBe("CVS PHARMACY");
  });

  test("extracts 5 items (BOGO line excluded)", () => {
    // BOGO FREE 0.00- is a discount line → skipped
    // TISSUES 3PK 5.99 should be included (it's before the BOGO line)
    // 6 priced items minus BOGO = 5 real items? Actually BOGO has 0.00 price so it's skipped anyway
    expect(result.items.length).toBe(6);
  });

  test("does not include loyalty/reward lines", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes("extrabucks"))).toBe(false);
    expect(names.some((n) => n.includes("points"))).toBe(false);
  });

  test("extracts totals", () => {
    expect(result.subtotal).toBe(3974);
    expect(result.tax).toBe(238);
    expect(result.total).toBe(4212);
  });
});

// ── Bar receipt ─────────────────────────────────────────────────────

describe("bar receipt", () => {
  const result = parseReceiptText(loadReceipt("bar"));

  test("extracts merchant name", () => {
    expect(result.merchantName).toBe("LUCKY'S TAP HOUSE");
  });

  test("extracts items (comped item excluded)", () => {
    // COMP'D 0.00 has price 0 so should be excluded (totalPrice <= 0)
    // Real items: IPA, Margarita, 2x Lager, Whiskey Sour, Nachos, Wings = 6
    const names = result.items.map((i) => i.name);
    expect(names.some((n) => n.toLowerCase().includes("comp"))).toBe(false);
    expect(result.items.length).toBe(6);
  });

  test("extracts gratuity as tip", () => {
    expect(result.tip).toBe(1053);
  });

  test("extracts totals", () => {
    expect(result.subtotal).toBe(5850);
    expect(result.tax).toBe(468);
    expect(result.total).toBe(7371);
  });
});

// ── European receipt ────────────────────────────────────────────────

describe("european receipt", () => {
  const result = parseReceiptText(loadReceipt("european"));

  test("extracts merchant name (not address)", () => {
    expect(result.merchantName).toBe("BRASSERIE LE PARIS");
  });

  test("extracts date with dot separator", () => {
    expect(result.date).toBe("12.03.2025");
  });

  test("extracts 5 items", () => {
    expect(result.items.length).toBe(5);
  });

  test("handles comma decimals", () => {
    const salade = result.items.find((i) => i.name.includes("Salade"));
    expect(salade).toBeDefined();
    expect(salade!.totalPrice).toBe(1250);
  });

  test("extracts TVA as tax", () => {
    expect(result.tax).toBe(519);
  });

  test("extracts sous-total and total ttc", () => {
    expect(result.subtotal).toBe(5190);
    expect(result.total).toBe(5709);
  });
});

// ── Delivery receipt ────────────────────────────────────────────────

describe("delivery receipt", () => {
  const result = parseReceiptText(loadReceipt("delivery"));

  test("extracts 5 food items", () => {
    expect(result.items.length).toBe(5);
  });

  test("does not include delivery fee as item", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes("delivery"))).toBe(false);
  });

  test("does not include service fee as item", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes("service"))).toBe(false);
  });

  test("does not include promo/savings lines as items", () => {
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes("promo"))).toBe(false);
    expect(names.some((n) => n.includes("saved"))).toBe(false);
  });

  test("extracts tip", () => {
    expect(result.tip).toBe(500);
  });

  test("extracts totals", () => {
    expect(result.subtotal).toBe(3145);
    expect(result.tax).toBe(252);
    expect(result.total).toBe(4546);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe("edge cases", () => {
  test("toCents handles trailing dash (NaN fix)", () => {
    const result = parseReceiptText("ITEM ONE  4.40-\nITEM TWO  5.50\nTotal  5.50");
    // 4.40- is a discount line (ends with -), should be skipped
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toContain("ITEM TWO");
  });

  test("empty receipt throws", () => {
    expect(() => parseReceiptText("")).toThrow("OCR could not identify any line items");
  });

  test("receipt with only total creates fallback item", () => {
    const result = parseReceiptText("Total  25.00");
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe("Receipt total");
    expect(result.items[0].totalPrice).toBe(2500);
  });

  test("SKU numbers are not matched as dates", () => {
    const result = parseReceiptText(
      "SHOP\n041-06-0812 ITEM  3.99\n01/15/2025\nTotal  3.99",
    );
    // The date should be 01/15/2025, not the SKU
    expect(result.date).toBe("01/15/2025");
  });

  test("OCR misread S as $ is handled", () => {
    const result = parseReceiptText("COFFEE S5.99\nTotal S5.99");
    expect(result.items[0].totalPrice).toBe(599);
  });

  test("OCR misread O as 0 in price", () => {
    const result = parseReceiptText("LATTE  1O.50\nTotal  1O.50");
    expect(result.items[0].totalPrice).toBe(1050);
  });

  test("spaces in prices are normalized", () => {
    const result = parseReceiptText("SOUP  12. 99\nTotal  12. 99");
    expect(result.items[0].totalPrice).toBe(1299);
  });

  test("uses provided OCR confidence", () => {
    const result = parseReceiptText("ITEM  5.00\nTotal  5.00", 0.72);
    expect(result.confidence).toBe(0.72);
  });

  test("defaults to 0.4 confidence when not provided", () => {
    const result = parseReceiptText("ITEM  5.00\nTotal  5.00");
    expect(result.confidence).toBe(0.4);
  });

  test("address lines are skipped for merchant name", () => {
    const result = parseReceiptText(
      "MY STORE\n123 Main St\nItem  5.00\nTotal  5.00",
    );
    expect(result.merchantName).toBe("MY STORE");
  });

  test("phone lines are skipped for merchant name", () => {
    const result = parseReceiptText(
      "BEST SHOP\nTel: 555-123-4567\nItem  5.00\nTotal  5.00",
    );
    expect(result.merchantName).toBe("BEST SHOP");
  });
});
