import { randomBytes, createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { logger } from "./logger";

const CLIENT_ID =
  process.env.OPENAI_CODEX_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const ORIGINATOR = "codex_cli_rs";
const CLIENT_VERSION = "0.99.0";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
].join(" ");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface PendingLogin {
  codeVerifier: string;
  state: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface OpenAICodexClaims {
  email?: string;
  exp?: number;
  "https://api.openai.com/profile"?: {
    email?: string;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
    chatgpt_user_id?: string;
    user_id?: string;
    chatgpt_account_id?: string;
  };
}

interface StoredAuth {
  auth_mode?: "Chatgpt";
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string | null;
  };
  last_refresh?: string;
}

interface ParsedStoredAuth {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  expiresAt: number | null;
}

type HealthStatus =
  | {
      status: "healthy";
      email: string | null;
      planType: string | null;
      accountId: string | null;
    }
  | {
      status: "not_authenticated" | "auth_expired";
      error?: string;
      email?: string | null;
      planType?: string | null;
      accountId?: string | null;
    };

let pendingLogin: PendingLogin | null = null;

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function getCredentialPath(): string {
  const codexHome = process.env.OPENAI_CODEX_DIR ?? "/app/chatgpt";
  return join(codexHome, "auth.json");
}

function decodeJwtClaims(token: string): OpenAICodexClaims {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("Invalid JWT");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as OpenAICodexClaims;
}

function parseStoredAuth(raw: string): ParsedStoredAuth | null {
  const parsed = JSON.parse(raw) as StoredAuth;
  const tokens = parsed.tokens;
  if (!tokens?.access_token || !tokens.refresh_token || !tokens.id_token) {
    return null;
  }

  const idClaims = decodeJwtClaims(tokens.id_token);
  const accessClaims = decodeJwtClaims(tokens.access_token);
  const authClaims = idClaims["https://api.openai.com/auth"];

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accountId:
      tokens.account_id ??
      authClaims?.chatgpt_account_id ??
      null,
    email:
      idClaims.email ??
      idClaims["https://api.openai.com/profile"]?.email ??
      null,
    planType: authClaims?.chatgpt_plan_type ?? null,
    expiresAt: accessClaims.exp ? accessClaims.exp * 1000 : null,
  };
}

function readStoredAuth(): ParsedStoredAuth | null {
  try {
    const raw = readFileSync(getCredentialPath(), "utf8");
    return parseStoredAuth(raw);
  } catch {
    return null;
  }
}

function writeStoredAuth(tokens: {
  access_token: string;
  refresh_token: string;
  id_token: string;
}) {
  const path = getCredentialPath();
  mkdirSync(dirname(path), { recursive: true });
  const idClaims = decodeJwtClaims(tokens.id_token);
  const accountId =
    idClaims["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;

  const auth: StoredAuth = {
    auth_mode: "Chatgpt",
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

function extractCodeAndState(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code") ?? trimmed,
      state: url.searchParams.get("state"),
    };
  } catch {
    return { code: trimmed, state: null };
  }
}

async function refreshAuth(force = false): Promise<ParsedStoredAuth | null> {
  const stored = readStoredAuth();
  if (!stored?.refreshToken) return null;

  if (!force && stored.expiresAt && stored.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return stored;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", originator: ORIGINATOR },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    logger.warn("openaiCodex.refresh.failed", { status: response.status });
    return null;
  }

  const refreshed = await response.json() as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };

  if (!refreshed.id_token || !refreshed.access_token) {
    logger.warn("openaiCodex.refresh.invalidResponse");
    return null;
  }

  writeStoredAuth({
    id_token: refreshed.id_token,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? stored.refreshToken,
  });

  return readStoredAuth();
}

