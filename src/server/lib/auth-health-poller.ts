import nodemailer from "nodemailer";
import { db } from "@/server/db";
import { isProviderConfigured } from "@/server/ai/registry";
import { checkOpenAICodexHealth } from "./openai-codex-login";
import { getStoredMeridianTokenExpiry } from "./meridian-login";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────

export type MeridianStatus = "healthy" | "unhealthy" | "degraded" | "not_running";
export type NotifyInterval = "once" | "1h" | "6h" | "24h";
type AuthProvider = "meridian" | "openai-codex";

const AUTH_PROVIDERS: AuthProvider[] = ["meridian", "openai-codex"];

export interface MeridianHealthResult {
  status: MeridianStatus;
  email?: string;
  error?: string;
}

interface MeridianHealthCheckOptions {
  force?: boolean;
}

// ─── Interval mapping ─────────────────────────────────────

const INTERVAL_MS: Record<NotifyInterval, number> = {
  once: Infinity,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

// ─── Poller state ─────────────────────────────────────────

interface PollerState {
  lastStatus: string;
  hasSeenHealthy: boolean;
  lastEmailSentAt: number | null;
}

const providerState: Record<AuthProvider, PollerState> = {
  meridian: { lastStatus: "unknown", hasSeenHealthy: false, lastEmailSentAt: null },
  "openai-codex": { lastStatus: "unknown", hasSeenHealthy: false, lastEmailSentAt: null },
};
let pollerInterval: ReturnType<typeof setInterval> | null = null;
let pollerInitTimeout: ReturnType<typeof setTimeout> | null = null;
let meridianHealthCache:
  | { result: MeridianHealthResult; expiresAt: number }
  | null = null;
let meridianHealthInFlight: Promise<MeridianHealthResult> | null = null;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MERIDIAN_HEALTH_CACHE_TTL_MS = {
  healthyDefault: 15 * 60 * 1000,
  healthyNearExpiry: 5 * 60 * 1000,
  healthySoonExpiring: 15 * 60 * 1000,
  healthyMidLived: 60 * 60 * 1000,
  healthyLongLived: 4 * 60 * 60 * 1000,
  degraded: 60 * 1000,
  unhealthy: 30 * 1000,
  not_running: 15 * 1000,
} as const;

// ─── Health check ─────────────────────────────────────────

function getMeridianHealthCacheTtl(result: MeridianHealthResult): number {
  if (result.status !== "healthy") {
    return MERIDIAN_HEALTH_CACHE_TTL_MS[result.status];
  }

  const expiresAt = getStoredMeridianTokenExpiry();
  if (!expiresAt) {
    return MERIDIAN_HEALTH_CACHE_TTL_MS.healthyDefault;
  }

  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 15 * 60 * 1000) {
    return MERIDIAN_HEALTH_CACHE_TTL_MS.healthyNearExpiry;
  }
  if (remainingMs <= 2 * 60 * 60 * 1000) {
    return MERIDIAN_HEALTH_CACHE_TTL_MS.healthySoonExpiring;
  }
  if (remainingMs <= 8 * 60 * 60 * 1000) {
    return MERIDIAN_HEALTH_CACHE_TTL_MS.healthyMidLived;
  }
  return MERIDIAN_HEALTH_CACHE_TTL_MS.healthyLongLived;
}

