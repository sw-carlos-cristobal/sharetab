import type { AIProvider } from "./provider";
import { OpenAIProvider } from "./providers/openai";
import { ClaudeProvider } from "./providers/claude";
import { OllamaProvider } from "./providers/ollama";

const providers: Record<string, () => AIProvider> = {
  openai: () => new OpenAIProvider(process.env.OPENAI_API_KEY!),
  claude: () => new ClaudeProvider(process.env.ANTHROPIC_API_KEY!),
  ollama: () =>
    new OllamaProvider(
      process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      process.env.OLLAMA_MODEL ?? "llava"
    ),
};

export function getAIProvider(): AIProvider {
  const name = process.env.AI_PROVIDER ?? "openai";
  const factory = providers[name];
  if (!factory) {
    throw new Error(
      `Unknown AI provider: "${name}". Available: ${Object.keys(providers).join(", ")}`
    );
  }
  return factory();
}
