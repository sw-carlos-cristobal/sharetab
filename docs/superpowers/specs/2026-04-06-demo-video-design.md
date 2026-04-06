# ShareTab Demo Video — Design Spec

## Overview

A Playwright-scripted browser recording that demonstrates ShareTab's core features for the README. The hero feature is **receipt scanning with item-to-person assignment**. The demo targets both desktop and mobile viewports, with mobile as the primary audience.

## Technical Approach

- **Script:** Single Playwright file at `e2e/demo-video.ts`
- **Recording:** Playwright's built-in `video: 'on'` context option produces `.webm`
- **Output:** `demo/sharetab-demo.webm`
- **Desktop viewport:** 1280x720
- **Mobile viewport:** 390x844
- **Viewport switch:** Mid-script via `page.setViewportSize()`
- **Pacing:** Deliberate `waitForTimeout()` pauses (1-4s) between actions
- **Data:** Existing seed data (Alice/Bob/Charlie, Apartment group with expenses)
- **AI provider:** Real provider (must be configured in `.env`) — no mocks
- **Test receipt:** Existing `e2e/test-receipt.png`
- **Server:** Runs against local dev server (`BASE_URL` env var or `http://localhost:3000`)
- **Estimated runtime:** 60-90 seconds
- **No audio**

## Script Flow

| # | Scene | Viewport | Actions | Pause After |
|---|-------|----------|---------|-------------|
| 1 | Login | 1280x720 | Fill alice@example.com / password123, click sign in | 1.5s |
| 2 | Dashboard | 1280x720 | Pan over balances, group cards | 2s |
| 3 | Group detail | 1280x720 | Click Apartment group, show members/debts/expenses | 2s |
| 4 | Add expense | 1280x720 | Click add, fill "Coffee run" $24.50, equal split, save | 2s |
| 5 | Switch to mobile | 390x844 | Viewport resize, brief pause on adapted layout | 1.5s |
| 6 | Receipt scan | 390x844 | Navigate to scan, upload test receipt, wait for AI extraction, assign items to people | 4s |
| 7 | Settlement | 390x844 | Click a debt, confirm settlement dialog | 2s |
| 8 | Dark mode | 390x844 | Open menu, toggle dark mode, pause on dark UI | 2s |
| 9 | Guest split | 390x844 | Navigate to /split, add items manually, assign to people | 3s |

## Output & Delivery

- **Format:** `.webm` (Playwright native) — works in GitHub READMEs
- **Optional:** Convert to `.mp4` with ffmpeg if available
- **Expected size:** 2-5MB for ~90s at 1280x720
- **README integration:** `<video>` tag or link to file in repo
- **Location:** `demo/sharetab-demo.webm`

## Dependencies

- Local dev server running (`npm run dev:full` or equivalent)
- Database seeded (`npm run db:seed`)
- AI provider configured in `.env` (for receipt scan step)
- Playwright installed (`npx playwright install chromium`)

## Out of Scope

- Audio/narration
- Text overlays or captions (can be added in post if desired)
- Admin dashboard demo
- OAuth login flow