async function probeModels(auth: ParsedStoredAuth): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    originator: ORIGINATOR,
  });
  if (auth.accountId) {
    headers.set("ChatGPT-Account-ID", auth.accountId);
  }

  return fetch(`${CODEX_BASE_URL}/models?client_version=${CLIENT_VERSION}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(20_000),
  });
}

export function isLoginInProgress(): boolean {
  return pendingLogin !== null;
}

export function startLogin(): Promise<string> {
  if (pendingLogin) {
    throw new Error("A login is already in progress");
  }

  try {
    unlinkSync(getCredentialPath());
  } catch {
    // ignore
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });

  const timeout = setTimeout(() => {
    logger.warn("openaiCodex.login.timeout");
    cancelLogin();
  }, LOGIN_TIMEOUT_MS);

  pendingLogin = { codeVerifier, state, timeout };
  return Promise.resolve(`${AUTHORIZE_ENDPOINT}?${params.toString()}`);
}

export async function submitCode(
  codeOrUrl: string
): Promise<{ success: boolean; error?: string }> {
  if (!pendingLogin) {
    throw new Error("No login in progress");
  }

  const { code, state } = extractCodeAndState(codeOrUrl);
  if (state && state !== pendingLogin.state) {
    cleanup();
    return { success: false, error: "OAuth state mismatch" };
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: pendingLogin.codeVerifier,
  });

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        originator: ORIGINATOR,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      cleanup();
      return {
        success: false,
        error: `Token exchange failed (${response.status}): ${text}`,
      };
    }

    const tokens = await response.json() as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
    };

    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
      cleanup();
      return {
        success: false,
        error: "Token exchange response did not include all required tokens",
      };
    }

    writeStoredAuth(tokens as {
      access_token: string;
      refresh_token: string;
      id_token: string;
    });
    cleanup();
    return { success: true };
  } catch (error) {
    cleanup();
    return {
      success: false,
      error: error instanceof Error ? error.message : "Token exchange failed",
    };
  }
}

export function cancelLogin(): void {
  cleanup();
}

export function logout(): { success: boolean; error?: string } {
  cleanup();
  const path = getCredentialPath();
  try {
    unlinkSync(path);
    logger.info("openaiCodex.logout.success", { path });
    return { success: true };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      logger.info("openaiCodex.logout.noCredentials", { path });
      return { success: true };
    }
    logger.error("openaiCodex.logout.error", { path, error: error.message });
    return { success: false, error: error.message };
  }
}

function cleanup(): void {
  if (pendingLogin?.timeout) clearTimeout(pendingLogin.timeout);
  pendingLogin = null;
}

export async function refreshIfNeeded(): Promise<boolean> {
  return (await refreshAuth(false)) !== null;
}

export async function getAccessTokenForApi(): Promise<ParsedStoredAuth | null> {
  return refreshAuth(false);
}

export async function retryAfterUnauthorized(): Promise<ParsedStoredAuth | null> {
  return refreshAuth(true);
}

export async function checkOpenAICodexHealth(): Promise<HealthStatus> {
  const stored = await refreshAuth(false);
  if (!stored) {
    return { status: "not_authenticated" };
  }

  try {
    const response = await probeModels(stored);
    if (response.ok) {
      return {
        status: "healthy",
        email: stored.email,
        planType: stored.planType,
        accountId: stored.accountId,
      };
    }

    if (response.status === 401) {
      const refreshed = await refreshAuth(true);
      if (!refreshed) {
        return {
          status: "auth_expired",
          email: stored.email,
          planType: stored.planType,
          accountId: stored.accountId,
          error: "Stored ChatGPT OAuth token expired and refresh failed.",
        };
      }

      const retry = await probeModels(refreshed);
      if (retry.ok) {
        return {
          status: "healthy",
          email: refreshed.email,
          planType: refreshed.planType,
          accountId: refreshed.accountId,
        };
      }
    }

    return {
      status: "auth_expired",
      email: stored.email,
      planType: stored.planType,
      accountId: stored.accountId,
      error: `Codex backend returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      status: "auth_expired",
      email: stored.email,
      planType: stored.planType,
      accountId: stored.accountId,
      error: error instanceof Error ? error.message : "Health check failed",
    };
  }
}
