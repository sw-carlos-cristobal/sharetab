import { chromium, type BrowserContext, type Page, type Browser } from "@playwright/test";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// Use process.cwd() to avoid __dirname path mangling on Windows under tsx
const PROJECT_ROOT = process.cwd();
const OUTPUT_DIR = path.join(PROJECT_ROOT, "demo");
const RECEIPT_PATH = path.join(PROJECT_ROOT, "e2e", "test-receipt.png");

// Pacing helpers — give viewers time to absorb each screen
const PAUSE_SHORT = 1500;
const PAUSE_MEDIUM = 2000;
const PAUSE_HERO = 3000;

// Viewports
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };

// ── Helpers ──

async function createRecordingContext(
  browser: Browser,
  viewport: { width: number; height: number },
  colorScheme: "light" | "dark" = "light",
): Promise<BrowserContext> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return browser.newContext({
    viewport,
    recordVideo: { dir: OUTPUT_DIR, size: viewport },
    baseURL: BASE_URL,
    colorScheme,
  });
}

async function loginAs(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/login");
  await page.waitForTimeout(500);
  await page.getByLabel("Email").fill("alice@example.com");
  await page.waitForTimeout(200);
  await page.getByLabel("Password").fill("password123");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForTimeout(800);
  return page;
}

async function getApartmentGroupId(page: Page): Promise<string> {
  const data = await page.evaluate(async () => {
    const query = new URLSearchParams({ input: JSON.stringify({}) }).toString();
    const r = await fetch(`/api/trpc/groups.list?${query}`);
    return r.json();
  });
  const group = data?.result?.data?.json?.find(
    (g: { name: string }) => g.name === "Apartment",
  );
  if (!group) throw new Error("Apartment group not found in seed data");
  return group.id;
}

/** Close context, return the .webm path from the recorded video. */
async function finalizeRecording(page: Page, context: BrowserContext): Promise<string> {
  const video = page.video();
  await context.close();
  const webmPath = await video!.path();
  return webmPath;
}

/** Two-pass ffmpeg conversion: palettegen then paletteuse for high-quality GIF. */
function webmToGif(webmPath: string, gifName: string, fps = 12, width = -1): string {
  const gifPath = path.join(OUTPUT_DIR, gifName);
  const palette = path.join(OUTPUT_DIR, "palette.png");
  const filters = width > 0 ? `fps=${fps},scale=${width}:-1:flags=lanczos` : `fps=${fps}`;
  execSync(
    `ffmpeg -y -i "${webmPath}" -vf "${filters},palettegen=stats_mode=diff" "${palette}"`,
    { stdio: "pipe" },
  );
  execSync(
    `ffmpeg -y -i "${webmPath}" -i "${palette}" -lavfi "${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5" "${gifPath}"`,
    { stdio: "pipe" },
  );
  try {
    fs.unlinkSync(palette);
  } catch {
    /* ignore */
  }
  console.log(`  -> ${gifName}`);
  return gifPath;
}

/** Delete intermediate .webm files (but not the full demo video). */
function cleanupWebm(webmPath: string): void {
  try {
    fs.unlinkSync(webmPath);
  } catch {
    /* ignore */
  }
}

// ── Feature Recorders ──

async function recordDashboard(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, DESKTOP);
  const page = await context.newPage();

  // Login
  await page.goto("/login");
  await page.waitForTimeout(800);
  await page.getByLabel("Email").fill("alice@example.com");
  await page.waitForTimeout(300);
  await page.getByLabel("Password").fill("password123");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  // Let dashboard data load
  await page.waitForSelector("h2:has-text('Groups')", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll down to show group cards and balances
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_SHORT);

  return finalizeRecording(page, context);
}

async function recordAddExpense(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to new expense page
  await page.goto(`/groups/${groupId}/expenses/new`);
  await page.waitForURL(/\/expenses\/new$/, { timeout: 15000 });
  await page.waitForSelector("select#paidBy", { timeout: 10000 });
  await page.waitForTimeout(800);

  // Fill in expense details
  await page.getByLabel("Description").fill("Coffee run");
  await page.waitForTimeout(400);
  await page.getByLabel("Amount").fill("24.50");
  await page.waitForTimeout(400);

  // Select paid by (Alice — first real option)
  await page.locator("select#paidBy").selectOption({ index: 1 });
  await page.waitForTimeout(400);

  // Equal split is default — pause to show the form
  await page.waitForTimeout(PAUSE_SHORT);

  // Submit
  await page.getByRole("button", { name: "Add Expense" }).click();
  await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
  await page.waitForTimeout(PAUSE_MEDIUM);

  return finalizeRecording(page, context);
}

