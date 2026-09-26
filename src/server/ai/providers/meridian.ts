import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from '../provider';
import type { ReceiptExtractionResult } from '../schema';
import { receiptExtractionSchema } from '../schema';
import { RECEIPT_EXTRACTION_PROMPT } from '../prompts/receipt-extraction';
import { logger } from '@/server/lib/logger';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

let meridianPort: number | null = null;
let meridianStarting: Promise<number> | null = null;
let lastStartError: string | null = null;

/** Why the last proxy start failed, or null once a start has succeeded. */
export function getMeridianStartError(): string | null {
  return lastStartError;
}

/**
 * Starts the proxy and settles once it answers or the start fails; never
 * rejects (a failure is logged and kept for getMeridianStartError()).
 */
export async function startMeridianProxy(): Promise<void> {
  try {
    await ensureMeridian();
  } catch {
    // ensureMeridian() already logged and recorded the failure.
  }
}

// startProxyServer resolves before the server listens, and a failed listen
// only logs when silent is off, so poll /health for up to 10s. Any response
// with Meridian's JSON means it is listening (it answers 503 when unhealthy,
// e.g. without a boot identity); anything else on the port means our listen
// failed. isAvailable() then only checks for a 2xx, which a "degraded" proxy
// (auth unverifiable, e.g. no login) also returns.
async function waitForMeridian(port: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const body: unknown = await res.json().catch(() => null);
    if (typeof body === 'object' && body !== null && 'status' in body) return;
    throw new Error(`Something other than Meridian answers on port ${port}`);
  }
  throw new Error(`Meridian proxy did not answer on port ${port}`);
}

async function ensureMeridian(): Promise<number> {
  if (meridianPort) return meridianPort;
  if (meridianStarting) return meridianStarting;

  meridianStarting = (async () => {
    // Refresh expired OAuth token before starting the proxy
    const { refreshIfNeeded } = await import('../../lib/meridian-login');
    await refreshIfNeeded();

    const { startProxyServer } = await import('@rynfar/meridian');
    const port = parseInt(process.env.MERIDIAN_PORT ?? '3457', 10);
    const proxy = await startProxyServer({
      port,
      host: '127.0.0.1',
      silent: true,
    });
    try {
      await waitForMeridian(port);
    } catch (err) {
      // Stop the half-started proxy (it runs timers even if its listen
      // failed) so a retry doesn't leave it behind.
      await proxy.close().catch(() => undefined);
      throw err;
    }
    meridianPort = port;
    lastStartError = null;
    console.log(`[meridian] proxy started on port ${port}`);
    return port;
  })().catch((err: unknown) => {
    // Forget the failed start so the next call tries again (after a new
    // login, for example) instead of failing until the server restarts.
    meridianStarting = null;
    lastStartError = (err instanceof Error ? err.message : String(err)) || 'Meridian proxy failed to start';
    logger.error('meridian.start.failed', { error: lastStartError });
    throw err;
  });

  return meridianStarting;
}

export class MeridianProvider implements AIProvider {
  readonly name = 'meridian';
  private client: Anthropic | null = null;

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const port = await ensureMeridian();
    this.client = new Anthropic({
      apiKey: 'x',
      baseURL: `http://127.0.0.1:${port}`,
      maxRetries: 0,
    });
    return this.client;
  }

  async extractReceipt(
    imageBuffer: Buffer,
    mimeType: string,
    correctionHint?: string,
  ): Promise<ReceiptExtractionResult> {
    const client = await this.getClient();
    const base64 = imageBuffer.toString('base64');
    const start = Date.now();
    const prompt = correctionHint
      ? `${RECEIPT_EXTRACTION_PROMPT}\n\nThe user has provided a correction. Apply it to improve accuracy:\n<user_correction>${correctionHint.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</user_correction>`
      : RECEIPT_EXTRACTION_PROMPT;

    const stream = client.messages.stream(
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as ImageMediaType,
                  data: base64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      },
      { timeout: 120_000 },
    );

    const response = await stream.finalMessage();
    console.log(`[meridian] completed in ${Date.now() - start}ms, content blocks: ${response.content?.length}`);

    const textBlock = response.content?.find((c: { type: string }) => c.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Meridian returned no text response');
    }

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
    const raw = JSON.parse(cleaned);
    return receiptExtractionSchema.parse(raw);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const port = await ensureMeridian();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
