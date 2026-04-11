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
let pollerInitTimeout: ReturnType<typeof setTimeout> | null = null;

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
