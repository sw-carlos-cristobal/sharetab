import { describe, test, expect, vi, beforeEach } from "vitest";

describe("getAIProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test("defaults to openai when AI_PROVIDER is not set", async () => {
    delete process.env.AI_PROVIDER;
    process.env.OPENAI_API_KEY = "test-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider).toBeDefined();
    expect(provider.constructor.name).toBe("OpenAIProvider");
  });

  test("selects openai provider", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OpenAIProvider");
  });

  test("selects claude provider with API key", async () => {
    process.env.AI_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("ClaudeProvider");
  });

  test("claude provider throws without API key", async () => {
    process.env.AI_PROVIDER = "claude";
    delete process.env.ANTHROPIC_API_KEY;
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  test("openai provider throws without API key", async () => {
    process.env.AI_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("OPENAI_API_KEY");
  });

  test("selects ollama provider", async () => {
    process.env.AI_PROVIDER = "ollama";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OllamaProvider");
  });

  test("selects ocr provider", async () => {
    process.env.AI_PROVIDER = "ocr";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OcrProvider");
  });

  test("throws for unknown provider", async () => {
    process.env.AI_PROVIDER = "gpt-5-turbo-ultra";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow('Unknown AI provider: "gpt-5-turbo-ultra"');
  });

  test("error message lists available providers", async () => {
    process.env.AI_PROVIDER = "invalid";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("openai, claude, meridian, ollama, ocr");
  });
});

describe("getAIProviderWithFallback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test("fallback returns OCR when primary provider init throws", async () => {
    process.env.AI_PROVIDER = "claude";
    delete process.env.ANTHROPIC_API_KEY;
    const { getAIProviderWithFallback } = await import("./registry");
    const provider = await getAIProviderWithFallback();
    expect(provider.constructor.name).toBe("OcrProvider");
  });

  test("fallback returns OCR when primary provider isAvailable() returns false", async () => {
    // Mock the Ollama provider's isAvailable to return false deterministically
    process.env.AI_PROVIDER = "ollama";
    const { OllamaProvider } = await import("./providers/ollama");
    vi.spyOn(OllamaProvider.prototype, "isAvailable").mockResolvedValue(false);

    const { getAIProviderWithFallback } = await import("./registry");
    const provider = await getAIProviderWithFallback();
    expect(provider.constructor.name).toBe("OcrProvider");
  });

  test("clearCache forces re-evaluation on next call", async () => {
    process.env.AI_PROVIDER = "ocr";
    const { getAIProviderWithFallback, clearProviderCache } = await import("./registry");

    // Prime the cache
    const first = await getAIProviderWithFallback();
    expect(first.constructor.name).toBe("OcrProvider");

    // Clear and get again — should still work (re-evaluates)
    clearProviderCache();
    const second = await getAIProviderWithFallback();
    expect(second.constructor.name).toBe("OcrProvider");

    // They should be different instances (cache was cleared)
    expect(first).not.toBe(second);
  });

  // ── Cache state transition tests (#57) ──

  test("cached provider is returned within TTL without re-checking", async () => {
    process.env.AI_PROVIDER = "ocr";
    const { getAIProviderWithFallback } = await import("./registry");
    const { OcrProvider } = await import("./providers/ocr");
    const spy = vi.spyOn(OcrProvider.prototype, "isAvailable");

    const first = await getAIProviderWithFallback();
    const second = await getAIProviderWithFallback();

    // Same instance returned from cache
    expect(first).toBe(second);
    // isAvailable only called once (on first call, not on cached return)
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("cache expires after TTL and provider is re-evaluated", async () => {
    process.env.AI_PROVIDER = "ocr";
    const { getAIProviderWithFallback } = await import("./registry");

    const first = await getAIProviderWithFallback();

    // Advance time past TTL (60s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    const second = await getAIProviderWithFallback();

    // Different instance — cache expired, re-evaluated
    expect(first).not.toBe(second);
    expect(second.constructor.name).toBe("OcrProvider");

    vi.useRealTimers();
  });

  test("OCR cached after primary failure; primary available before TTL stays pinned to OCR", async () => {
    // Simulate: primary unavailable → OCR cached → primary recovers → still OCR until TTL
    process.env.AI_PROVIDER = "ollama";
    const { OllamaProvider } = await import("./providers/ollama");
    const spy = vi.spyOn(OllamaProvider.prototype, "isAvailable").mockResolvedValue(false);

    const { getAIProviderWithFallback } = await import("./registry");

    // First call: Ollama unavailable → OCR cached
    const first = await getAIProviderWithFallback();
    expect(first.constructor.name).toBe("OcrProvider");

    // Primary "recovers" — but cache is still valid
    spy.mockResolvedValue(true);
    const second = await getAIProviderWithFallback();

    // Still OCR — cache hasn't expired
    expect(second).toBe(first);
    expect(second.constructor.name).toBe("OcrProvider");
  });

  test("after TTL expires, recovered primary is selected over OCR", async () => {
    process.env.AI_PROVIDER = "ollama";
    const { OllamaProvider } = await import("./providers/ollama");
    const spy = vi.spyOn(OllamaProvider.prototype, "isAvailable").mockResolvedValue(false);

    const { getAIProviderWithFallback } = await import("./registry");

    // First call: Ollama unavailable → OCR cached
    const first = await getAIProviderWithFallback();
    expect(first.constructor.name).toBe("OcrProvider");

    // Primary recovers + TTL expires
    spy.mockResolvedValue(true);
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    const second = await getAIProviderWithFallback();
    // Now Ollama is selected since it's available and cache expired
    expect(second.constructor.name).toBe("OllamaProvider");

    vi.useRealTimers();
  });
});
