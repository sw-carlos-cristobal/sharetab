import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";

/**
 * Mock AI provider for testing. Returns deterministic receipt data
 * without calling any external API.
 */
export class MockProvider implements AIProvider {
  readonly name = "mock";

  async extractReceipt(
    _imageBuffer: Buffer,
    _mimeType: string,
    correctionHint?: string
  ): Promise<ReceiptExtractionResult> {
    // Simulate a small delay like a real API call
    await new Promise((resolve) => setTimeout(resolve, 100));

    const items = [
      { name: "Grilled Salmon", quantity: 1, unitPrice: 1895, totalPrice: 1895 },
      { name: "Caesar Salad", quantity: 1, unitPrice: 1295, totalPrice: 1295 },
      { name: "Mushroom Risotto", quantity: 1, unitPrice: 1695, totalPrice: 1695 },
      { name: "Garlic Bread", quantity: 2, unitPrice: 495, totalPrice: 990 },
      { name: "Tomato Soup", quantity: 1, unitPrice: 895, totalPrice: 895 },
      { name: "Fish Tacos", quantity: 3, unitPrice: 550, totalPrice: 1650 },
      { name: "Margherita Pizza", quantity: 1, unitPrice: 1495, totalPrice: 1495 },
      { name: "Chicken Wings", quantity: 1, unitPrice: 1195, totalPrice: 1195 },
      { name: "French Fries", quantity: 2, unitPrice: 595, totalPrice: 1190 },
      { name: "Iced Tea", quantity: 3, unitPrice: 350, totalPrice: 1050 },
      { name: "Lemonade", quantity: 2, unitPrice: 395, totalPrice: 790 },
      { name: "Chocolate Cake", quantity: 1, unitPrice: 895, totalPrice: 895 },
      { name: "Tiramisu", quantity: 1, unitPrice: 995, totalPrice: 995 },
      { name: "Espresso", quantity: 2, unitPrice: 350, totalPrice: 700 },
      { name: "Sparkling Water", quantity: 1, unitPrice: 295, totalPrice: 295 },
      { name: "Bruschetta", quantity: 1, unitPrice: 795, totalPrice: 795 },
      { name: "Mozzarella Sticks", quantity: 1, unitPrice: 895, totalPrice: 895 },
      { name: "Cheesecake", quantity: 1, unitPrice: 995, totalPrice: 995 },
    ];

    // If a correction hint is provided, add an extra item to show it was applied
    if (correctionHint) {
      items.push({ name: "Corrected Item", quantity: 1, unitPrice: 100, totalPrice: 100 });
    }

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const tax = Math.round(subtotal * 0.08); // 8% tax
    const tip = 0;
    const total = subtotal + tax + tip;

    return {
      merchantName: "The Golden Fork",
      date: "2025-03-15",
      items,
      subtotal,
      tax,
      tip,
      total,
      currency: "USD",
      confidence: 0.95,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
