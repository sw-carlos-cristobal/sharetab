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
      return new ClaudeProvider(process.env.ANTHROPIC_API_KEY!);
    }
    case "ollama": {
      const { OllamaProvider } = await import("./providers/ollama");
      return new OllamaProvider(
        process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        process.env.OLLAMA_MODEL ?? "llava"
      );
    }
    default:
      throw new Error(
        `Unknown AI provider: "${name}". Available: openai, claude, ollama`
      );
  }
}
