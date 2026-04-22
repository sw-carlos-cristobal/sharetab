import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

// ─── Constants ───────────────────────────────────────────

const CLIENT_ID =
  process.env.MERIDIAN_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const AUTHORIZE_ENDPOINT = "https://claude.com/cai/oauth/authorize";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = [
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

function readStoredOauthCredentials():
  | {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      scopes?: string[];
      subscriptionType?: string;
      rateLimitTier?: string;
    }
  | null {
  const credPath = getCredentialPath();

  let raw: string;
  try {
    raw = readFileSync(credPath, "utf8");
  } catch {
    return null;
  }

  try {
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        scopes?: string[];
        subscriptionType?: string;
        rateLimitTier?: string;
      };
    };
    return creds.claudeAiOauth ?? null;
  } catch {
    logger.warn("meridian.credentials.invalidJson");
    return null;
  }
}

export function getStoredMeridianTokenExpiry(): number | null {
  return readStoredOauthCredentials()?.expiresAt ?? null;
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
 * Extract the authorization code from either a raw code string or a full
 * callback URL (e.g. "https://platform.claude.com/oauth/code/callback?code=XXX&state=YYY").
 */
function extractCodeAndState(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? trimmed,
      state: url.searchParams.get("state"),
    };
  } catch {
    // Not a URL — treat the whole string as the code
  }
  return { code: trimmed, state: null };
}

/**
 * Exchange the authorization code for tokens and write credentials.
 * Accepts either a raw authorization code or the full callback URL.
 */
export async function submitCode(
  codeOrUrl: string
): Promise<{ success: boolean; error?: string }> {
  if (!pendingLogin) {
    throw new Error("No login in progress");
  }

  const { code, state } = extractCodeAndState(codeOrUrl);
  const { codeVerifier, state: expectedState } = pendingLogin;

  if (state && state !== expectedState) {
    cleanup();
    return { success: false, error: "OAuth state mismatch" };
  }

  try {
    logger.info("meridian.login.exchangingCode", {
      codeLength: code.length,
      codePreview: code.substring(0, 10) + "...",
      redirectUri: REDIRECT_URI,
      clientId: CLIENT_ID,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
        state: expectedState,
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

// ─── Token refresh ───────────────────────────────────────

/** Buffer before expiry — refresh 5 minutes early */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Read stored credentials and refresh the access token if expired.
 * Called on app startup so a container restart doesn't require re-login.
 * Returns true if credentials are valid (refreshed or still fresh).
 * Pass `force: true` to refresh even if the token appears unexpired.
 */
export async function refreshIfNeeded(options?: { force?: boolean }): Promise<boolean> {
  const credPath = getCredentialPath();
  const oauth = readStoredOauthCredentials();
  if (!oauth) {
    // No credentials file — nothing to refresh
    return false;
  }

  if (!oauth?.refreshToken) {
    logger.warn("meridian.refresh.noRefreshToken");
    return false;
  }

  // Still fresh — no refresh needed (unless forced)
  if (!options?.force && oauth.expiresAt && oauth.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    logger.info("meridian.refresh.tokenStillValid", {
      expiresIn: Math.round((oauth.expiresAt - Date.now()) / 1000) + "s",
    });
    return true;
  }

  // Token expired or about to expire — refresh it
  logger.info("meridian.refresh.refreshing");

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error("meridian.refresh.failed", {
        status: res.status,
        body,
      });
      return false;
    }

    const tokens = await res.json();
    const updated = {
      claudeAiOauth: {
        ...oauth,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? oauth.refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
    };

    writeFileSync(credPath, JSON.stringify(updated), { mode: 0o600 });
    logger.info("meridian.refresh.success", {
      expiresIn: tokens.expires_in + "s",
    });
    return true;
  } catch (err) {
    logger.error("meridian.refresh.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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

export function logout(): { success: boolean; error?: string } {
  cleanup();
  const credPath = getCredentialPath();
  try {
    unlinkSync(credPath);
    logger.info("meridian.logout.success", { path: credPath });
    return { success: true };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      logger.info("meridian.logout.noCredentials", { path: credPath });
      return { success: true };
    }
    logger.error("meridian.logout.error", {
      path: credPath,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

function cleanup(): void {
  if (pendingLogin?.timeout) {
    clearTimeout(pendingLogin.timeout);
  }
  pendingLogin = null;
}
