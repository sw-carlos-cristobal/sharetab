import { randomBytes, createHash } from "crypto";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const AUTHORIZE_ENDPOINT = "https://claude.com/cai/oauth/authorize";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── State ────────────────────────────────────────────────

interface PendingLogin {
  codeVerifier: string;
  state: string;
  timeout: ReturnType<typeof setTimeout>;
}

let pendingLogin: PendingLogin | null = null;

// ─── PKCE helpers ────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── Credential path ────────────────────────────────────

function getCredentialPath(): string {
  const claudeHome =
    process.env.CLAUDE_DIR ??
    join(process.env.HOME ?? "/home/nextjs", ".claude");
  return join(claudeHome, ".credentials.json");
}

// ─── Login flow ───────────────────────────────────────────

export function isLoginInProgress(): boolean {
  return pendingLogin !== null;
}

/**
 * Start a new OAuth PKCE login flow. Returns the authorization URL
 * that the admin should open in their browser.
 */
export function startLogin(): Promise<string> {
  if (pendingLogin) {
    throw new Error("A login is already in progress");
  }

  // Clear stale credentials so the proxy picks up fresh ones after login
  const credPath = getCredentialPath();
  try {
    unlinkSync(credPath);
    logger.info("meridian.login.clearedStaleCredentials", { path: credPath });
  } catch {
    // File doesn't exist — that's fine
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const url = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;

  const timeout = setTimeout(() => {
    logger.warn("meridian.login.timeout");
    cancelLogin();
  }, LOGIN_TIMEOUT_MS);

  pendingLogin = { codeVerifier, state, timeout };

  logger.info("meridian.login.started");
  return Promise.resolve(url);
}

/**
 * Exchange the authorization code for tokens and write credentials.
 */
export async function submitCode(
  code: string
): Promise<{ success: boolean; error?: string }> {
  if (!pendingLogin) {
    throw new Error("No login in progress");
  }

  const { codeVerifier, state } = pendingLogin;

  try {
    logger.info("meridian.login.exchangingCode");

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
        state,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("meridian.login.tokenExchangeFailed", {
        status: res.status,
        body,
      });
      cleanup();
      return {
        success: false,
        error: `Token exchange failed (${res.status}): ${body}`,
      };
    }

    const tokens = await res.json();
    const credPath = getCredentialPath();

    // Write credentials in the same format Claude CLI expects
    const credentials = {
      claudeAiOauth: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: SCOPES.split(" "),
        subscriptionType: tokens.subscription_type ?? "max",
        rateLimitTier:
          tokens.rate_limit_tier ?? "default_claude_max_5x",
      },
    };

    writeFileSync(credPath, JSON.stringify(credentials), { mode: 0o600 });
    logger.info("meridian.login.credentialsSaved", { path: credPath });

    cleanup();
    return { success: true };
  } catch (err) {
    logger.error("meridian.login.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup();
    return {
      success: false,
      error: err instanceof Error ? err.message : "Token exchange failed",
    };
  }
}

// ─── URL parsing (kept for test compatibility) ───────────

export function parseOAuthUrl(text: string): string | null {
  const match = text.match(
    /(https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com)\/[^\s]+)/
  );
  return match?.[1] ?? null;
}

// ─── Cleanup ──────────────────────────────────────────────

export function cancelLogin(): void {
  cleanup();
}

function cleanup(): void {
  if (pendingLogin?.timeout) {
    clearTimeout(pendingLogin.timeout);
  }
  pendingLogin = null;
}
