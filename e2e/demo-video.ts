import { chromium } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// Use process.cwd() to avoid __dirname path mangling on Windows under tsx
const PROJECT_ROOT = process.cwd();
const OUTPUT_DIR = path.join(PROJECT_ROOT, "demo");

// Pacing helpers — give viewers time to absorb each screen
const PAUSE_SHORT = 1500;
const PAUSE_MEDIUM = 2000;
const PAUSE_HERO = 4000;

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUTPUT_DIR, size: { width: 1280, height: 720 } },
    baseURL: BASE_URL,
    colorScheme: "light",
  });
  const page = await context.newPage();

  try {
    // ── Scene 1: Login ──
    await page.goto("/login");
    await page.waitForTimeout(800);
    await page.getByLabel("Email").fill("alice@example.com");
    await page.waitForTimeout(300);
    await page.getByLabel("Password").fill("password123");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 2: Dashboard (desktop) ──
    // Let the dashboard data load fully
    await page.waitForSelector("text=Your Groups", { timeout: 10000 });
    await page.waitForTimeout(PAUSE_MEDIUM);

    // Scroll down slowly to show group cards
    await page.evaluate(() => window.scrollTo({ top: 400, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_MEDIUM);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 3: Group detail ──
    // Find the Apartment group via API and navigate directly (group may not be on first page)
    const groupsData = await page.evaluate(async () => {
      const query = new URLSearchParams({ input: JSON.stringify({}) }).toString();
      const r = await fetch(`/api/trpc/groups.list?${query}`);
      return r.json();
    });
    const apartmentGroup = groupsData?.result?.data?.json?.find(
      (g: { name: string; id: string }) => g.name === "Apartment"
    );
    if (!apartmentGroup) throw new Error("Apartment group not found in seed data");
    await page.goto(`/groups/${apartmentGroup.id}`);
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
    // Wait for group data to load (expenses heading appears after tRPC resolves)
    await page.waitForSelector("text=Expenses", { timeout: 10000 });
    await page.waitForTimeout(PAUSE_SHORT);

    // Scroll to show expenses
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_MEDIUM);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 4: Add a simple expense ──
    // Navigate directly to new expense page (button may be a Button render=Link)
    await page.goto(`/groups/${apartmentGroup.id}/expenses/new`);
    await page.waitForURL(/\/expenses\/new$/, { timeout: 15000 });
    // Wait for the form to load (paidBy select is populated after tRPC resolves)
    await page.waitForSelector("select#paidBy", { timeout: 10000 });
    await page.waitForTimeout(800);

    await page.getByLabel("Description").fill("Coffee run");
    await page.waitForTimeout(300);
    await page.getByLabel("Amount").fill("24.50");
    await page.waitForTimeout(300);

    // Select "Paid by" — pick Alice (first real option)
    await page.locator("select#paidBy").selectOption({ index: 1 });
    await page.waitForTimeout(300);

    // Equal split is default — just submit
    await page.getByRole("button", { name: "Add Expense" }).click();
    // Wait for redirect back to group
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
    await page.waitForTimeout(PAUSE_MEDIUM);

    // ── Scene 5: Switch to mobile viewport ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 6: Receipt scan (hero moment) ──
    // Navigate to scan page for this group
    const groupUrl = page.url();
    await page.goto(groupUrl + "/scan");
    await page.waitForTimeout(800);

    // Upload the test receipt
    const fileInput = page.locator("input#receipt");
    await fileInput.setInputFiles(path.join(PROJECT_ROOT, "e2e", "test-receipt.png"));

    // Wait for AI processing to complete — look for the assignment UI
    await page.waitForSelector("text=Assign items", { timeout: 120000 });
    await page.waitForTimeout(PAUSE_SHORT);

    // Fill in expense title
    await page.getByLabel("Expense title").fill("Lunch receipt");
    await page.waitForTimeout(300);

    // Select paid by
    await page.locator("select#paidBy").selectOption({ index: 1 });
    await page.waitForTimeout(300);

    // View the receipt image
    await page.getByRole("button", { name: /View Receipt/i }).click();
    await page.waitForTimeout(PAUSE_MEDIUM);
    await page.getByRole("button", { name: /Hide Receipt/i }).click();
    await page.waitForTimeout(500);

    // Scroll through items
    await page.evaluate(() => window.scrollTo({ top: 400, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_SHORT);

    // Assign items to people — click member buttons on the first few items
    // Get all the item assignment sections and assign members
    const itemCards = page.locator("[class*='border']:has(button:has-text('Alice'))");
    const count = await itemCards.count();
    for (let i = 0; i < Math.min(count, 4); i++) {
      const card = itemCards.nth(i);
      // Assign to Alice
      await card.getByRole("button", { name: /Alice/i }).first().click();
      await page.waitForTimeout(400);
      // Assign some items also to Bob
      if (i % 2 === 1) {
        await card.getByRole("button", { name: /Bob/i }).first().click();
        await page.waitForTimeout(400);
      }
    }

    // Use "Split all equally" for remaining items
    const splitAllBtn = page.getByRole("button", { name: /Split all equally/i });
    if (await splitAllBtn.isVisible()) {
      await splitAllBtn.click();
      await page.waitForTimeout(PAUSE_SHORT);
    }

    // Scroll to per-person totals
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_HERO);

    // Go back to group
    await page.goto(groupUrl);
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 7: Settlement ──
    // Click a debt row to open settle dialog
    const debtRow = page.locator("text=owes").first();
    if (await debtRow.isVisible()) {
      await debtRow.click();
      await page.waitForTimeout(PAUSE_SHORT);

      // The settle dialog should be open — look for "Record a payment"
      const dialog = page.getByText("Record a payment");
      if (await dialog.isVisible()) {
        await page.waitForTimeout(PAUSE_MEDIUM);
        // Close dialog without submitting
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }
    }

    // ── Scene 8: Dark mode toggle ──
    // Open mobile menu — target the SheetTrigger button in the mobile header
    // The hamburger button is in the mobile header (lg:hidden)
    await page.locator("header.lg\\:hidden button, header button").first().click();
    await page.waitForTimeout(800);

    // Wait for the sheet to open and theme toggle to be visible
    await page.waitForSelector("[aria-label='Toggle theme']:visible", { timeout: 5000 });

    // Click the visible theme toggle (two exist in DOM: sidebar + sheet)
    await page.locator("[aria-label='Toggle theme']:visible").first().click();
    await page.waitForTimeout(PAUSE_SHORT);

    // Close menu
    await page.keyboard.press("Escape");
    await page.waitForTimeout(PAUSE_MEDIUM);

    // ── Scene 9: Guest bill split ──
    await page.goto("/split");
    await page.waitForTimeout(PAUSE_SHORT);

    // The guest split page shows "Split a bill" header
    await page.waitForSelector("text=Split a bill", { timeout: 10000 });
    await page.waitForTimeout(PAUSE_MEDIUM);

    // Upload via gallery (hidden input)
    const guestFileInput = page.locator('input[type="file"]').first();
    await guestFileInput.setInputFiles(path.join(PROJECT_ROOT, "e2e", "test-receipt.png"));

    // Wait for processing
    await page.waitForSelector("text=Who's splitting?", { timeout: 120000 });
    await page.waitForTimeout(800);

    // Add person names
    const personInputs = page.locator('input[placeholder*="Person"]');
    const personCount = await personInputs.count();
    const names = ["Alice", "Bob", "Charlie"];
    for (let i = 0; i < Math.min(personCount, names.length); i++) {
      await personInputs.nth(i).fill(names[i]!);
      await page.waitForTimeout(300);
    }

    // Add a third person if only 2 inputs
    if (personCount < 3) {
      await page.getByRole("button", { name: /Add person/i }).click();
      await page.waitForTimeout(300);
      const newInput = page.locator('input[placeholder*="Person"]').last();
      await newInput.fill("Charlie");
      await page.waitForTimeout(300);
    }

    await page.waitForTimeout(PAUSE_SHORT);

    // Click "Next: Assign Items"
    await page.getByRole("button", { name: /Next.*Assign/i }).click();
    await page.waitForTimeout(PAUSE_SHORT);

    // Split all equally
    const guestSplitAll = page.getByRole("button", { name: /Split all equally/i });
    if (await guestSplitAll.isVisible()) {
      await guestSplitAll.click();
      await page.waitForTimeout(PAUSE_SHORT);
    }

    // Scroll to show per-person totals
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_HERO);

  } finally {
    // Close context to finalize video
    await context.close();
    await browser.close();
  }

  console.log(`Demo video saved to ${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error("Demo recording failed:", err);
  process.exit(1);
});
