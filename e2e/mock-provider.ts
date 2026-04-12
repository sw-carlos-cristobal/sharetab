/**
 * E2E mock provider — intercepts tRPC batch requests at the browser level
 * to simulate any AI provider state without server-side configuration.
 *
 * tRPC batches multiple queries into a single HTTP request:
 *   GET /api/trpc/admin.getSystemHealth,admin.getMeridianAuthStatus,...?batch=1
 *
 * This helper intercepts ALL /api/trpc/* requests and splices mock responses
 * into the batch for any procedure that has been registered. Non-mocked
 * procedures pass through to the real server.
 *
 * Usage:
 *   const mock = new MockProvider(page);
 *   mock.setSystemHealth({ aiProvider: "openai", aiAvailable: true });
 *   mock.setMeridianAuth({ status: "unhealthy", error: "Not logged in" });
 *   await mock.install();
 */

import { type Page, type Route } from "@playwright/test";

// ─── Types ────────────────────────────────────────────────

export interface SystemHealthOverride {
  dbStatus?: "connected" | "disconnected";
  aiProvider?: string;
  aiAvailable?: boolean;
  ocrFallback?: boolean;
  version?: string;
  /** Seconds — defaults to 120 */
  uptime?: number;
}

export type MeridianStatus = "healthy" | "unhealthy" | "degraded" | "not_running" | "not_applicable";

export interface MeridianAuthOverride {
  status: MeridianStatus;
  email?: string;
  error?: string;
  loginInProgress?: boolean;
}

export interface MeridianNotifyOverride {
  interval: "once" | "1h" | "6h" | "24h";
}

export interface MeridianLoginResult {
  url: string;
}

export interface MeridianCompleteResult {
  success: boolean;
  error?: string;
}

// ─── Presets ──────────────────────────────────────────────

/** Common provider configurations for quick setup */
export const providerPresets = {
  // ── OpenAI ─────────────────────────────
  openaiAvailable: {
    systemHealth: { aiProvider: "openai", aiAvailable: true, ocrFallback: false },
    meridianAuth: { status: "not_applicable" as const },
  },
  openaiUnavailable: {
    systemHealth: { aiProvider: "openai", aiAvailable: false, ocrFallback: true },
    meridianAuth: { status: "not_applicable" as const },
  },

  // ── Claude (API key) ───────────────────
  claudeAvailable: {
    systemHealth: { aiProvider: "claude", aiAvailable: true, ocrFallback: false },
    meridianAuth: { status: "not_applicable" as const },
  },
  claudeUnavailable: {
    systemHealth: { aiProvider: "claude", aiAvailable: false, ocrFallback: true },
    meridianAuth: { status: "not_applicable" as const },
  },

  // ── Meridian (Claude OAuth proxy) ──────
  meridianHealthy: {
    systemHealth: { aiProvider: "meridian", aiAvailable: true, ocrFallback: false },
    meridianAuth: {
      status: "healthy" as const,
      email: "user@claude.ai",
      loginInProgress: false,
    },
  },
  meridianUnhealthy: {
    systemHealth: { aiProvider: "meridian", aiAvailable: false, ocrFallback: true },
    meridianAuth: {
      status: "unhealthy" as const,
      error: "Not logged in. Run: claude login",
      loginInProgress: false,
    },
  },
  meridianDegraded: {
    systemHealth: { aiProvider: "meridian", aiAvailable: true, ocrFallback: false },
    meridianAuth: {
      status: "degraded" as const,
      error: "Could not verify auth status",
      loginInProgress: false,
    },
  },
  meridianNotRunning: {
    systemHealth: { aiProvider: "meridian", aiAvailable: false, ocrFallback: true },
    meridianAuth: {
      status: "not_running" as const,
      loginInProgress: false,
    },
  },
  meridianLoginInProgress: {
    systemHealth: { aiProvider: "meridian", aiAvailable: false, ocrFallback: true },
    meridianAuth: {
      status: "unhealthy" as const,
      error: "Not logged in. Run: claude login",
      loginInProgress: true,
    },
  },

  // ── Ollama ─────────────────────────────
  ollamaAvailable: {
    systemHealth: { aiProvider: "ollama (llava)", aiAvailable: true, ocrFallback: false },
    meridianAuth: { status: "not_applicable" as const },
  },
  ollamaUnavailable: {
    systemHealth: { aiProvider: "ollama (llava)", aiAvailable: false, ocrFallback: true },
    meridianAuth: { status: "not_applicable" as const },
  },

  // ── OCR (no AI) ────────────────────────
  ocrOnly: {
    systemHealth: { aiProvider: "ocr", aiAvailable: true, ocrFallback: false },
    meridianAuth: { status: "not_applicable" as const },
  },

  // ── Not configured ─────────────────────
  notConfigured: {
    systemHealth: { aiProvider: "not configured", aiAvailable: false, ocrFallback: true },
    meridianAuth: { status: "not_applicable" as const },
  },

  // ── Database down ──────────────────────
  dbDown: {
    systemHealth: { dbStatus: "disconnected" as const, aiProvider: "openai", aiAvailable: true },
    meridianAuth: { status: "not_applicable" as const },
  },
} as const;

