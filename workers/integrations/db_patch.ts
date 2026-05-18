import { db } from '@/db/client';
import { packages } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

/**
 * Atomically merge a top-level patch into `packages.intelligence` using
 * PostgreSQL's `jsonb || jsonb` shallow-merge operator. This replaces the
 * older read-then-write-back pattern (load row → spread → UPDATE) which
 * could lose writes when transcribe_audio and analyze_visual finished
 * within the same tx window on different workers.
 *
 * Shallow merge is what we want: every caller patches at a different
 * top-level key (`transcript`, `frame_index`, `scene_log`, `analysis`)
 * so right-side-wins on the top-level key is the desired semantics.
 */
export async function patchPackageIntelligence(
  packageId: string,
  patch: Record<string, unknown>,
  extraSet?: Record<string, unknown>,
): Promise<void> {
  await db
    .update(packages)
    .set({
      ...(extraSet ?? {}),
      intelligence: sql`${packages.intelligence} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(packages.id, packageId));
}
