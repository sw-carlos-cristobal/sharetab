/**
 * Interactive AI provider setup for e2e testing.
 *
 * Authenticates Meridian (Claude OAuth) and/or OpenAI Codex (ChatGPT OAuth)
 * so that e2e tests can run against real AI providers.
 *
 * Usage:
 *   npx tsx e2e/ai-setup.ts
 *
 * The script:
 *   1. Logs in as the admin user
 *   2. Checks current auth status for each OAuth provider
 *   3. For unauthenticated providers, starts the OAuth flow and
 *      prompts you to paste the callback URL
 *   4. Reports final status of all providers
 *
 * Requires:
 *   - dev:full server running (npm run dev:full)
 *   - ADMIN_EMAIL set to alice@example.com (seed data)
 *   - AI_PROVIDER_PRIORITY includes meridian and/or openai-codex
 */

import * as readline from "readline";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "alice@example.com", password: "password123" };

async function getAuthedCookies(): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const cookies = csrfRes.headers.getSetCookie?.() ?? [];
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies.join("; "),
    },
    body: new URLSearchParams({
      email: ADMIN.email,
      password: ADMIN.password,
      csrfToken,
    }),
    redirect: "manual",
  });

  const allCookies = [
    ...cookies,
    ...(loginRes.headers.getSetCookie?.() ?? []),
  ];
  return allCookies.map((c) => c.split(";")[0]).join("; ");
}

async function trpcQuery(cookies: string, proc: string) {
  const input = encodeURIComponent(
    JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } })
  );
  const res = await fetch(`${BASE}/api/trpc/${proc}?batch=1&input=${input}`, {
    headers: { Cookie: cookies },
  });
  const body = (await res.json()) as Array<{ result?: { data?: { json?: unknown } }; error?: unknown }>;
  return body[0]?.result?.data?.json;
}

async function trpcMutate(cookies: string, proc: string, input: unknown) {
  const res = await fetch(`${BASE}/api/trpc/${proc}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
    },
    body: JSON.stringify({ json: input }),
  });
  return res.json();
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface AuthStatus {
  status: string;
  email?: string;
  error?: string;
  loginInProgress?: boolean;
}

async function setupProvider(
  cookies: string,
  name: "meridian" | "openai-codex",
  statusProc: string,
  startProc: string,
  completeProc: string
) {
  const status = (await trpcQuery(cookies, statusProc)) as AuthStatus | null;

  if (!status || status.status === "not_applicable") {
    console.log(`  ${name}: not configured in AI_PROVIDER_PRIORITY — skipping`);
    return false;
  }

  if (status.status === "healthy") {
    console.log(`  ${name}: already authenticated (${status.email ?? "unknown"})`);
    return true;
  }

  console.log(`  ${name}: ${status.status}${status.error ? ` — ${status.error}` : ""}`);
  const answer = await prompt(`  Authenticate ${name} now? (y/N) `);
  if (answer.toLowerCase() !== "y") {
    console.log(`  Skipped.`);
    return false;
  }

  const startResult = (await trpcMutate(cookies, startProc, {})) as {
    result?: { data?: { json?: { url?: string } } };
  };
  const url = startResult.result?.data?.json?.url;
  if (!url) {
    console.error(`  Failed to start login flow.`);
    return false;
  }

  console.log(`\n  1. Open this URL in your browser:\n     ${url}\n`);
  console.log(`  2. Complete the login, then copy the callback URL from your browser's address bar.`);
  const code = await prompt(`\n  Paste the callback URL or authorization code: `);

  if (!code) {
    console.log(`  No code provided — cancelling.`);
    return false;
  }

  const completeResult = (await trpcMutate(cookies, completeProc, { code })) as {
    result?: { data?: { json?: { success?: boolean; error?: string } } };
  };
  const result = completeResult.result?.data?.json;

  if (result?.success) {
    console.log(`  Login successful!`);
    return true;
  } else {
    console.error(`  Login failed: ${result?.error ?? "unknown error"}`);
    return false;
  }
}

async function main() {
  console.log("\nShareTab AI Provider Setup");
  console.log("==========================\n");

  console.log(`Connecting to ${BASE}...`);
  let cookies: string;
  try {
    cookies = await getAuthedCookies();
    console.log(`Authenticated as admin (${ADMIN.email})\n`);
  } catch (err) {
    console.error(
      `Failed to connect. Is the dev server running? (npm run dev:full)\n`,
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  console.log("Checking provider status:\n");

  const meridianReady = await setupProvider(
    cookies,
    "meridian",
    "admin.getMeridianAuthStatus",
    "admin.startMeridianLogin",
    "admin.completeMeridianLogin"
  );

  console.log();

  const openaiCodexReady = await setupProvider(
    cookies,
    "openai-codex",
    "admin.getOpenAICodexAuthStatus",
    "admin.startOpenAICodexLogin",
    "admin.completeOpenAICodexLogin"
  );

  console.log("\n──────────────────────────────");
  console.log("Provider Status Summary:");
  console.log(`  meridian:     ${meridianReady ? "ready" : "not ready"}`);
  console.log(`  openai-codex: ${openaiCodexReady ? "ready" : "not ready"}`);
  console.log("──────────────────────────────\n");

  if (meridianReady || openaiCodexReady) {
    console.log("Run AI tests with:");
    console.log(`  RUN_AI_TESTS=1 BASE_URL=${BASE} npx playwright test ai-provider-test.spec.ts\n`);
  } else {
    console.log("No OAuth providers authenticated. AI tests will use whatever");
    console.log("providers are available (API-key based or OCR fallback).\n");
  }
}

main().catch(console.error);
