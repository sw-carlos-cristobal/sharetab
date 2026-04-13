import nodemailer from "nodemailer";
import { db } from "@/server/db";
import { isProviderConfigured } from "@/server/ai/registry";
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
let pollerInitTimeout: ReturnType<typeof setTimeout> | null = null;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Health check ─────────────────────────────────────────

export async function checkMeridianHealth(): Promise<MeridianHealthResult> {
  const port = process.env.MERIDIAN_PORT ?? "3457";
  const baseUrl = `http://127.0.0.1:${port}`;

  // Step 1: Check if proxy is running at all
  let healthData: { status?: string; auth?: { email?: string }; error?: string };
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    healthData = await res.json();
  } catch {
    return { status: "not_running" };
  }

  // If /health already reports unhealthy, trust it
  if (healthData.status !== "healthy" && healthData.status !== "degraded") {
    return {
      status: "unhealthy",
      email: healthData.auth?.email,
      error: healthData.error,
    };
  }

  // Step 2: Verify auth actually works with a minimal API call
  // The /health endpoint can report "healthy" even with expired tokens,
  // so we make a real API call to confirm.
  try {
    const probeRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "x",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (probeRes.ok) {
      // Auth works — discard the response body
      try { await probeRes.text(); } catch { /* ignore */ }
      return {
        status: "healthy",
        email: healthData.auth?.email,
      };
    }

    const probeBody = await probeRes.json().catch(() => null);
    const errorType = probeBody?.error?.type;

    if (errorType === "authentication_error") {
      return {
        status: "unhealthy",
        email: healthData.auth?.email,
        error: probeBody?.error?.message ?? "Authentication expired",
      };
    }

    // Other API errors (rate limit, overloaded, etc.) — proxy and auth are fine
    return {
      status: healthData.status === "degraded" ? "degraded" : "healthy",
      email: healthData.auth?.email,
    };
  } catch {
    // Probe timed out or failed — proxy is up but something is wrong
    return {
      status: "degraded",
      email: healthData.auth?.email,
      error: "Auth verification probe timed out",
    };
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

  // If proxy isn't running yet (still starting), skip alerting
  if (!hasSeenHealthy && result.status === "not_running") {
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
  if (!isProviderConfigured("meridian")) return;
  if (pollerInterval) return;

  logger.info("meridian.poller.started");
  // Run first tick after a short delay to let Meridian start
  pollerInitTimeout = setTimeout(() => {
    pollerInitTimeout = null;
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
  if (pollerInitTimeout) {
    clearTimeout(pollerInitTimeout);
    pollerInitTimeout = null;
  }
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info("meridian.poller.stopped");
  }
}

/** Run a single poll tick — exported for testing only. */
export async function _pollTick(): Promise<void> {
  return pollTick();
}

/** Reset internal state — for testing only. */
export function _resetPollerState(): void {
  lastStatus = "unknown" as MeridianStatus;
  hasSeenHealthy = false;
  lastEmailSentAt = null;
}
