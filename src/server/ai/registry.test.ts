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

  test("selects ollama provider", async () => {
    process.env.AI_PROVIDER = "ollama";
    const { getAIProvider } = await import("./registry");
    const provider = await getAIProvider();
    expect(provider.constructor.name).toBe("OllamaProvider");
  });

  test("throws for unknown provider", async () => {
    process.env.AI_PROVIDER = "gpt-5-turbo-ultra";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow('Unknown AI provider: "gpt-5-turbo-ultra"');
  });

  test("error message lists available providers", async () => {
    process.env.AI_PROVIDER = "invalid";
    const { getAIProvider } = await import("./registry");
    await expect(getAIProvider()).rejects.toThrow("openai, claude, meridian, ollama");
  });
});
