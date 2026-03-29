import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// OAuth tokens work with Haiku models via the oauth beta header.
// Sonnet/Opus 4.x return 400 with OAuth regardless of headers.
// API keys work with all models.
const OAUTH_MODEL = "claude-haiku-4-5";
const API_KEY_MODEL = "claude-sonnet-4-6";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  private client: Anthropic;
  private isOAuth: boolean;

  constructor(credential: string) {
    this.isOAuth = credential.startsWith("sk-ant-oat");

    if (this.isOAuth) {
      this.client = new Anthropic({
        authToken: credential,
        apiKey: null,
        defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER },
      });
    } else {
      this.client = new Anthropic({ apiKey: credential });
    }
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString("base64");
    const model = this.isOAuth ? OAUTH_MODEL : API_KEY_MODEL;

    const response = await this.client.messages.create({
      model,
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as ImageMediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: RECEIPT_EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Claude returned no text response");
    }

    const raw = JSON.parse(textBlock.text);
    return receiptExtractionSchema.parse(raw);
  }

  async isAvailable(): Promise<boolean> {
    try {
      return !!this.client;
    } catch {
      return false;
    }
  }
}
