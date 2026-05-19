'use server';

import { randomBytes } from 'node:crypto';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

function makeBrandId(): string {
  // Time-prefixed random — keeps inserts roughly monotonic without pulling
  // ulid into a server action's bundle.
  return `brd_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

function asJsonArray(v: FormDataEntryValue | null): string[] {
  if (typeof v !== 'string' || v.trim() === '') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function createBrandFromForm(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  if (!slug || !name) throw new Error('slug and name are required');
  const id = makeBrandId();
  await db.insert(brands).values({
    id,
    slug,
    name,
    defaultProcessingProfile: String(
      formData.get('defaultProcessingProfile') ?? 'standard_audio_visual',
    ),
    zernioProfileId: (formData.get('zernioProfileId') as string | null) || null,
    youtubeChannelId: (formData.get('youtubeChannelId') as string | null) || null,
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
      youtubeChannelId: (formData.get('youtubeChannelId') as string | null) || null,
      active: formData.get('active') === 'on',
      approvalRequiredFor: asJsonArray(formData.get('approvalRequiredFor')),
      autoDispatchFor: asJsonArray(formData.get('autoDispatchFor')),
      updatedAt: sql`now()`,
    })
    .where(eq(brands.id, brandId));
  revalidatePath('/brands');
  revalidatePath(`/brands/${brandId}`);
}
