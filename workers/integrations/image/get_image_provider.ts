/**
 * Resolve the configured image-generation provider from the `llm_providers`
 * table (rows with `category = 'image'`). Returns null when none is
 * configured — callers (the thumbnail worker) fall back to frame extraction.
 *
 * Selection mirrors the LLM `selectProvider` rules (exact purpose → all →
 * default → lowest id), reusing that helper for consistency.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { decryptSecret } from '@/lib/secret-box';
import { asc, desc, eq } from 'drizzle-orm';
import { selectProvider } from '../llm/get_provider';
import { RunwareImageProvider } from './runware';
import type { ImageProvider, ImageProviderConfig } from './types';

/** Instantiate the right image provider class for a config. */
export function imageProviderFromConfig(config: ImageProviderConfig): ImageProvider {
  // Only Runware today; new types branch here.
  return new RunwareImageProvider(config);
}

/**
 * Pick the best enabled image provider for a purpose (a processing profile or
 * 'all'). Returns null when no image provider is configured.
 */
export async function getImageProvider(purpose = 'all'): Promise<ImageProvider | null> {
  const records = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.category, 'image'))
    .orderBy(desc(llmProviders.isDefault), asc(llmProviders.id));
  if (records.length === 0) return null;

  const picked = selectProvider(records, purpose);
  if (!picked) return null;

  return imageProviderFromConfig({
    name: picked.name,
    type: picked.type,
    baseUrl: picked.baseUrl,
    apiKey: decryptSecret(picked.apiKey), // #14: keys encrypted at rest
    model: picked.model,
  });
}

/**
 * Download a remote image URL to a local file (image providers return CDN
 * URLs; the YouTube uploader + /api/media need bytes on disk). Streams to
 * avoid buffering large images in memory.
 */
export async function downloadImage(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`downloadImage: GET ${url} → ${res.status}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  // res.body is a web ReadableStream; convert to a Node stream for pipeline.
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(outputPath),
  );
}
