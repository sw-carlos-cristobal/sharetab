# Meridian Auth Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Meridian OAuth expiry, email the admin, and provide a browser-based re-login flow in the admin dashboard.

**Architecture:** Background health poller (setInterval in Next.js server) checks Meridian `/health` every 5 minutes. On auth expiry, emails admin and surfaces re-login UI in admin dashboard. Re-login spawns `claude login` as child process, captures the OAuth URL, and accepts pasted authorization code via tRPC.

**Tech Stack:** Next.js instrumentation hook, tRPC, nodemailer, child_process, Vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `prisma/schema.prisma` | Add new `AdminAction` enum values |
| `src/instrumentation.ts` | Next.js server startup hook — starts the poller |
| `src/server/lib/meridian-health-poller.ts` | Background poller: checks Meridian `/health`, tracks state, sends email alerts |
| `src/server/lib/meridian-health-poller.test.ts` | Unit tests for poller state machine |
| `src/server/lib/meridian-login.ts` | Manages `claude login` child process lifecycle |
| `src/server/lib/meridian-login.test.ts` | Unit tests for login manager |
| `src/server/trpc/routers/admin.ts` | New procedures: meridian auth status, login flow, notification preferences |
| `src/components/admin/meridian-auth-section.tsx` | Dashboard UI: auth status, re-login flow, notification preferences |
| `src/app/(app)/admin/page.tsx` | Import and render `MeridianAuthSection` |

---

### Task 1: Add AdminAction enum values to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma:318-332`

- [ ] **Step 1: Add new enum values**

In `prisma/schema.prisma`, add four values to the `AdminAction` enum:

```prisma
enum AdminAction {
  USER_DELETED
  USER_SUSPENDED
  USER_UNSUSPENDED
  GROUP_DELETED
  ORPHANS_CLEANED
  IMPERSONATION_STARTED
  INVITE_CREATED
  INVITE_REVOKED
  ANNOUNCEMENT_SET
  REGISTRATION_MODE_CHANGED
  EXPORT_CREATED
  TEST_EMAIL_SENT
  EXPIRED_SPLITS_CLEANED
  MERIDIAN_LOGIN_STARTED
  MERIDIAN_LOGIN_COMPLETED
  MERIDIAN_LOGIN_FAILED
  MERIDIAN_NOTIFY_PREFERENCE_CHANGED
}
```

- [ ] **Step 2: Regenerate Prisma client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 3: Push schema to dev database**

Run: `npx prisma db push`
Expected: "Your database is now in sync with your Prisma schema"

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add Meridian auth admin action enum values"
```

---

### Task 2: Build the Meridian health poller

**Files:**
- Create: `src/server/lib/meridian-health-poller.ts`
- Create: `src/server/lib/meridian-health-poller.test.ts`

- [ ] **Step 1: Write failing tests for the poller state machine**

Create `src/server/lib/meridian-health-poller.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock nodemailer before any imports
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));

// Mock db
const mockDb = {
  systemSetting: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
};
vi.mock("@/server/db", () => ({ db: mockDb }));
vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import nodemailer from "nodemailer";

// Helper to create a poller with controlled fetch
function createTestPoller() {
  // We'll test the exported functions directly
  return import("./meridian-health-poller");
}

