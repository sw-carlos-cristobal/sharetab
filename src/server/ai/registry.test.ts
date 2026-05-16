import { describe, test, expect, vi, beforeEach } from "vitest";

describe("getAIProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test("defaults to openai when AI_PROVIDER_PRIORITY is not set", async () => {
    delete process.env.AI_PROVIDER_PRIORITY;
    process.env.OPENAI_API_KEY = "test-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider).toBeDefined();
    expect(provider.constructor.name).toBe("OpenAIProvider");
  });

  test("selects openai provider", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OpenAIProvider");
  });

  test("selects openai codex provider", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OpenAICodexProvider");
  });

  test("selects claude provider with API key", async () => {
    process.env.AI_PROVIDER_PRIORITY = "claude";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("ClaudeProvider");
  });

  test("claude provider throws without API key", async () => {
    process.env.AI_PROVIDER_PRIORITY = "claude";
    delete process.env.ANTHROPIC_API_KEY;
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("openai provider throws without API key", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai";
    delete process.env.OPENAI_API_KEY;
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("OPENAI_API_KEY");
  });

  test("selects ollama provider", async () => {
    process.env.AI_PROVIDER_PRIORITY = "ollama";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OllamaProvider");
  });

  test("silently ignores ocr in priority list", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,ocr";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OpenAICodexProvider");
  });

  test("throws for unknown provider", async () => {
    process.env.AI_PROVIDER_PRIORITY = "gpt-5-turbo-ultra";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow('Unknown AI provider: "gpt-5-turbo-ultra"');
  });

  test("error message lists available providers", async () => {
    process.env.AI_PROVIDER_PRIORITY = "invalid";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("openai, openai-codex, claude, meridian, ollama, mock");
  });

  test("uses first provider from AI_PROVIDER_PRIORITY", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex,openai";
    delete process.env.OPENAI_API_KEY;

    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OpenAICodexProvider");
  });

  test("throws for unknown provider in AI_PROVIDER_PRIORITY", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai,not-a-provider";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow('Unknown AI provider: "not-a-provider"');
  });
});

describe("getAIProviderWithFallback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test("returns empty when all providers unavailable", async () => {
    process.env.AI_PROVIDER_PRIORITY = "ollama";
    const { OllamaProvider } = await import("./providers/ollama");
    vi.spyOn(OllamaProvider.prototype, "isAvailable").mockResolvedValue(false);

    const { getAIProvidersWithFallback } = await import("./registry");
    const providers = await getAIProvidersWithFallback();
    expect(providers).toHaveLength(0);
  });

  test("clearCache forces re-evaluation on next call", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex";
    const { getAIProviderWithFallback, clearProviderCache } = await import("./registry");

    const first = await getAIProviderWithFallback();
    expect(first.constructor.name).toBe("OpenAICodexProvider");

    clearProviderCache();
    const second = await getAIProviderWithFallback();
    expect(second.constructor.name).toBe("OpenAICodexProvider");

    expect(first).not.toBe(second);
  });

  test("cached provider is returned within TTL without re-checking", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex";
    const { getAIProviderWithFallback } = await import("./registry");
    const { OpenAICodexProvider } = await import("./providers/openai-codex");
    const spy = vi.spyOn(OpenAICodexProvider.prototype, "isAvailable");

    const first = await getAIProviderWithFallback();
    const second = await getAIProviderWithFallback();

    expect(first).toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("cache expires after TTL and provider is re-evaluated", async () => {
    process.env.AI_PROVIDER_PRIORITY = "openai-codex";
    const { getAIProviderWithFallback } = await import("./registry");

    const first = await getAIProviderWithFallback();

    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    const second = await getAIProviderWithFallback();

    expect(first).not.toBe(second);
    expect(second.constructor.name).toBe("OpenAICodexProvider");

    vi.useRealTimers();
  });

  test("falls through priority list when first provider is unavailable", async () => {
    process.env.AI_PROVIDER_PRIORITY = "ollama,openai";
    process.env.OPENAI_API_KEY = "test-key";

    const { OllamaProvider } = await import("./providers/ollama");
    const { OpenAIProvider } = await import("./providers/openai");
    vi.spyOn(OllamaProvider.prototype, "isAvailable").mockResolvedValue(false);
    vi.spyOn(OpenAIProvider.prototype, "isAvailable").mockResolvedValue(true);

    const { getAIProviderWithFallback } = await import("./registry");
    const provider = await getAIProviderWithFallback();

    expect(provider.constructor.name).toBe("OpenAIProvider");
  });
});
