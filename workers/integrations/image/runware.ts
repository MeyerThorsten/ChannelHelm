/**
 * Runware text-to-image provider (https://runware.ai/docs).
 *
 * Ported from DojoClaw's `src/lib/integrations/runware-client.ts` and wrapped
 * in ChannelHelm's `ImageProvider` interface. Uses the HTTP REST API (not the
 * WebSocket), `fetch` only — no SDK. Retries transient failures; never retries
 * billing/credit errors.
 */

import { randomUUID } from 'node:crypto';
import type { ImageGenRequest, ImageGenResult, ImageProvider, ImageProviderConfig } from './types';

const DEFAULT_MODEL = 'runware:z-image@turbo';
const BILLING_PATTERNS = [
  /insufficient/i,
  /balance/i,
  /billing/i,
  /payment/i,
  /quota/i,
  /credits/i,
];

/** Runware requires width/height to be multiples of 64. */
function roundTo64(n: number): number {
  return Math.max(64, Math.round(n / 64) * 64);
}

function isBillingError(message: string): boolean {
  return BILLING_PATTERNS.some((p) => p.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RunwareImageProvider implements ImageProvider {
  constructor(private readonly config: ImageProviderConfig) {}

  getName(): string {
    return this.config.name;
  }
  getModel(): string {
    return this.config.model || DEFAULT_MODEL;
  }
  getType(): string {
    return 'runware';
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    // Runware has no free ping and a real generation costs credits — we only
    // confirm an API key is present rather than spending to test live.
    if (!this.config.apiKey) return { ok: false, error: 'no API key configured' };
    return { ok: true };
  }

  async generateImages(req: ImageGenRequest, maxRetries = 2): Promise<ImageGenResult[]> {
    const url = this.config.baseUrl || 'https://api.runware.ai/v1';
    const model = this.getModel();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const body = [
          {
            taskType: 'imageInference',
            taskUUID: randomUUID(),
            positivePrompt: req.prompt,
            width: roundTo64(req.width ?? 1280),
            height: roundTo64(req.height ?? 720),
            model,
            numberResults: req.numberResults ?? 1,
            outputQuality: 99,
            outputFormat: 'JPG',
            includeCost: true,
            ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
          },
        ];

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Runware API error (${res.status}): ${text}`);
        }

        const result = (await res.json()) as {
          data?: { imageURL: string; imageUUID: string; cost?: number }[];
          errors?: unknown;
        };
        if (result.errors) throw new Error(`Runware API error: ${JSON.stringify(result.errors)}`);

        const images: ImageGenResult[] = (result.data ?? []).map((item) => ({
          imageUrl: item.imageURL,
          cost: item.cost,
          model,
        }));
        if (images.length === 0) throw new Error('Runware API returned no images');

        const total = images.reduce((s, i) => s + (i.cost ?? 0), 0);
        console.log(`[runware] generated ${images.length} image(s), cost $${total.toFixed(4)}`);
        return images;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isBillingError(lastError.message)) throw lastError; // never retry billing
        if (attempt <= maxRetries) {
          const delay = 5000 * attempt;
          console.warn(
            `[runware] attempt ${attempt} failed (${lastError.message}), retry in ${delay / 1000}s`,
          );
          await sleep(delay);
        }
      }
    }
    throw lastError ?? new Error('Runware image generation failed');
  }
}
