import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  private client: Anthropic;

  constructor(credential: string) {
    // OAuth tokens (from `claude setup-token` or ~/.claude/.credentials.json)
    // use Bearer auth; API keys use x-api-key header
    if (credential.startsWith("sk-ant-oat01-")) {
      this.client = new Anthropic({ authToken: credential, apiKey: null });
    } else {
      this.client = new Anthropic({ apiKey: credential });
    }
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<ReceiptExtractionResult> {
    const base64 = imageBuffer.toString("base64");

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
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
      // Simple check — try to create a minimal request
      return !!this.client;
    } catch {
      return false;
    }
  }
}