async function recordReceiptScan(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to scan page
  await page.goto(`/groups/${groupId}/scan`);
  await page.waitForTimeout(800);

  // Upload the test receipt
  const fileInput = page.locator("input#receipt");
  await fileInput.setInputFiles(RECEIPT_PATH);

  // Wait for AI processing (can take up to 120s)
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

  // Assign items to people
  const itemCards = page.locator("[class*='border']:has(button:has-text('Alice'))");
  const count = await itemCards.count();
  for (let i = 0; i < Math.min(count, 4); i++) {
    const card = itemCards.nth(i);
    await card.getByRole("button", { name: /Alice/i }).first().click();
    await page.waitForTimeout(400);
    if (i % 2 === 1) {
      await card.getByRole("button", { name: /Bob/i }).first().click();
      await page.waitForTimeout(400);
    }
  }

  // Split all equally for remaining items
  const splitAllBtn = page.getByRole("button", { name: /Split all equally/i });
  if (await splitAllBtn.isVisible()) {
    await splitAllBtn.click();
    await page.waitForTimeout(PAUSE_SHORT);
  }

  // Scroll to per-person totals — hero moment
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
  );
  await page.waitForTimeout(PAUSE_HERO);

  return finalizeRecording(page, context);
}

async function recordSettleUp(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to group
  await page.goto(`/groups/${groupId}`);
  await page.waitForSelector("text=Expenses", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_SHORT);

  // Click a debt row to open settle dialog
  const debtRow = page.locator("text=owes").first();
  if (await debtRow.isVisible()) {
    await debtRow.click();
    await page.waitForTimeout(PAUSE_SHORT);

    // The settle dialog should be open
    const dialog = page.getByText("Record a payment");
    if (await dialog.isVisible()) {
      await page.waitForTimeout(PAUSE_MEDIUM);
      // Close without submitting
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
  }

  await page.waitForTimeout(PAUSE_SHORT);

  return finalizeRecording(page, context);
}

async function recordDarkMode(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  // Pause on light dashboard
  await page.waitForSelector("h2:has-text('Groups')", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_SHORT);

  // Open mobile hamburger menu
  await page.locator("header.lg\\:hidden button, header button").first().click();
  await page.waitForTimeout(800);

  // Wait for sheet and toggle theme
  await page.waitForSelector("[aria-label='Toggle theme']:visible", { timeout: 5000 });
  await page.locator("[aria-label='Toggle theme']:visible").first().click();
  await page.waitForTimeout(PAUSE_SHORT);

  // Close menu
  await page.keyboard.press("Escape");
  await page.waitForTimeout(PAUSE_MEDIUM);

  return finalizeRecording(page, context);
}

async function recordGuestSplit(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await context.newPage();

  // Guest split — no login needed
  await page.goto("/split");
  await page.waitForSelector("text=Split a bill", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_SHORT);

  // Upload receipt via hidden file input
  const guestFileInput = page.locator('input[type="file"]').first();
  await guestFileInput.setInputFiles(RECEIPT_PATH);

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

  // Scroll to per-person totals
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
  );
  await page.waitForTimeout(PAUSE_HERO);

  return finalizeRecording(page, context);
}

async function recordCreateGroup(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  // Navigate to create group page
  await page.goto("/groups/new");
  await page.waitForSelector("text=Create a new group", { timeout: 10000 });
  await page.waitForTimeout(800);

  // Fill in group name
  await page.getByLabel("Group name").fill("Weekend Trip");
  await page.waitForTimeout(400);

  // Fill in description
  await page.getByLabel("Description").fill("Cabin getaway with friends");
  await page.waitForTimeout(400);

  // Click the airplane emoji button
  await page.locator("button", { hasText: "✈️" }).click();
  await page.waitForTimeout(400);

  // Select EUR currency
  await page.locator("select#currency").selectOption("EUR");
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Submit
  await page.getByRole("button", { name: "Create Group" }).click();
  await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
  await page.waitForTimeout(PAUSE_HERO);

  // Clean up: delete the created group via API
  const groupId = page.url().match(/\/groups\/(\w+)/)?.[1];
  if (groupId) {
    await page.evaluate(async (id) => {
      await fetch("/api/trpc/groups.delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { groupId: id } }),
      });
    }, groupId);
  }

  return finalizeRecording(page, context);
}

