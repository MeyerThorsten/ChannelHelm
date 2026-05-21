'use server';

import { db } from '@/db/client';
import { packages, sources } from '@/db/schema';
import { discoverBrandForYoutube } from '@workers/lib/brand-discovery';
import { enqueue } from '@workers/queue';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/**
 * Ingest a YouTube URL with automatic brand discovery. The brand is resolved
 * from the channel (youtube_channel_id → website domain → auto-create) — no
 * manual brand picker needed. `fallbackBrandId` (the dashboard's selected
 * brand) is used only if yt-dlp can't read the channel. Redirects to the new
 * package on success (redirect() throws and Next handles it; discovery
 * errors propagate to the caller for inline display).
 */
export async function ingestYoutubeUrl(
  url: string,
  processingProfile: string,
  fallbackBrandId?: string,
): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('URL is required');

  const discovered = await discoverBrandForYoutube(trimmed, fallbackBrandId);
  const [source] = await db
    .insert(sources)
    .values({ brandId: discovered.brandId, kind: 'youtube_url', originUrl: trimmed })
    .returning();
  if (!source) throw new Error('source insert returned no row');
  const [pkg] = await db
    .insert(packages)
    .values({ brandId: discovered.brandId, sourceId: source.id, processingProfile })
    .returning();
  if (!pkg) throw new Error('package insert returned no row');
  await enqueue({
    kind: 'ingest',
    payload: { sourceId: source.id, packageId: pkg.id },
    idempotencyKey: `ingest:${source.id}`,
  });
  revalidatePath('/');
  redirect(`/packages/${pkg.id}`);
}

/**
 * Create a Source from the new-source form. If `createPackage=on`, also
 * create a Package referencing it and enqueue the ingest job — same flow
 * as the API path. Operator usually wants both at once when they're
 * pasting a YouTube URL into the dashboard.
 */
export async function createSourceFromForm(formData: FormData): Promise<void> {
  const brandId = String(formData.get('brandId') ?? '').trim();
  const kind = String(formData.get('kind') ?? '').trim();
  const originUrl = String(formData.get('originUrl') ?? '').trim();
  const createPackage = formData.get('createPackage') === 'on';
  const processingProfile = String(formData.get('processingProfile') ?? 'standard_audio_visual');

  if (!brandId.startsWith('brd_')) throw new Error('brandId is required');
  if (!kind) throw new Error('kind is required');

  const [source] = await db
    .insert(sources)
    .values({
      brandId,
      kind,
      originUrl: originUrl || null,
      title: (formData.get('title') as string | null) || null,
    })
    .returning();
  if (!source) throw new Error('source insert returned no row');

  if (createPackage) {
    const [pkg] = await db
      .insert(packages)
      .values({
        brandId,
        sourceId: source.id,
        processingProfile,
      })
      .returning();
    if (!pkg) throw new Error('package insert returned no row');
    await enqueue({
      kind: 'ingest',
      payload: { sourceId: source.id, packageId: pkg.id },
      idempotencyKey: `ingest:${source.id}`,
    });
    revalidatePath('/');
    redirect(`/packages/${pkg.id}`);
  }
  revalidatePath('/brands');
  redirect(`/brands/${brandId}`);
}
