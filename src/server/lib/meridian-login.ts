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