// ─── MockProvider class ──────────────────────────────────

export class MockProvider {
  private page: Page;
  private mocks: Record<string, unknown> = {};
  private installed = false;

  constructor(page: Page) {
    this.page = page;
  }

  // ── Fluent setters ───────────────────────

  /** Override fields in admin.getSystemHealth response */
  setSystemHealth(overrides: SystemHealthOverride): this {
    this.mocks["admin.getSystemHealth"] = {
      dbStatus: "connected",
      aiProvider: "mock",
      aiAvailable: true,
      ocrFallback: false,
      version: "0.0.0-test",
      serverStartTime: new Date().toISOString(),
      uptime: 120,
      ...overrides,
    };
    return this;
  }

  /** Override admin.getMeridianAuthStatus response */
  setMeridianAuth(overrides: MeridianAuthOverride): this {
    if (overrides.status === "not_applicable") {
      this.mocks["admin.getMeridianAuthStatus"] = { status: "not_applicable" };
    } else {
      this.mocks["admin.getMeridianAuthStatus"] = {
        loginInProgress: false,
        ...overrides,
      };
    }
    return this;
  }

  /** Override admin.getMeridianNotifyPreference response */
  setMeridianNotifyPreference(overrides: MeridianNotifyOverride): this {
    this.mocks["admin.getMeridianNotifyPreference"] = overrides;
    return this;
  }

  /** Mock admin.startMeridianLogin mutation response */
  setMeridianLoginResult(result: MeridianLoginResult): this {
    this.mocks["admin.startMeridianLogin"] = result;
    return this;
  }

  /** Mock admin.completeMeridianLogin mutation response */
  setMeridianCompleteResult(result: MeridianCompleteResult): this {
    this.mocks["admin.completeMeridianLogin"] = result;
    return this;
  }

  /** Mock admin.cancelMeridianLogin mutation response */
  setMeridianCancelResult(): this {
    this.mocks["admin.cancelMeridianLogin"] = { cancelled: true };
    return this;
  }

  /** Apply a preset — a named bundle of systemHealth + meridianAuth overrides */
  usePreset(preset: keyof typeof providerPresets): this {
    const config = providerPresets[preset];
    this.setSystemHealth(config.systemHealth);
    this.setMeridianAuth(config.meridianAuth);
    // Default notification preference
    if (!this.mocks["admin.getMeridianNotifyPreference"]) {
      this.setMeridianNotifyPreference({ interval: "once" });
    }
    return this;
  }

  // ── Installation ─────────────────────────

  /**
   * Install route intercepts on the page. Must be called before navigation.
   * Safe to call multiple times — only installs once.
   */
  async install(): Promise<void> {
    if (this.installed) return;
    this.installed = true;

    const mocks = this.mocks;

    await this.page.route("**/api/trpc/**", async (route: Route) => {
      const url = route.request().url();
      const method = route.request().method();

      // Extract procedure names from URL: /api/trpc/proc1,proc2,...?params
      const pathMatch = url.match(/\/api\/trpc\/([^?]+)/);
      if (!pathMatch) {
        await route.continue();
        return;
      }

      const procedures = pathMatch[1].split(",");
      const hasMock = procedures.some((p) => p in mocks);

      if (!hasMock) {
        await route.continue();
        return;
      }

      const allMocked = procedures.every((p) => p in mocks);

      // All procedures are mocked — fulfill directly without hitting the server.
      // Handles both batched mutations (POST ?batch=1) and fully-mocked GET batches.
      if (allMocked) {
        const results = procedures.map((proc) => ({
          result: { data: { json: mocks[proc] } },
        }));
        const body = url.includes("batch=")
          ? results
          : results[0];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
        return;
      }

      // Mixed batch — some procedures mocked, some real. Fetch from server
      // and splice in mock responses. Only works for GET (POST mutations
      // should always be fully mocked).
      if (method === "POST") {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      const body = await response.json();

      const modified = procedures.map((proc, i) => {
        if (proc in mocks) {
          return { result: { data: { json: mocks[proc] } } };
        }
        return body[i];
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(modified),
      });
    });
  }
}