describe("MeridianHealthPoller", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env = {
      ...originalEnv,
      AI_PROVIDER: "meridian",
      MERIDIAN_PORT: "3457",
      ADMIN_EMAIL: "admin@test.com",
      EMAIL_SERVER_HOST: "smtp.test.com",
      EMAIL_SERVER_PORT: "587",
      EMAIL_FROM: "noreply@test.com",
      NEXTAUTH_URL: "http://localhost:3000",
    };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("checkMeridianHealth returns healthy status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "healthy",
        auth: { loggedIn: true, email: "user@test.com" },
      }), { status: 200 })
    );

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("healthy");
    expect(result.email).toBe("user@test.com");
  });

  test("checkMeridianHealth returns unhealthy when not logged in", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: "unhealthy",
        error: "Not logged in. Run: claude login",
      }), { status: 503 })
    );

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("unhealthy");
    expect(result.error).toBe("Not logged in. Run: claude login");
  });

  test("checkMeridianHealth returns not_running on fetch error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { checkMeridianHealth } = await import("./meridian-health-poller");
    const result = await checkMeridianHealth();
    expect(result.status).toBe("not_running");
  });

  test("sendAuthExpiryEmail sends email with correct content", async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    await sendAuthExpiryEmail("Not logged in. Run: claude login");

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe("admin@test.com");
    expect(call.subject).toContain("Claude AI authentication expired");
  });

  test("sendAuthExpiryEmail skips when email is not configured", async () => {
    delete process.env.EMAIL_SERVER_HOST;
    const mockSendMail = vi.fn();
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    const { sendAuthExpiryEmail } = await import("./meridian-health-poller");
    await sendAuthExpiryEmail("error");

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test("shouldSendEmail returns true on first unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const result = await shouldSendEmail(null, "once");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false on second unhealthy with 'once' interval", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const now = Date.now();
    const result = await shouldSendEmail(now - 60_000, "once");
    expect(result).toBe(false);
  });

  test("shouldSendEmail returns true when interval has elapsed", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const result = await shouldSendEmail(twoHoursAgo, "1h");
    expect(result).toBe(true);
  });

  test("shouldSendEmail returns false when interval has not elapsed", async () => {
    const { shouldSendEmail } = await import("./meridian-health-poller");
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const result = await shouldSendEmail(thirtyMinutesAgo, "1h");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/lib/meridian-health-poller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the health poller**

Create `src/server/lib/meridian-health-poller.ts`:

```typescript
import nodemailer from "nodemailer";
import { db } from "@/server/db";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────

export type MeridianStatus = "healthy" | "unhealthy" | "degraded" | "not_running";
export type NotifyInterval = "once" | "1h" | "6h" | "24h";

export interface MeridianHealthResult {
  status: MeridianStatus;
  email?: string;
  error?: string;
}

// ─── Interval mapping ─────────────────────────────────────

const INTERVAL_MS: Record<NotifyInterval, number> = {
  once: Infinity,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

// ─── Poller state ─────────────────────────────────────────

let lastStatus: MeridianStatus = "unknown" as MeridianStatus;
let hasSeenHealthy = false;
let lastEmailSentAt: number | null = null;
let pollerInterval: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Health check ─────────────────────────────────────────

export async function checkMeridianHealth(): Promise<MeridianHealthResult> {
  const port = process.env.MERIDIAN_PORT ?? "3457";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return {
      status: data.status === "healthy" ? "healthy" : data.status === "degraded" ? "degraded" : "unhealthy",
      email: data.auth?.email,
      error: data.error,
    };
  } catch {
    return { status: "not_running" };
  }
}

// ─── Email sending ────────────────────────────────────────

export async function sendAuthExpiryEmail(error: string, loginUrl?: string): Promise<boolean> {
  const host = process.env.EMAIL_SERVER_HOST;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!host || !adminEmail) {
    logger.warn("meridian.poller.emailSkipped", {
      reason: !host ? "EMAIL_SERVER_HOST not configured" : "ADMIN_EMAIL not configured",
    });
    return false;
  }

  const transport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.EMAIL_SERVER_PORT ?? "587"),
    secure: parseInt(process.env.EMAIL_SERVER_PORT ?? "587") === 465,
    auth: {
      user: process.env.EMAIL_SERVER_USER,
      pass: process.env.EMAIL_SERVER_PASSWORD,
    },
  });

  const from = process.env.EMAIL_FROM ?? "ShareTab <noreply@sharetab.local>";
  const dashboardUrl = `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/admin`;

  const loginSection = loginUrl
    ? `<p><strong>Login URL:</strong><br/><a href="${loginUrl}">${loginUrl}</a></p>`
    : "";

  await transport.sendMail({
    from,
    to: adminEmail,
    subject: "[ShareTab] Claude AI authentication expired",
    text: [
      "ShareTab detected that the Meridian (Claude) authentication has expired.",
      "",
      `Error: ${error}`,
      "",
      loginUrl ? `Login URL: ${loginUrl}` : "",
      "",
      `Re-authenticate from the admin dashboard: ${dashboardUrl}`,
      "",
      `Timestamp: ${new Date().toISOString()}`,
    ].filter(Boolean).join("\n"),
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #ef4444;">Claude AI Authentication Expired</h2>
        <p>ShareTab detected that the Meridian (Claude) authentication has expired.</p>
        <p><strong>Error:</strong> ${error}</p>
        ${loginSection}
        <p>
          <a href="${dashboardUrl}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px;">
            Open Admin Dashboard
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          Timestamp: ${new Date().toISOString()}
        </p>
      </div>
    `,
  });

  logger.info("meridian.poller.emailSent", { to: adminEmail });
  return true;
}

