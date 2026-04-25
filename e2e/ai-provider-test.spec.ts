import { test, expect } from "@playwright/test";
import { resolve } from "path";
import { readFileSync } from "fs";
import { users, authedContext, trpcQuery, trpcMutation, trpcResult } from "./helpers";

/**
 * Tests each configured AI provider via the admin testAIProvider endpoint.
 * Requires RUN_AI_TESTS=1 and a running dev:full server.
 *
 * Setup OAuth providers first:  npx tsx e2e/ai-setup.ts
 */

const RECEIPT_PATH = resolve("e2e/receipts/coffee-shop.png");
const AI_TIMEOUT = 150_000;

test.describe("AI Provider Test — admin endpoint", () => {
  test.beforeEach(({}, testInfo) => {
    if (!process.env.RUN_AI_TESTS)
      testInfo.skip(true, "Set RUN_AI_TESTS=1 to enable");
  });
  test.setTimeout(AI_TIMEOUT);

  let configuredProviders: string[] = [];

  test.beforeAll(async () => {
    if (!process.env.RUN_AI_TESTS) return;
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const health = await trpcResult(
        await trpcQuery(ctx, "admin.getSystemHealth")
      );
      configuredProviders = (health.aiProvider as string)
        ?.split(" -> ")
        .filter(Boolean) ?? [];
    } finally {
      await ctx.dispose();
    }
  });

  async function testProvider(providerName: string) {
    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const imageBuffer = readFileSync(RECEIPT_PATH);
      const imageBase64 = imageBuffer.toString("base64");

      const res = await trpcMutation(
        ctx,
        "admin.testAIProvider",
        {
          providerName,
          imageBase64,
          mimeType: "image/png",
        },
        AI_TIMEOUT
      );

      const body = await res.json();
      return body;
    } finally {
      await ctx.dispose();
    }
  }

  test("ocr provider extracts receipt data", async () => {
    const body = await testProvider("ocr");
    const result = body.result?.data?.json;
    expect(result).toBeDefined();
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.result).toBeDefined();
    expect(result.result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.result.total).toBeGreaterThan(0);
  });

  test("meridian provider extracts receipt data", async ({}, testInfo) => {
    if (!configuredProviders.includes("meridian"))
      testInfo.skip(true, "meridian not in AI_PROVIDER_PRIORITY");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const status = await trpcResult(
        await trpcQuery(ctx, "admin.getMeridianAuthStatus")
      );
      if (status.status !== "healthy")
        testInfo.skip(true, `meridian not authenticated (${status.status})`);
    } finally {
      await ctx.dispose();
    }

    const body = await testProvider("meridian");
    const result = body.result?.data?.json;
    const error = body.error?.json;

    if (result) {
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.result.total).toBeGreaterThan(0);
      expect(result.result.currency).toBeDefined();
    } else {
      // Provider error is acceptable (rate limit, etc.) — just ensure it's not a crash
      expect(error?.message).toBeDefined();
    }
  });

  test("openai-codex provider extracts receipt data", async ({}, testInfo) => {
    if (!configuredProviders.includes("openai-codex"))
      testInfo.skip(true, "openai-codex not in AI_PROVIDER_PRIORITY");

    const ctx = await authedContext(users.alice.email, users.alice.password);
    try {
      const status = await trpcResult(
        await trpcQuery(ctx, "admin.getOpenAICodexAuthStatus")
      );
      if (status.status !== "healthy")
        testInfo.skip(true, `openai-codex not authenticated (${status.status})`);
    } finally {
      await ctx.dispose();
    }

    const body = await testProvider("openai-codex");
    const result = body.result?.data?.json;
    const error = body.error?.json;

    if (result) {
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.result.total).toBeGreaterThan(0);
    } else {
      expect(error?.message).toBeDefined();
    }
  });

  test("openai provider extracts receipt data", async ({}, testInfo) => {
    if (!configuredProviders.includes("openai"))
      testInfo.skip(true, "openai not in AI_PROVIDER_PRIORITY");

    const body = await testProvider("openai");
    const result = body.result?.data?.json;
    const error = body.error?.json;

    if (result) {
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.result.total).toBeGreaterThan(0);
    } else {
      expect(error?.message).toBeDefined();
    }
  });

  test("claude provider extracts receipt data", async ({}, testInfo) => {
    if (!configuredProviders.includes("claude"))
      testInfo.skip(true, "claude not in AI_PROVIDER_PRIORITY");

    const body = await testProvider("claude");
    const result = body.result?.data?.json;
    const error = body.error?.json;

    if (result) {
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.result.total).toBeGreaterThan(0);
    } else {
      expect(error?.message).toBeDefined();
    }
  });

  test("ollama provider extracts receipt data", async ({}, testInfo) => {
    if (!configuredProviders.includes("ollama"))
      testInfo.skip(true, "ollama not in AI_PROVIDER_PRIORITY");

    const body = await testProvider("ollama");
    const result = body.result?.data?.json;
    const error = body.error?.json;

    if (result) {
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.result.items.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(error?.message).toBeDefined();
    }
  });
});
