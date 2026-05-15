/**
 * Generate realistic receipt images from HTML templates using Playwright.
 * Run: npx playwright test e2e/generate-receipt-images.mjs (or just `node e2e/generate-receipt-images.mjs`)
 *
 * Outputs PNG files to e2e/receipts/
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const OUT_DIR = resolve("e2e/receipts");
mkdirSync(OUT_DIR, { recursive: true });

const RECEIPT_CSS = `
  body {
    margin: 0; padding: 0; background: #fff;
    display: flex; justify-content: center;
  }
  .receipt {
    font-family: 'Courier New', Courier, monospace;
    font-size: 13px;
    line-height: 1.5;
    padding: 20px 16px;
    width: 320px;
    color: #111;
    background: #fefefe;
  }
  .receipt-thermal {
    font-size: 12px;
    width: 280px;
    background: #f9f5ee;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: bold; }
  .line { border-top: 1px dashed #999; margin: 6px 0; }
  .dline { border-top: 2px solid #333; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; }
  .row .name { flex: 1; overflow: hidden; }
  .row .price { text-align: right; white-space: nowrap; padding-left: 8px; }
  .indent { padding-left: 16px; font-size: 11px; color: #555; }
  .header { font-size: 16px; font-weight: bold; text-align: center; margin-bottom: 2px; }
  .subheader { font-size: 11px; text-align: center; color: #444; }
  .total-row { font-weight: bold; font-size: 14px; }
  .small { font-size: 10px; color: #666; }
`;

function receiptHtml(body, extraClass = "") {
  return `<!DOCTYPE html><html><head><style>${RECEIPT_CSS}</style></head><body><div class="receipt ${extraClass}">${body}</div></body></html>`;
}

function row(name, price, cls = "") {
  return `<div class="row ${cls}"><span class="name">${name}</span><span class="price">${price}</span></div>`;
}

// ── Receipt templates ───────────────────────────────────────────────

const receipts = {
  // 1. Fast food / burger joint
  "fast-food": receiptHtml(`
    <div class="header">BURGER BARN</div>
    <div class="subheader">4521 Highway 6 South<br>Houston, TX 77083<br>(281) 555-0199</div>
    <div class="line"></div>
    <div class="center small">Order #2847 &bull; 03/15/2026 11:42 AM</div>
    <div class="line"></div>
    ${row("Classic Burger", "8.99")}
    ${row("Bacon Cheeseburger", "11.49")}
    ${row("Chicken Tenders (6pc)", "7.99")}
    ${row("Large Fries", "4.49")}
    ${row("Large Fries", "4.49")}
    ${row("Onion Rings", "5.29")}
    ${row("Milkshake - Vanilla", "5.99")}
    ${row("Soft Drink LG", "2.79")}
    ${row("Soft Drink LG", "2.79")}
    <div class="line"></div>
    ${row("Subtotal", "54.31")}
    ${row("Tax (8.25%)", "4.48")}
    <div class="dline"></div>
    ${row("TOTAL", "$58.79", "total-row")}
    <div class="line"></div>
    ${row("Visa ****3847", "$58.79")}
    <div class="center small" style="margin-top:8px">Thank you! Visit us again!</div>
  `, "receipt-thermal"),

  // 2. Upscale restaurant with wine and modifiers
  "fine-dining": receiptHtml(`
    <div class="header">MAISON CLAIRE</div>
    <div class="subheader">212 West 4th Street<br>Austin, TX 78701</div>
    <div class="line"></div>
    <div class="center small">Table 7 &bull; Server: Antoine<br>04/01/2026 8:15 PM &bull; Guests: 4</div>
    <div class="line"></div>
    ${row("French Onion Soup", "14.00")}
    ${row("Caesar Salad", "12.00")}
    <div class="indent">add anchovies</div>
    ${row("Beef Wellington", "58.00")}
    <div class="indent">medium rare</div>
    ${row("Pan-Seared Halibut", "42.00")}
    ${row("Truffle Risotto", "28.00")}
    ${row("Rack of Lamb", "52.00")}
    <div class="indent">mint jelly on side</div>
    ${row("Chocolate Souffl&eacute;", "16.00")}
    ${row("Cr&egrave;me Br&ucirc;l&eacute;e", "14.00")}
    <div class="line"></div>
    ${row("Bottle - Ch&acirc;teau Margaux 2018", "185.00")}
    ${row("2x Glass Pinot Noir", "32.00")}
    ${row("Espresso", "4.00")}
    ${row("Espresso", "4.00")}
    <div class="line"></div>
    ${row("Subtotal", "461.00")}
    ${row("Tax", "38.03")}
    <div class="dline"></div>
    ${row("Total", "$499.03", "total-row")}
    <div class="line"></div>
    <div class="center small">Tip ________<br>Total ________<br><br>Merchant Copy</div>
  `),

  // 3. Grocery store with weight items and savings
  "grocery-store": receiptHtml(`
    <div class="header">FRESH MARKET</div>
    <div class="subheader">900 Congress Ave<br>Austin, TX 78701<br>Tel: (512) 555-0234</div>
    <div class="line"></div>
    <div class="center small">03/20/2026 09:15 AM &bull; Cashier: Maria</div>
    <div class="line"></div>
    ${row("Organic Bananas", "1.29")}
    ${row("Whole Milk 1 Gal", "4.49")}
    ${row("Eggs Large Dozen", "3.99")}
    ${row("Sourdough Bread", "5.49")}
    ${row("Chicken Breast", "8.76")}
    <div class="indent">1.92 lb @ $4.56/lb</div>
    ${row("Ground Beef 1lb", "6.99")}
    ${row("Cheddar Cheese 8oz", "4.29")}
    ${row("Baby Spinach 5oz", "3.49")}
    ${row("Avocados (3 pack)", "4.99")}
    ${row("Olive Oil 500ml", "7.99")}
    ${row("Pasta Sauce", "3.49")}
    ${row("Brown Rice 2lb", "3.29")}
    ${row("Greek Yogurt (4pk)", "5.99")}
    ${row("Orange Juice 52oz", "4.99")}
    <div class="line"></div>
    ${row("Subtotal", "69.82")}
    ${row("Tax", "2.45")}
    <div class="dline"></div>
    ${row("TOTAL", "$72.27", "total-row")}
    <div class="line"></div>
    ${row("VISA ****7291", "$72.27")}
    <div class="center small" style="margin-top:6px">ITEMS: 14 &bull; YOU SAVED: $3.20</div>
  `, "receipt-thermal"),

  // 4. Coffee shop — short receipt
  "coffee-shop": receiptHtml(`
    <div class="header">BEAN &amp; BREW</div>
    <div class="subheader">78 Main Street</div>
    <div class="line"></div>
    <div class="center small">03/28/2026 7:52 AM</div>
    <div class="line"></div>
    ${row("Latte Grande", "5.75")}
    ${row("Cappuccino", "5.25")}
    ${row("Drip Coffee SM", "2.95")}
    ${row("Blueberry Muffin", "3.50")}
    ${row("Croissant", "3.75")}
    <div class="line"></div>
    ${row("Subtotal", "21.20")}
    ${row("Tax", "1.75")}
    <div class="dline"></div>
    ${row("Total", "$22.95", "total-row")}
    <div class="line"></div>
    <div class="center small">Apple Pay<br>Thank you!</div>
  `, "receipt-thermal"),

  // 5. Bar tab with drinks
  "bar-tab": receiptHtml(`
    <div class="header">THE RUSTY NAIL</div>
    <div class="subheader">Live Music &bull; Craft Cocktails<br>6th Street, Austin TX</div>
    <div class="line"></div>
    <div class="center small">04/02/2026 10:45 PM &bull; Tab #218</div>
    <div class="line"></div>
    ${row("IPA Draft", "8.00")}
    ${row("IPA Draft", "8.00")}
    ${row("IPA Draft", "8.00")}
    ${row("Old Fashioned", "14.00")}
    ${row("Margarita", "13.00")}
    ${row("Margarita", "13.00")}
    ${row("Moscow Mule", "12.00")}
    ${row("Whiskey Sour", "12.00")}
    ${row("Loaded Nachos", "16.00")}
    ${row("Wings (12pc)", "18.00")}
    <div class="line"></div>
    ${row("Subtotal", "122.00")}
    ${row("Auto Gratuity 20%", "24.40")}
    ${row("Tax", "10.07")}
    <div class="dline"></div>
    ${row("TOTAL", "$156.47", "total-row")}
    <div class="line"></div>
    ${row("Amex ****9012", "$156.47")}
    <div class="center small" style="margin-top:8px">Thanks for a great night!</div>
  `),

  // 6. Pizza delivery
  "pizza": receiptHtml(`
    <div class="header">TONY'S PIZZA</div>
    <div class="subheader">Free Delivery Over $25<br>555-PIZZA</div>
    <div class="line"></div>
    <div class="center small">Order #6291 &bull; 03/30/2026<br>Delivery</div>
    <div class="line"></div>
    ${row('Large Pepperoni Pizza', "18.99")}
    ${row('Medium Margherita', "14.99")}
    ${row('Garlic Knots (8pc)', "6.99")}
    ${row('Caesar Salad', "8.99")}
    ${row('2-Liter Coke', "3.49")}
    ${row('Buffalo Wings (10pc)', "12.99")}
    <div class="line"></div>
    ${row("Subtotal", "66.44")}
    ${row("Delivery Fee", "3.99")}
    ${row("Tax", "5.48")}
    <div class="dline"></div>
    ${row("Total", "$75.91", "total-row")}
    ${row("Tip", "$10.00")}
    <div class="dline"></div>
    ${row("Amount Charged", "$85.91", "total-row")}
    <div class="line"></div>
    ${row("Visa ****5523", "$85.91")}
  `, "receipt-thermal"),

  // 7. Asian restaurant with longer item names
  "asian-restaurant": receiptHtml(`
    <div class="header">JADE GARDEN</div>
    <div class="subheader">Chinese &amp; Thai Cuisine<br>2200 Lamar Blvd, Austin TX<br>(512) 555-8888</div>
    <div class="line"></div>
    <div class="center small">Dine In &bull; Table 5<br>04/03/2026 6:30 PM</div>
    <div class="line"></div>
    ${row("Hot & Sour Soup", "6.95")}
    ${row("Spring Rolls (4)", "8.50")}
    ${row("Kung Pao Chicken", "15.95")}
    ${row("Pad Thai Shrimp", "16.95")}
    ${row("Beef w/ Broccoli", "14.95")}
    ${row("Fried Rice", "10.95")}
    ${row("General Tso Chicken", "15.95")}
    ${row("Mango Sticky Rice", "8.50")}
    ${row("Thai Iced Tea", "4.50")}
    ${row("Thai Iced Tea", "4.50")}
    ${row("Jasmine Tea (pot)", "3.50")}
    <div class="line"></div>
    ${row("Subtotal", "111.20")}
    ${row("Tax (8.25%)", "9.17")}
    <div class="dline"></div>
    ${row("Total", "$120.37", "total-row")}
    <div class="line"></div>
    <div class="center small">Suggested Tip:<br>18% = $21.67 &bull; 20% = $24.07 &bull; 25% = $30.09</div>
    <div class="center small" style="margin-top:4px">Thank you!</div>
  `),
};

// ── Generate images ─────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 400, height: 800 },
    deviceScaleFactor: 2, // High DPI for better AI extraction
  });

  for (const [name, html] of Object.entries(receipts)) {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    // Resize viewport to fit receipt content
    const height = await page.evaluate(() => document.querySelector(".receipt")?.scrollHeight ?? 800);
    await page.setViewportSize({ width: 400, height: height + 40 });

    const screenshot = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    const outPath = resolve(OUT_DIR, `${name}.png`);
    writeFileSync(outPath, screenshot);
    console.log(`Generated: ${outPath} (${(screenshot.length / 1024).toFixed(1)} KB)`);
    await page.close();
  }

  // ── Generate distorted versions of existing receipts ──────────────

  const distortions = {
    // Slightly rotated (common when photographing on a table)
    "rotated-5deg": (html) => html.replace(
      '<div class="receipt',
      '<div style="transform: rotate(3deg); transform-origin: center;" class="receipt'
    ),
    // Rotated more aggressively
    "rotated-10deg": (html) => html.replace(
      '<div class="receipt',
      '<div style="transform: rotate(-7deg); transform-origin: center;" class="receipt'
    ),
    // Slight perspective skew (phone held at angle)
    "skewed": (html) => html.replace(
      '<div class="receipt',
      '<div style="transform: perspective(800px) rotateY(8deg) rotateX(3deg); transform-origin: center;" class="receipt'
    ),
    // Low contrast (faded thermal receipt)
    "faded": (html) => html.replace(
      'color: #111',
      'color: #999'
    ).replace(
      'background: #fefefe',
      'background: #f0ece0'
    ).replace(
      'background: #f9f5ee',
      'background: #f0ece0'
    ),
    // Noisy background (dirty receipt / textured surface)
    "noisy": (html) => html.replace(
      '</style>',
      `.receipt::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect x='0' y='0' width='1' height='1' fill='%23ddd' opacity='0.3'/%3E%3Crect x='2' y='1' width='1' height='1' fill='%23ccc' opacity='0.2'/%3E%3Crect x='1' y='3' width='1' height='1' fill='%23bbb' opacity='0.25'/%3E%3C/svg%3E");
        pointer-events: none;
        z-index: 1;
      }
      .receipt { position: relative; }
      </style>`
    ),
  };

  // Apply each distortion to the coffee-shop receipt (short, easy to verify)
  const baseReceipt = receipts["coffee-shop"];
  for (const [distName, distFn] of Object.entries(distortions)) {
    const distorted = distFn(baseReceipt);
    const page = await context.newPage();
    await page.setContent(distorted, { waitUntil: "networkidle" });

    const height = await page.evaluate(() => {
      const el = document.querySelector(".receipt");
      if (!el) return 800;
      const rect = el.getBoundingClientRect();
      return Math.ceil(rect.height + rect.top + 40);
    });
    await page.setViewportSize({ width: 500, height: Math.max(height + 80, 400) });

    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    const outPath = resolve(OUT_DIR, `distorted-${distName}.png`);
    writeFileSync(outPath, screenshot);
    console.log(`Generated: ${outPath} (${(screenshot.length / 1024).toFixed(1)} KB)`);
    await page.close();
  }

  await browser.close();
  console.log(`\nDone! Generated ${Object.keys(receipts).length + Object.keys(distortions).length} receipt images.`);
}

main().catch(console.error);