// ─── Notification gating ──────────────────────────────────

export async function shouldSendEmail(
  lastSentAt: number | null,
  interval: NotifyInterval
): Promise<boolean> {
  if (lastSentAt === null) return true;
  if (interval === "once") return false;
  return Date.now() - lastSentAt >= INTERVAL_MS[interval];
}

async function getNotifyInterval(): Promise<NotifyInterval> {
  try {
    const setting = await db.systemSetting.findUnique({
      where: { key: "meridianNotifyInterval" },
    });
    const value = setting?.value;
    if (value === "1h" || value === "6h" || value === "24h" || value === "once") {
      return value;
    }
  } catch {
    // DB not ready yet — use default
  }
  return "once";
}

// ─── Poll tick ────────────────────────────────────────────

async function pollTick(): Promise<void> {
  const result = await checkMeridianHealth();

  // On transition to healthy
  if (result.status === "healthy") {
    if (lastStatus !== "healthy" && lastStatus !== ("unknown" as MeridianStatus)) {
      logger.info("meridian.poller.recovered", { email: result.email });
    }
    hasSeenHealthy = true;
    lastEmailSentAt = null; // Reset for next incident
    lastStatus = "healthy";
    return;
  }

  // Don't alert until we've seen at least one healthy state (prevents startup spam)
  if (!hasSeenHealthy) {
    lastStatus = result.status;
    return;
  }

  // Status is unhealthy, degraded, or not_running
  if (result.status === "unhealthy") {
    logger.warn("meridian.poller.unhealthy", { error: result.error });
    const interval = await getNotifyInterval();
    if (await shouldSendEmail(lastEmailSentAt, interval)) {
      const sent = await sendAuthExpiryEmail(result.error ?? "Authentication expired");
      if (sent) lastEmailSentAt = Date.now();
    }
  }

  lastStatus = result.status;
}

// ─── Lifecycle ────────────────────────────────────────────

export function startPoller(): void {
  if (process.env.AI_PROVIDER !== "meridian") return;
  if (pollerInterval) return;

  logger.info("meridian.poller.started");
  // Run first tick after a short delay to let Meridian start
  setTimeout(() => {
    pollTick().catch((err) =>
      logger.error("meridian.poller.tickError", { error: String(err) })
    );
  }, 30_000);

  pollerInterval = setInterval(() => {
    pollTick().catch((err) =>
      logger.error("meridian.poller.tickError", { error: String(err) })
    );
  }, POLL_INTERVAL_MS);
}

export function stopPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info("meridian.poller.stopped");
  }
}