async function runMeridianHealthCheck(): Promise<MeridianHealthResult> {
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

export async function checkMeridianHealth(
  options: MeridianHealthCheckOptions = {}
): Promise<MeridianHealthResult> {
  if (!options.force) {
    if (meridianHealthCache && meridianHealthCache.expiresAt > Date.now()) {
      return meridianHealthCache.result;
    }
    if (meridianHealthInFlight) {
      return meridianHealthInFlight;
    }
  } else if (meridianHealthInFlight) {
    return meridianHealthInFlight;
  }

  meridianHealthInFlight = runMeridianHealthCheck()
    .then((result) => {
      meridianHealthCache = {
        result,
        expiresAt: Date.now() + getMeridianHealthCacheTtl(result),
      };
      return result;
    })
    .finally(() => {
      meridianHealthInFlight = null;
    });

  return meridianHealthInFlight;
}

export function invalidateMeridianHealthCache(): void {
  meridianHealthCache = null;
}

// ─── Email sending ────────────────────────────────────────

export async function sendAuthExpiryEmail(
  error: string,
  loginUrl?: string,
  provider: AuthProvider = "meridian"
): Promise<boolean> {
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
  const providerLabel =
    provider === "openai-codex" ? "ChatGPT OAuth (OpenAI Codex)" : "Claude AI";

  const loginSection = loginUrl
    ? `<p><strong>Login URL:</strong><br/><a href="${loginUrl}">${loginUrl}</a></p>`
    : "";

  await transport.sendMail({
    from,
    to: adminEmail,
    subject: `[ShareTab] ${providerLabel} authentication expired`,
    text: [
      `ShareTab detected that ${providerLabel} authentication has expired.`,
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
        <h2 style="color: #ef4444;">${providerLabel} Authentication Expired</h2>
        <p>ShareTab detected that ${providerLabel} authentication has expired.</p>
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

  logger.info("auth.poller.emailSent", { provider, to: adminEmail });
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

async function handleMeridianTick(): Promise<void> {
  const state = providerState.meridian;
  const result = await checkMeridianHealth();

  if (result.status === "healthy") {
    if (state.lastStatus !== "healthy" && state.lastStatus !== "unknown") {
      logger.info("auth.poller.recovered", { provider: "meridian", email: result.email });
    }
    state.hasSeenHealthy = true;
    state.lastEmailSentAt = null;
    state.lastStatus = "healthy";
    return;
  }

  if (!state.hasSeenHealthy && result.status === "not_running") {
    state.lastStatus = result.status;
    return;
  }

  if (result.status === "unhealthy") {
    logger.warn("auth.poller.unhealthy", { provider: "meridian", error: result.error });
    const interval = await getNotifyInterval();
    if (await shouldSendEmail(state.lastEmailSentAt, interval)) {
      const sent = await sendAuthExpiryEmail(
        result.error ?? "Authentication expired",
        undefined,
        "meridian"
      );
      if (sent) state.lastEmailSentAt = Date.now();
    }
  }

  state.lastStatus = result.status;
}

async function handleOpenAICodexTick(): Promise<void> {
  const state = providerState["openai-codex"];
  const result = await checkOpenAICodexHealth();

  if (result.status === "healthy") {
    if (state.lastStatus !== "healthy" && state.lastStatus !== "unknown") {
      logger.info("auth.poller.recovered", {
        provider: "openai-codex",
        email: result.email,
      });
    }
    state.hasSeenHealthy = true;
    state.lastEmailSentAt = null;
    state.lastStatus = "healthy";
    return;
  }

  const shouldNotify =
    result.status === "auth_expired" ||
    (result.status === "not_authenticated" && state.hasSeenHealthy);

  if (shouldNotify) {
    logger.warn("auth.poller.unhealthy", {
      provider: "openai-codex",
      error: result.error,
      status: result.status,
    });
    const interval = await getNotifyInterval();
    if (await shouldSendEmail(state.lastEmailSentAt, interval)) {
      const sent = await sendAuthExpiryEmail(
        result.error ?? "Authentication expired",
        undefined,
        "openai-codex"
      );
      if (sent) state.lastEmailSentAt = Date.now();
    }
  }

  state.lastStatus = result.status;
}

async function pollTick(): Promise<void> {
  if (isProviderConfigured("meridian")) {
    await handleMeridianTick();
  }

  if (isProviderConfigured("openai-codex")) {
    await handleOpenAICodexTick();
  }
}

// ─── Lifecycle ────────────────────────────────────────────

export function startPoller(): void {
  const shouldRun = AUTH_PROVIDERS.some((provider) => isProviderConfigured(provider));
  if (!shouldRun) return;
  if (pollerInterval) return;

  logger.info("auth.poller.started");
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
    logger.info("auth.poller.stopped");
  }
}

/** Run a single poll tick — exported for testing only. */
export async function _pollTick(): Promise<void> {
  return pollTick();
}

/** Reset internal state — for testing only. */
export function _resetPollerState(): void {
  providerState.meridian.lastStatus = "unknown";
  providerState.meridian.hasSeenHealthy = false;
  providerState.meridian.lastEmailSentAt = null;

  providerState["openai-codex"].lastStatus = "unknown";
  providerState["openai-codex"].hasSeenHealthy = false;
  providerState["openai-codex"].lastEmailSentAt = null;

  meridianHealthCache = null;
  meridianHealthInFlight = null;
}
