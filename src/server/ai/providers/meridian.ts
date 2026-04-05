import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

let meridianPort: number | null = null;
let meridianStarting: Promise<number> | null = null;

async function ensureMeridian(): Promise<number> {
  if (meridianPort) return meridianPort;
  if (meridianStarting) return meridianStarting;

  meridianStarting = (async () => {
    const { startProxyServer } = await import("@rynfar/meridian");
    const port = 3457; // fixed port for in-process proxy
    const instance = await startProxyServer({
      port,
      host: "127.0.0.1",
      silent: true,
    });
    // Wait for the server to be ready
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    meridianPort = port;
    console.log(`[meridian] proxy started on port ${port}`);
    return port;
  })();

  return meridianStarting;
}

export class MeridianProvider implements AIProvider {
  readonly name = "meridian";
  private client: Anthropic | null = null;

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const port = await ensureMeridian();
    this.client = new Anthropic({
      apiKey: "x",
      baseURL: `http://127.0.0.1:${port}`,
      maxRetries: 0,
    });
    return this.client;
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string
  ): Promise<ReceiptExtractionResult> {
    const client = await this.getClient();
    const base64 = imageBuffer.toString("base64");
    const start = Date.now();
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</user_correction>`
      : RECEIPT_EXTRACTION_PROMPT;

    const stream = client.messages.stream({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
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
              text: prompt,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    console.log(`[meridian] completed in ${Date.now() - start}ms, content blocks: ${response.content?.length}`);

    const textBlock = response.content?.find((c: { type: string }) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Meridian returned no text response");
    }

    const cleaned = textBlock.text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    const raw = JSON.parse(cleaned);
    return receiptExtractionSchema.parse(raw);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getClient();
      return true;
    } catch {
      return false;
    }
  }
}