/** Reset internal state — for testing only. */
export function _resetPollerState(): void {
  lastStatus = "unknown" as MeridianStatus;
  hasSeenHealthy = false;
  lastEmailSentAt = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/lib/meridian-health-poller.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/meridian-health-poller.ts src/server/lib/meridian-health-poller.test.ts
git commit -m "feat: add Meridian health poller with email alerts"
```

---

### Task 3: Build the Meridian login manager

**Files:**
- Create: `src/server/lib/meridian-login.ts`
- Create: `src/server/lib/meridian-login.test.ts`

- [ ] **Step 1: Write failing tests for the login manager**

Create `src/server/lib/meridian-login.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("MeridianLoginManager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("isLoginInProgress returns false initially", async () => {
    const { isLoginInProgress } = await import("./meridian-login");
    expect(isLoginInProgress()).toBe(false);
  });

  test("parseOAuthUrl extracts URL from stdout", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const stdout = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc\n';
    const url = parseOAuthUrl(stdout);
    expect(url).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc");
  });

  test("parseOAuthUrl extracts platform.claude.com URL", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const stdout = "visit: https://platform.claude.com/oauth/authorize?foo=bar\nmore text";
    const url = parseOAuthUrl(stdout);
    expect(url).toBe("https://platform.claude.com/oauth/authorize?foo=bar");
  });

  test("parseOAuthUrl returns null when no URL found", async () => {
    const { parseOAuthUrl } = await import("./meridian-login");
    const url = parseOAuthUrl("no url here");
    expect(url).toBeNull();
  });

  test("cancelLogin clears state", async () => {
    const { cancelLogin, isLoginInProgress } = await import("./meridian-login");
    cancelLogin();
    expect(isLoginInProgress()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/lib/meridian-login.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the login manager**

Create `src/server/lib/meridian-login.ts`:

```typescript
import { spawn, type ChildProcess } from "child_process";
import { logger } from "./logger";

// ─── State ────────────────────────────────────────────────

let activeProcess: ChildProcess | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingResolve: ((value: { success: boolean; error?: string }) => void) | null = null;

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── URL parsing ──────────────────────────────────────────

export function parseOAuthUrl(text: string): string | null {
  const match = text.match(/(https:\/\/(?:claude\.ai|platform\.claude\.com)\/[^\s]+)/);
  return match?.[1] ?? null;
}

// ─── Login flow ───────────────────────────────────────────

export function isLoginInProgress(): boolean {
  return activeProcess !== null;
}

/**
 * Start the `claude login` process. Returns the OAuth URL once captured from stdout.
 * Throws if a login is already in progress.
 */
export function startLogin(): Promise<string> {
  if (activeProcess) {
    throw new Error("A login is already in progress");
  }

  return new Promise<string>((resolve, reject) => {
    let stdoutBuffer = "";
    let urlResolved = false;

    const proc = spawn("claude", ["login"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME ?? "/home/nextjs" },
    });

    activeProcess = proc;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      logger.debug("meridian.login.stdout", { text: text.trim() });

      if (!urlResolved) {
        const url = parseOAuthUrl(stdoutBuffer);
        if (url) {
          urlResolved = true;
          resolve(url);
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      logger.debug("meridian.login.stderr", { text: chunk.toString().trim() });
    });

    proc.on("error", (err) => {
      logger.error("meridian.login.processError", { error: err.message });
      cleanup();
      if (!urlResolved) reject(new Error(`Failed to start claude login: ${err.message}`));
    });

    proc.on("close", (code) => {
      logger.info("meridian.login.processExited", { code });
      const resolve = pendingResolve;
      cleanup();
      if (resolve) {
        resolve(code === 0 ? { success: true } : { success: false, error: `Process exited with code ${code}` });
      }
      if (!urlResolved) reject(new Error("claude login exited before producing a URL"));
    });

    // Timeout
    activeTimeout = setTimeout(() => {
      logger.warn("meridian.login.timeout");
      cancelLogin();
      if (!urlResolved) reject(new Error("Login timed out"));
    }, LOGIN_TIMEOUT_MS);
  });
}

/**
 * Submit the authorization code to the running `claude login` process.
 * Returns when the process finishes.
 */
export function submitCode(code: string): Promise<{ success: boolean; error?: string }> {
  if (!activeProcess?.stdin) {
    throw new Error("No login in progress");
  }

  return new Promise((resolve) => {
    pendingResolve = resolve;
    activeProcess!.stdin!.write(code + "\n");
    logger.info("meridian.login.codeSubmitted");
  });
}

// ─── Cleanup ──────────────────────────────────────────────

export function cancelLogin(): void {
  if (activeProcess) {
    try {
      activeProcess.kill();
    } catch {
      // already dead
    }
  }
  cleanup();
}

function cleanup(): void {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  activeProcess = null;
  pendingResolve = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/lib/meridian-login.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/lib/meridian-login.ts src/server/lib/meridian-login.test.ts
git commit -m "feat: add Meridian login manager for admin re-auth flow"
```

---

### Task 4: Add tRPC procedures for Meridian auth

**Files:**
- Modify: `src/server/trpc/routers/admin.ts`

- [ ] **Step 1: Add imports at the top of admin.ts**

Add these imports to the top of `src/server/trpc/routers/admin.ts`:

```typescript
import {
  checkMeridianHealth,
  sendAuthExpiryEmail,
} from "@/server/lib/meridian-health-poller";
import {
  startLogin,
  submitCode,
  cancelLogin,
  isLoginInProgress,
} from "@/server/lib/meridian-login";
import { clearProviderCache } from "@/server/ai/registry";
```

- [ ] **Step 2: Add getMeridianAuthStatus query**

Add this procedure inside the `adminRouter` in `admin.ts`, after the `getLogs` procedure (before the closing `});`):

```typescript
  // ─── Meridian Auth ──────────────────────────────────────────

  getMeridianAuthStatus: adminProcedure.query(async () => {
    if (process.env.AI_PROVIDER !== "meridian") {
      return { status: "not_applicable" as const };
    }
    const health = await checkMeridianHealth();
    return {
      ...health,
      loginInProgress: isLoginInProgress(),
    };
  }),
```

- [ ] **Step 3: Add startMeridianLogin mutation**

Add after `getMeridianAuthStatus`:

```typescript
  startMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    if (process.env.AI_PROVIDER !== "meridian") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Meridian is not the active AI provider",
      });
    }

    try {
      const url = await startLogin();

      // Send email with login URL
      await sendAuthExpiryEmail(
        "Re-authentication initiated from admin dashboard",
        url
      );

      await logAdminAction(ctx.db, ctx.user.id, "MERIDIAN_LOGIN_STARTED", null, {
        url,
      });

      return { url };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to start login",
      });
    }
  }),
```

- [ ] **Step 4: Add completeMeridianLogin mutation**

Add after `startMeridianLogin`:

```typescript
  completeMeridianLogin: adminProcedure
    .input(z.object({ code: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await submitCode(input.code);

        if (result.success) {
          clearProviderCache();
        }

        await logAdminAction(
          ctx.db,
          ctx.user.id,
          result.success ? "MERIDIAN_LOGIN_COMPLETED" : "MERIDIAN_LOGIN_FAILED",
          null,
          { success: result.success, error: result.error }
        );

        return result;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to submit code",
        });
      }
    }),

  cancelMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    cancelLogin();
    await logAdminAction(ctx.db, ctx.user.id, "MERIDIAN_LOGIN_FAILED", null, {
      reason: "cancelled",
    });
    return { cancelled: true };
  }),
```

- [ ] **Step 5: Add notification preference procedures**

Add after `cancelMeridianLogin`:

```typescript
  getMeridianNotifyPreference: adminProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: "meridianNotifyInterval" },
    });
    return {
      interval: (setting?.value ?? "once") as "once" | "1h" | "6h" | "24h",
    };
  }),

  setMeridianNotifyPreference: adminProcedure
    .input(
      z.object({
        interval: z.enum(["once", "1h", "6h", "24h"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: "meridianNotifyInterval" },
        update: { value: input.interval },
        create: { key: "meridianNotifyInterval", value: input.interval },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "MERIDIAN_NOTIFY_PREFERENCE_CHANGED",
        null,
        { interval: input.interval }
      );

      return { interval: input.interval };
    }),
```

- [ ] **Step 6: Verify lint passes**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/server/trpc/routers/admin.ts
git commit -m "feat: add tRPC procedures for Meridian auth status, login, and notification preferences"
```

---

### Task 5: Create the instrumentation hook

**Files:**
- Create: `src/instrumentation.ts`

- [ ] **Step 1: Create the instrumentation file**

Create `src/instrumentation.ts`:

```typescript
export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPoller } = await import("@/server/lib/meridian-health-poller");
    startPoller();
  }
}
```

- [ ] **Step 2: Verify the dev server starts without errors**

Run: `npm run dev` (start and verify no startup crash, then stop)
Expected: Server starts, logs `meridian.poller.started` if `AI_PROVIDER=meridian`

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat: add Next.js instrumentation hook to start Meridian health poller"
```

