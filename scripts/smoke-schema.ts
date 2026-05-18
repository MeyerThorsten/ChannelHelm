/**
 * Smoke test for the initial schema migration.
 *
 * Inserts one brand → one source → one package, reads them back, prints them,
 * then deletes in reverse FK order. Exits 0 on success.
 *
 * Run after `pnpm db:migrate` against a fresh local Postgres:
 *   pnpm smoke:schema
 */
import 'dotenv/config';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';

async function main(): Promise<void> {
  const brandId = 'brd_thorstenmeyerai';

  console.log('→ insert brand');
  const [brand] = await db
    .insert(brands)
    .values({
      id: brandId,
      slug: 'thorstenmeyerai',
      name: 'Thorsten Meyer AI',
      defaultProcessingProfile: 'standard_audio_visual',
    })
    .returning();

  console.log('→ insert source');
  const [source] = await db
    .insert(sources)
    .values({
      brandId,
      kind: 'youtube_url',
      originUrl: 'https://www.youtube.com/watch?v=test',
    })
    .returning();
  if (!source) throw new Error('source insert returned no row');

  console.log('→ insert package');
  const [pkg] = await db
    .insert(packages)
    .values({
      brandId,
      sourceId: source.id,
      status: 'draft',
      processingProfile: 'standard_audio_visual',
    })
    .returning();
  if (!pkg) throw new Error('package insert returned no row');

  console.log('→ read back');
  const readBrand = await db.select().from(brands).where(eq(brands.id, brandId));
  const readSource = await db.select().from(sources).where(eq(sources.id, source.id));
  const readPackage = await db.select().from(packages).where(eq(packages.id, pkg.id));

  console.log('brand:   ', JSON.stringify(readBrand[0], null, 2));
  console.log('source:  ', JSON.stringify(readSource[0], null, 2));
  console.log('package: ', JSON.stringify(readPackage[0], null, 2));

  console.log('→ cleanup (reverse FK order)');
  await db.delete(packages).where(eq(packages.id, pkg.id));
  await db.delete(sources).where(eq(sources.id, source.id));
  await db.delete(brands).where(eq(brands.id, brandId));

  console.log('✓ smoke ok');
  if (!brand) throw new Error('brand insert returned no row');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✗ smoke failed:', err);
    process.exit(1);
  });
