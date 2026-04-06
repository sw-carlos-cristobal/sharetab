# ShareTab Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Playwright-scripted browser recording that demos ShareTab's core features (dashboard, expenses, receipt scanning, settlements, dark mode, guest split) for the README.

**Architecture:** Single Playwright script (`e2e/demo-video.ts`) that launches Chromium with video recording enabled, walks through the app using seed data, switches between desktop (1280x720) and mobile (390x844) viewports, and outputs a `.webm` file to `demo/`.

**Tech Stack:** Playwright (video recording), existing e2e helpers, seed data (Alice/Bob/Charlie)

---

## Task 1: Create the demo script scaffold with login and dashboard

**Files:**
- Create: `e2e/demo-video.ts`
- Create: `demo/` (output directory)

- [ ] **Step 1: Create the output directory**

```bash
mkdir -p demo
```

- [ ] **Step 2: Create the demo script with imports, browser launch, and login**

Create `e2e/demo-video.ts`:

```typescript
import { chromium } from "@playwright/test";
import path from "path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUTPUT_DIR = path.resolve(__dirname, "../demo");

// Pacing helpers — give viewers time to absorb each screen
const PAUSE_SHORT = 1500;
const PAUSE_MEDIUM = 2000;
const PAUSE_HERO = 4000;

async function main() {
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
    // Click the Apartment group
    await page.getByText("Apartment").first().click();
    await page.waitForURL(/\/groups\/\w+$/, { timeout: 15000 });
    await page.waitForTimeout(PAUSE_SHORT);

    // Scroll to show expenses
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_MEDIUM);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await page.waitForTimeout(PAUSE_SHORT);

    // ── Scene 4: Add a simple expense ──
    await page.getByRole("link", { name: "Add Expense" }).click();
    await page.waitForURL(/\/expenses\/new$/, { timeout: 15000 });
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
    await fileInput.setInputFiles(path.resolve(__dirname, "test-receipt.png"));

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
    // Open mobile menu
    await page.getByRole("button", { name: /menu/i }).or(page.locator("button:has(svg)").last()).click();
    await page.waitForTimeout(800);

    // Click theme toggle
    await page.getByLabel("Toggle theme").click();
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
    await guestFileInput.setInputFiles(path.resolve(__dirname, "test-receipt.png"));

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
```

- [ ] **Step 3: Test that the script runs and produces a video**

```bash
BASE_URL=http://localhost:3000 npx tsx e2e/demo-video.ts
```

Expected: Script completes, `.webm` file appears in `demo/` directory.

- [ ] **Step 4: Verify the video plays correctly**

```bash
ls -la demo/*.webm
```

Expected: A `.webm` file of 2-5MB.

- [ ] **Step 5: Watch the video and iterate**

Open the `.webm` file in a browser or media player. Check:
- Login is visible and smooth
- Dashboard shows balances and groups
- Group detail shows members and expenses
- Expense creation completes
- Mobile viewport switch is visible
- Receipt scan processes and items appear
- Item assignment clicks are visible
- Settlement dialog opens
- Dark mode toggles visually
- Guest split flow completes

If any scene looks wrong (wrong selectors, timing too fast/slow, elements not found), fix the script and re-run.

- [ ] **Step 6: Commit**

```bash
git add e2e/demo-video.ts demo/
git commit -m "feat: add Playwright demo video script and recording"
```

---

## Task 2: Fix selectors and timing based on first run

This task exists because the first run will almost certainly reveal selector issues. The developer should:

- [ ] **Step 1: Run the script with `headless: false` to watch it live**

Change `headless: true` to `headless: false` in the script temporarily:

```typescript
const browser = await chromium.launch({ headless: false });
```

Then run:

```bash
BASE_URL=http://localhost:3000 npx tsx e2e/demo-video.ts
```

Watch the browser and note which steps fail or look awkward.

- [ ] **Step 2: Fix any broken selectors**

Common issues to watch for:
- `select#paidBy` may need a different selector if the component uses a custom dropdown
- Debt rows may not contain literal "owes" text — check actual rendered text
- Mobile menu button may need a more specific selector
- Item assignment buttons may have different structure than expected
- Guest split file input may not be the first `input[type="file"]`

For each broken selector, inspect the actual DOM (use `page.pause()` if needed) and update the selector.

- [ ] **Step 3: Adjust timing**

If scenes feel too fast or too slow:
- Increase `PAUSE_*` constants for scenes that need more viewing time
- Decrease pauses where the viewer has already absorbed the content
- Add extra pauses after data loads if content pops in late

- [ ] **Step 4: Set headless back to true and do a final recording**

```typescript
const browser = await chromium.launch({ headless: true });
```

```bash
BASE_URL=http://localhost:3000 npx tsx e2e/demo-video.ts
```

- [ ] **Step 5: Verify final video**

Watch the full `.webm` and confirm all 9 scenes look good.

- [ ] **Step 6: Commit fixes**

```bash
git add e2e/demo-video.ts
git commit -m "fix: polish demo video selectors and timing"
```

---

## Task 3: Add demo/ to .gitignore and add npm script

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Add demo output to .gitignore**

The `.webm` files are large and generated — they shouldn't be committed. Add to `.gitignore`:

```
# Demo video output
demo/*.webm
```

- [ ] **Step 2: Add npm script for running the demo**

Add to `package.json` scripts:

```json
"demo": "tsx e2e/demo-video.ts"
```

- [ ] **Step 3: Verify the script runs via npm**

```bash
BASE_URL=http://localhost:3000 npm run demo
```

Expected: Same result as running `npx tsx` directly.

- [ ] **Step 4: Commit**

```bash
git add .gitignore package.json
git commit -m "chore: add demo npm script and gitignore video output"
```
