import type { AIProvider } from "./provider";

const USER_SELECTABLE_PROVIDERS = [
  "openai",
  "openai-codex",
  "claude",
  "meridian",
  "ollama",
  "ocr",
] as const;

const ALL_PROVIDERS = [...USER_SELECTABLE_PROVIDERS, "mock"] as const;

type AIProviderName = (typeof ALL_PROVIDERS)[number];
const DEFAULT_PROVIDER_PRIORITY = "openai,ocr";

function isAIProviderName(value: string): value is AIProviderName {
  return ALL_PROVIDERS.includes(value as AIProviderName);
}

function unknownProviderError(name: string): Error {
  return new Error(
    `Unknown AI provider: "${name}". Available: ${USER_SELECTABLE_PROVIDERS.join(", ")}, mock`
  );
}

function parseProviderPriority(raw: string): AIProviderName[] {
  const parsed = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const deduped: AIProviderName[] = [];
  for (const name of parsed) {
    if (!isAIProviderName(name)) {
      throw unknownProviderError(name);
    }
    if (!deduped.includes(name)) {
      deduped.push(name);
    }
  }

  return deduped;
}

function getConfiguredProviderPriorityInternal(): AIProviderName[] {
  const rawPriority = process.env.AI_PROVIDER_PRIORITY?.trim() || DEFAULT_PROVIDER_PRIORITY;
  const priority = parseProviderPriority(rawPriority);

  // Preserve existing behavior by always allowing OCR as the final fallback.
  if (!priority.includes("ocr")) {
    priority.push("ocr");
  }

  return priority;
}

async function createProvider(name: AIProviderName): Promise<AIProvider> {
  switch (name) {
    case "openai": {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OpenAI provider requires OPENAI_API_KEY");
      }
      const { OpenAIProvider } = await import("./providers/openai");
      return new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
    }
    case "openai-codex": {
      const { OpenAICodexProvider } = await import("./providers/openai-codex");
      return new OpenAICodexProvider(process.env.OPENAI_CODEX_MODEL);
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
      throw unknownProviderError(name);
  }
}

export async function createProviderByName(name: string): Promise<AIProvider> {
  if (!isAIProviderName(name)) {
    throw unknownProviderError(name);
  }
  return createProvider(name);
}

export function getConfiguredProviderPriority(): string[] {
  return getConfiguredProviderPriorityInternal();
}

export function isProviderConfigured(name: string): boolean {
  return getConfiguredProviderPriorityInternal().includes(name as AIProviderName);
}

export async function getAIProvider(): Promise<AIProvider> {
  const [first] = getConfiguredProviderPriorityInternal();
  return createProvider(first);
}

// Cache for provider availability checks — avoids re-checking on every scan.
let cachedProviders: AIProvider[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000; // Re-check availability every 60 seconds

/** Clear the cached provider so the next call re-evaluates availability. */
export function clearProviderCache(): void {
  cachedProviders = null;
  cacheExpiry = 0;
}

/**
 * Get all currently available providers in configured priority order.
 * If none are available/configured, OCR is returned as a safe final fallback.
 */
export async function getAIProvidersWithFallback(): Promise<AIProvider[]> {
  if (cachedProviders && Date.now() < cacheExpiry) {
    return cachedProviders;
  }

  const priority = getConfiguredProviderPriorityInternal();
  const availableProviders: AIProvider[] = [];

  for (const name of priority) {
    try {
      const provider = await createProvider(name);
      if (await provider.isAvailable()) {
        availableProviders.push(provider);
      }
    } catch {
      // Continue trying lower-priority providers.
    }
  }

  if (availableProviders.length === 0) {
    const ocr = await createProvider("ocr");
    availableProviders.push(ocr);
  }

  cachedProviders = availableProviders;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return availableProviders;
}

/**
 * Get the highest-priority available provider.
 * Caches the result for 60s to avoid repeated network checks.
 */
export async function getAIProviderWithFallback(): Promise<AIProvider> {
  const [provider] = await getAIProvidersWithFallback();
  return provider;
}
