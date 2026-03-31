import type { AIProvider } from "../provider";
import type { ReceiptExtractionResult } from "../schema";
import { receiptExtractionSchema } from "../schema";
import { RECEIPT_EXTRACTION_PROMPT } from "../prompts/receipt-extraction";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { getUploadDir } from "@/server/lib/upload-dir";
import { randomUUID } from "crypto";

/**
 * Claude provider using the Agent SDK (claude-agent-sdk).
 * Uses your Claude Max/Pro subscription via `claude login` OAuth — no API key needed.
 * Supports all models including Sonnet 4.6 and Opus 4.6.
 */
export class ClaudeSdkProvider implements AIProvider {
  readonly name = "claude-sdk";

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string
  ): Promise<ReceiptExtractionResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Write image to a temp file so the SDK can read it
    const uploadDir = getUploadDir();
    const tempDir = join(uploadDir, "temp");
    await mkdir(tempDir, { recursive: true });
    const ext = mimeType.split("/")[1] ?? "png";
    const tempFile = join(tempDir, `${randomUUID()}.${ext}`);
    await writeFile(tempFile, imageBuffer);

    try {
      let result = "";
      for await (const msg of query({
        prompt: `Read the image file at ${tempFile} and extract structured data from this receipt. ${RECEIPT_EXTRACTION_PROMPT}`,
        options: {
          maxTurns: 3,
          model: "sonnet",
          allowedTools: ["Read"],
        },
      })) {
        if (msg.type === "result" && "result" in msg) {
          const r = (msg as { type: "result"; result: unknown }).result;
          result = typeof r === "string" ? r : JSON.stringify(r);
        }
      }

      if (!result) {
        throw new Error("Claude SDK returned no result");
      }

      // Extract JSON from the response (may be wrapped in markdown)
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not extract JSON from Claude SDK response");
      }

      const raw = JSON.parse(jsonMatch[0]);
      return receiptExtractionSchema.parse(raw);
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      return !!query;
    } catch {
      return false;
    }
  }
}
