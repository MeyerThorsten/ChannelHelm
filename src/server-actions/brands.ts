'use server';

import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, brands, jobs, packages, sources } from '@/db/schema';
import { MEDIA_ROOT, resolveMediaPath } from '@/lib/media-path';
import { looksLikeChannelId, slugify } from '@/lib/url';
import { resolveChannelId } from '@workers/integrations/ytdlp';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

function makeBrandId(): string {
  return `brd_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function asJsonArray(v: FormDataEntryValue | null): string[] {
  if (typeof v !== 'string' || v.trim() === '') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * If the operator typed a handle / channel URL into the YouTube field,
 * resolve it to the canonical UC… id (best-effort — falls back to whatever
 * they entered if resolution fails). Already-canonical ids pass through.
 */
async function normalizeChannelField(raw: string | null): Promise<string | null> {
  const value = raw?.trim();
  if (!value) return null;
  if (looksLikeChannelId(value)) return value;
  const resolved = await resolveChannelId(value);
  return resolved ?? value;
}

/** Ensure a slug is unique, appending -2, -3, … (excluding `exceptId`). */
async function uniqueSlug(base: string, exceptId?: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const where = exceptId
      ? and(eq(brands.slug, candidate), ne(brands.id, exceptId))
      : eq(brands.slug, candidate);
    const [hit] = await db.select({ id: brands.id }).from(brands).where(where).limit(1);
    if (!hit) return candidate;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export async function createBrandFromForm(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('name is required');
  // Auto-slugify: accept anything the operator typed (or derive from name).
  const rawSlug = String(formData.get('slug') ?? '').trim() || name;
  const slug = await uniqueSlug(slugify(rawSlug));
  const id = makeBrandId();

  await db.insert(brands).values({
    id,
    slug,
    name,
    defaultProcessingProfile: String(
      formData.get('defaultProcessingProfile') ?? 'standard_audio_visual',
    ),
    zernioProfileId: (formData.get('zernioProfileId') as string | null) || null,
    youtubeChannelId: await normalizeChannelField(
      formData.get('youtubeChannelId') as string | null,
    ),
    website: (formData.get('website') as string | null) || null,
    approvalRequiredFor: asJsonArray(formData.get('approvalRequiredFor')),
    autoDispatchFor: asJsonArray(formData.get('autoDispatchFor')),
  });
  revalidatePath('/brands');
  redirect(`/brands/${id}`);
}

export async function updateBrandFromForm(brandId: string, formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('name is required');
  await db
    .update(brands)
    .set({
      name,
      defaultProcessingProfile: String(
        formData.get('defaultProcessingProfile') ?? 'standard_audio_visual',
      ),
      zernioProfileId: (formData.get('zernioProfileId') as string | null) || null,
      youtubeChannelId: await normalizeChannelField(
        formData.get('youtubeChannelId') as string | null,
      ),
      website: (formData.get('website') as string | null) || null,
      active: formData.get('active') === 'on',
      approvalRequiredFor: asJsonArray(formData.get('approvalRequiredFor')),
      autoDispatchFor: asJsonArray(formData.get('autoDispatchFor')),
      updatedAt: sql`now()`,
    })
    .where(eq(brands.id, brandId));
  revalidatePath('/brands');
  revalidatePath(`/brands/${brandId}`);
}

/**
 * Normalize a brand's slug to kebab-case and migrate the on-disk media
 * accordingly. Because the slug is the media folder name
 * (MEDIA_ROOT/{slug}/{src_id}), this:
 *   1. refuses if any job is in flight for the brand's sources (renaming
 *      mid-pipeline would strand a running worker on stale paths),
 *   2. moves MEDIA_ROOT/{oldSlug} → MEDIA_ROOT/{newSlug} if it exists,
 *   3. rewrites local_media_path on every source under the brand,
 *   4. updates brands.slug.
 * No-op when the slug is already normalized.
 */
export async function renormalizeBrandSlug(brandId: string): Promise<void> {
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
  if (!brand) throw new Error(`renormalizeBrandSlug: ${brandId} not found`);

  const target = await uniqueSlug(slugify(brand.slug), brandId);
  if (target === brand.slug) {
    revalidatePath(`/brands/${brandId}`);
    return;
  }

  const brandSources = await db.select().from(sources).where(eq(sources.brandId, brandId));
  const sourceIds = brandSources.map((s) => s.id);

  // #16: a slug rename moves media folders + rewrites paths, so it must block
  // when ANY pending/running job references the brand — not just source-keyed
  // jobs. Jobs are keyed by sourceId (ingest/transcribe/visual/fuse/analysis),
  // packageId (generate_asset), assetId (dispatch), or planAssetId (clip_render).
  const [pkgRows, assetRows] = await Promise.all([
    db.select({ id: packages.id }).from(packages).where(eq(packages.brandId, brandId)),
    db.select({ id: assets.id }).from(assets).where(eq(assets.brandId, brandId)),
  ]);
  const refs = new Set<string>([
    ...sourceIds,
    ...pkgRows.map((p) => p.id),
    ...assetRows.map((a) => a.id),
  ]);
  if (refs.size > 0) {
    const liveJobs = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'running']));
    const KEYS = ['sourceId', 'packageId', 'assetId', 'planAssetId'] as const;
    const blocked = liveJobs.some((j) => {
      const p = (j.payload ?? {}) as Record<string, unknown>;
      return KEYS.some((k) => typeof p[k] === 'string' && refs.has(p[k] as string));
    });
    if (blocked) {
      throw new Error(
        'Cannot rename slug while jobs are in flight for this brand. Wait for the pipeline to finish, then retry.',
      );
    }
  }

  // Move the media folder (guarded to MEDIA_ROOT).
  const oldDir = resolveMediaPath(brand.slug);
  const newDir = resolveMediaPath(target);
  if (oldDir && newDir) {
    try {
      await rename(oldDir, newDir);
    } catch (err) {
      // ENOENT (nothing on disk yet) is fine; anything else is a real problem.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Rewrite each source's local_media_path to the new slug folder.
  for (const s of brandSources) {
    if (!s.localMediaPath) continue;
    const tail = s.id; // paths are MEDIA_ROOT/{slug}/{src_id}
    await db
      .update(sources)
      .set({ localMediaPath: join(MEDIA_ROOT, target, tail) })
      .where(eq(sources.id, s.id));
  }

  // Also rewrite the JSONB path snapshots: packages.intelligence.ingest.*
  // (file_path, audio_path) and assets.payload.local_path (thumbnails,
  // rendered clips, etc.). Without this, the next read of /api/media or the
  // dispatch worker's loadYoutubeBundle would hit ENOENT on the old folder.
  //
  // We do a generic string replace: any segment between `/media/` and the
  // next `/` that doesn't already match the target slug gets rewritten.
  // Safe across all current path shapes.
  const segRe = /\/media\/([^/]+)\//g;
  const rewriteSeg = (json: string): string =>
    json.replace(segRe, (m, seg) => (seg === target ? m : `/media/${target}/`));

  if (pkgRows.length > 0) {
    const fullPackages = await db
      .select()
      .from(packages)
      .where(eq(packages.brandId, brandId));
    for (const p of fullPackages) {
      const intel = (p.intelligence ?? {}) as Record<string, unknown>;
      const ingest = (intel.ingest ?? {}) as Record<string, unknown>;
      const before = JSON.stringify(ingest);
      const after = rewriteSeg(before);
      if (after !== before) {
        await db
          .update(packages)
          .set({ intelligence: { ...intel, ingest: JSON.parse(after) } })
          .where(eq(packages.id, p.id));
      }
    }
  }
  if (assetRows.length > 0) {
    const fullAssets = await db.select().from(assets).where(eq(assets.brandId, brandId));
    for (const a of fullAssets) {
      const before = JSON.stringify(a.payload ?? {});
      const after = rewriteSeg(before);
      if (after !== before) {
        await db
          .update(assets)
          .set({ payload: JSON.parse(after), updatedAt: sql`now()` })
          .where(eq(assets.id, a.id));
      }
    }
  }

  await db
    .update(brands)
    .set({ slug: target, updatedAt: sql`now()` })
    .where(eq(brands.id, brandId));

  revalidatePath('/brands');
  revalidatePath(`/brands/${brandId}`);
}
