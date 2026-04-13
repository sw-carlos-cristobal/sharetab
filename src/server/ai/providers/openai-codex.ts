import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";
import {
  checkOpenAICodexHealth,
  getAccessTokenForApi,
  retryAfterUnauthorized,
} from "@/server/lib/openai-codex-login";

const DEFAULT_MODEL = "gpt-5.4";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "codex_cli_rs";

function extractTextPayload(response: unknown): string {
  if (!response || typeof response !== "object") {
    throw new Error("OpenAI Codex returned an invalid response");
  }

  const root = response as Record<string, unknown>;
  if (typeof root.output_text === "string" && root.output_text.trim()) {
    return root.output_text;
  }

  const output = root.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const typed = part as { type?: string; text?: string };
        if ((typed.type === "output_text" || typed.type === "text") && typed.text) {
          return typed.text;
        }
      }
    }
  }

  throw new Error("OpenAI Codex returned no text output");
}

async function performRequest(body: object) {
  const auth = await getAccessTokenForApi();
  if (!auth?.accessToken) {
    throw new Error("OpenAI Codex provider requires ChatGPT OAuth login");
  }

  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    originator: ORIGINATOR,
  });
  if (auth.accountId) {
    headers.set("ChatGPT-Account-ID", auth.accountId);
  }

  let response = await fetch(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 401) {
    const refreshed = await retryAfterUnauthorized();
    if (!refreshed?.accessToken) {
      throw new Error("OpenAI Codex authentication expired");
    }

    headers.set("Authorization", `Bearer ${refreshed.accessToken}`);
    if (refreshed.accountId) {
      headers.set("ChatGPT-Account-ID", refreshed.accountId);
    }

    response = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI Codex request failed (${response.status}): ${text}`);
  }

  return response.json();
}

export class OpenAICodexProvider implements AIProvider {
  readonly name = "openai-codex";
  private model: string;

  constructor(model?: string) {
    this.model = model ?? DEFAULT_MODEL;
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString("base64");
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</user_correction>\n\nReturn only valid JSON.`
      : `${RECEIPT_EXTRACTION_PROMPT}\n\nReturn only valid JSON.`;

    const payload = {
      model: this.model,
      instructions: "",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:${mimeType};base64,${base64}`,
            },
          ],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: false,
      include: [],
    };

    const rawResponse = await performRequest(payload);
    const text = extractTextPayload(rawResponse)
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();

    return receiptExtractionSchema.parse(JSON.parse(text));
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (await checkOpenAICodexHealth()).status === "healthy";
    } catch {
      return false;
    }
  }
}