async function recordSplitModes(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to new expense page
  await page.goto(`/groups/${groupId}/expenses/new`);
  await page.waitForSelector("select#paidBy", { timeout: 10000 });
  await page.waitForTimeout(800);

  // Fill in expense details
  await page.getByLabel("Description").fill("Team dinner");
  await page.waitForTimeout(400);
  await page.getByLabel("Amount").fill("120.00");
  await page.waitForTimeout(400);

  // Select paid by (Alice — first real option)
  await page.locator("select#paidBy").selectOption({ index: 1 });
  await page.waitForTimeout(400);

  // Equal split is default — pause to show it
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Switch to Exact split
  await page.locator("button", { hasText: "Exact" }).click();
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Switch to Percentage split
  await page.locator("button", { hasText: "Percentage" }).click();
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Switch to Shares split
  await page.locator("button", { hasText: "Shares" }).click();
  await page.waitForTimeout(PAUSE_SHORT);

  // Scroll down to show split details
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);

  return finalizeRecording(page, context);
}

async function recordInviteMembers(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to group page
  await page.goto(`/groups/${groupId}`);
  await page.waitForSelector("text=Expenses", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_SHORT);

  // Click the Invite button
  await page.getByRole("button", { name: "Invite" }).click();
  await page.waitForTimeout(800);

  // Wait for invite dialog
  await page.waitForSelector("text=Invite to group", { timeout: 5000 });
  await page.waitForTimeout(500);

  // Generate invite link
  await page.getByRole("button", { name: "Generate invite link" }).click();
  await page.waitForSelector("input[readonly]", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_SHORT);

  // Click copy button
  await page.locator("[data-slot='dialog-content'] button:has(svg)").last().click();
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Close dialog
  await page.keyboard.press("Escape");
  await page.waitForTimeout(PAUSE_SHORT);

  return finalizeRecording(page, context);
}

async function recordGroupSettings(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, MOBILE);
  const page = await loginAs(context);

  const groupId = await getApartmentGroupId(page);

  // Navigate to group settings
  await page.goto(`/groups/${groupId}/settings`);
  await page.waitForSelector("text=Group Settings", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll down to show all sections
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll further to show danger zone
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
  );
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll back up
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_SHORT);

  return finalizeRecording(page, context);
}

async function recordAdminDashboard(browser: Browser): Promise<string> {
  const context = await createRecordingContext(browser, DESKTOP);
  const page = await loginAs(context);

  // Navigate to admin
  await page.goto("/admin");
  await page.waitForSelector("text=Admin Dashboard", { timeout: 10000 });
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll through sections: system health, Meridian auth, OpenAI Codex auth
  await page.evaluate(() => window.scrollTo({ top: 500, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Continue scrolling to show more admin sections
  await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll further to show tools, audit log, etc.
  await page.evaluate(() => window.scrollTo({ top: 2000, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_MEDIUM);

  // Scroll back to top
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(PAUSE_SHORT);

  return finalizeRecording(page, context);
}

// ── Main ──

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  const features = [
    { name: "dashboard", fn: recordDashboard, desktop: true },
    { name: "add-expense", fn: recordAddExpense, desktop: false },
    { name: "receipt-scan", fn: recordReceiptScan, desktop: false },
    { name: "settle-up", fn: recordSettleUp, desktop: false },
    { name: "dark-mode", fn: recordDarkMode, desktop: false },
    { name: "guest-split", fn: recordGuestSplit, desktop: false },
    { name: "create-group", fn: recordCreateGroup, desktop: false },
    { name: "split-modes", fn: recordSplitModes, desktop: false },
    { name: "invite-members", fn: recordInviteMembers, desktop: false },
    { name: "group-settings", fn: recordGroupSettings, desktop: false },
    { name: "admin-dashboard", fn: recordAdminDashboard, desktop: true },
  ];

  // Filter by CLI args: `tsx e2e/demo-gifs.ts dashboard dark-mode admin-dashboard`
  const only = process.argv.slice(2);
  const filtered = only.length > 0 ? features.filter((f) => only.includes(f.name)) : features;
  if (filtered.length === 0) {
    console.error(`No matching features. Available: ${features.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }

  for (const { name, fn, desktop } of filtered) {
    console.log(`Recording ${name}...`);
    try {
      const webmPath = await fn(browser);
      // Convert to GIF — desktop clips at 640px wide, mobile at native width
      const gifWidth = desktop ? 640 : -1;
      webmToGif(webmPath, `${name}.gif`, 12, gifWidth);
      cleanupWebm(webmPath);
    } catch (err) {
      console.error(`  FAILED: ${name}`, err);
      // Continue with other features
    }
  }

  await browser.close();
  console.log("All GIFs generated in demo/");
}

main().catch((err) => {
  console.error("Demo GIF recording failed:", err);
  process.exit(1);
});