---

### Task 6: Build the admin dashboard Meridian auth section

**Files:**
- Create: `src/components/admin/meridian-auth-section.tsx`
- Modify: `src/app/(app)/admin/page.tsx`

- [ ] **Step 1: Create the MeridianAuthSection component**

Create `src/components/admin/meridian-auth-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  KeyRound,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Bell,
  Copy,
} from "lucide-react";

export function MeridianAuthSection() {
  const utils = trpc.useUtils();

  const authStatus = trpc.admin.getMeridianAuthStatus.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const notifyPref = trpc.admin.getMeridianNotifyPreference.useQuery();

  const startLogin = trpc.admin.startMeridianLogin.useMutation({
    onSuccess: (data) => {
      setLoginUrl(data.url);
      setLoginState("waiting_for_code");
    },
    onError: (err) => {
      setLoginState("error");
      setLoginError(err.message);
    },
  });

  const completeLogin = trpc.admin.completeMeridianLogin.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        setLoginState("success");
        utils.admin.getMeridianAuthStatus.invalidate();
        utils.admin.getSystemHealth.invalidate();
      } else {
        setLoginState("error");
        setLoginError(data.error ?? "Login failed");
      }
    },
    onError: (err) => {
      setLoginState("error");
      setLoginError(err.message);
    },
  });

  const cancelMutation = trpc.admin.cancelMeridianLogin.useMutation({
    onSuccess: () => {
      resetLoginState();
    },
  });

  const setNotifyPref = trpc.admin.setMeridianNotifyPreference.useMutation({
    onSuccess: () => {
      utils.admin.getMeridianNotifyPreference.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [loginState, setLoginState] = useState<
    "idle" | "starting" | "waiting_for_code" | "submitting" | "success" | "error"
  >("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function resetLoginState() {
    setLoginState("idle");
    setLoginUrl(null);
    setLoginCode("");
    setLoginError(null);
  }

  // Don't render if not using meridian
  const status = authStatus.data;
  if (!status || "status" in status && status.status === "not_applicable") {
    return null;
  }

  const isHealthy = status.status === "healthy";
  const statusColor = isHealthy
    ? "bg-green-500"
    : status.status === "not_running"
      ? "bg-gray-400"
      : "bg-red-500";

  const statusLabel = isHealthy
    ? "Authenticated"
    : status.status === "not_running"
      ? "Proxy not running"
      : "Authentication expired";

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Meridian Authentication</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        {/* Auth Status Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bot className="h-4 w-4" />
              Claude OAuth Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
              <span className="text-sm font-medium">{statusLabel}</span>
              {isHealthy && status.email && (
                <Badge variant="outline" className="text-xs">
                  {status.email}
                </Badge>
              )}
            </div>

            {status.error && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {status.error}
              </p>
            )}

            {/* Login Flow */}
            {!isHealthy && loginState === "idle" && (
              <Button
                size="sm"
                onClick={() => {
                  setLoginState("starting");
                  startLogin.mutate();
                }}
                disabled={status.loginInProgress}
              >
                {status.loginInProgress ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Login in progress...
                  </>
                ) : (
                  "Re-authenticate"
                )}
              </Button>
            )}

            {loginState === "starting" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Starting login flow...
              </div>
            )}

            {loginState === "waiting_for_code" && loginUrl && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">
                  Step 1: Open this link and sign in
                </p>
                <div className="flex items-center gap-2">
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-primary underline break-all"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    Open authentication page
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(loginUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>

                <p className="text-sm font-medium">
                  Step 2: Paste the code you receive
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Paste authorization code..."
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!loginCode.trim() || completeLogin.isPending}
                    onClick={() => {
                      setLoginState("submitting");
                      completeLogin.mutate({ code: loginCode.trim() });
                    }}
                  >
                    {completeLogin.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Submit"
                    )}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    cancelMutation.mutate();
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

            {loginState === "submitting" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Completing login...
              </div>
            )}

            {loginState === "success" && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Login successful! Authentication restored.
                <Button variant="ghost" size="sm" onClick={resetLoginState}>
                  Dismiss
                </Button>
              </div>
            )}

            {loginState === "error" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <XCircle className="h-4 w-4" />
                  {loginError}
                </div>
                <Button variant="outline" size="sm" onClick={resetLoginState}>
                  Try again
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notification Preferences Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bell className="h-4 w-4" />
              Auth Expiry Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              How often to receive email alerts when Claude authentication
              expires.
            </p>
            <Select
              value={notifyPref.data?.interval ?? "once"}
              onValueChange={(value) => {
                setNotifyPref.mutate({
                  interval: value as "once" | "1h" | "6h" | "24h",
                });
              }}
              disabled={setNotifyPref.isPending}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">Once per incident</SelectItem>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="6h">Every 6 hours</SelectItem>
                <SelectItem value="24h">Every 24 hours</SelectItem>
              </SelectContent>
            </Select>
            {setNotifyPref.isPending && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving...
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Check that Select component exists in shadcn/ui**

Run: `ls src/components/ui/select.tsx`

If it does not exist, run:
```bash
npx shadcn@latest add select
```

- [ ] **Step 3: Add MeridianAuthSection to the admin page**

In `src/app/(app)/admin/page.tsx`, add the import near the other admin component imports:

```typescript
import { MeridianAuthSection } from "@/components/admin/meridian-auth-section";
```

Then add it in the JSX after `<SystemHealthSection />` and before the first `<Separator />`:

```tsx
        <SystemHealthSection />
        <MeridianAuthSection />
        <Separator />
```

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: Build completes without errors

- [ ] **Step 6: Commit**

```bash
git add src/components/admin/meridian-auth-section.tsx src/app/\(app\)/admin/page.tsx
git commit -m "feat: add Meridian auth section to admin dashboard with re-login UI and notification preferences"
```

---

### Task 7: Integration testing and manual verification

**Files:** None (testing only)

- [ ] **Step 1: Run all unit tests**

Run: `npm test`
Expected: All tests pass (existing + new)

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test (if dev server available)**

Start dev server with `npm run dev:full` and verify:
1. Admin dashboard loads without errors
2. If `AI_PROVIDER=meridian`: Meridian Authentication section appears with status
3. If `AI_PROVIDER` is something else: Meridian Authentication section does not appear
4. Notification preference dropdown renders and saves

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address integration issues from Meridian auth feature"
```
