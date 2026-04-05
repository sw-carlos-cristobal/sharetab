import type { AIProvider } from "./provider";

export async function getAIProvider(): Promise<AIProvider> {
  const name = process.env.AI_PROVIDER ?? "openai";

  switch (name) {
    case "openai": {
      const { OpenAIProvider } = await import("./providers/openai");
      return new OpenAIProvider(process.env.OPENAI_API_KEY!);
    }
    case "claude": {
      const { ClaudeProvider } = await import("./providers/claude");
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("Claude provider requires ANTHROPIC_API_KEY");
      }
      return new ClaudeProvider(process.env.ANTHROPIC_API_KEY);
    }
    case "meridian": {
      const { MeridianProvider } = await import("./providers/meridian");
      return new MeridianProvider();
    }
    case "ollama": {
      const { OllamaProvider } = await import("./providers/ollama");
      return new OllamaProvider(
        process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        process.env.OLLAMA_MODEL ?? "llava"
      );
    }
    case "ocr": {
      const { OcrProvider } = await import("./providers/ocr");
      return new OcrProvider();
    }
    case "mock": {
      const { MockProvider } = await import("./providers/mock");
      return new MockProvider();
    }
    default:
      throw new Error(
        `Unknown AI provider: "${name}". Available: openai, claude, meridian, ollama, ocr, mock`
      );
  }
}

/**
 * Get the configured AI provider, falling back to OCR if unavailable.
 * Use this instead of getAIProvider() when you want graceful degradation.
 */
export async function getAIProviderWithFallback(): Promise<AIProvider> {
  try {
    const provider = await getAIProvider();
    if (await provider.isAvailable()) {
      return provider;
    }
  } catch {
    // Primary provider failed to initialize — fall through to OCR
  }

  const { OcrProvider } = await import("./providers/ocr");
  return new OcrProvider();
}
