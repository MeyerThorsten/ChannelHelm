import { Nav, type NavBrand, type NavPackage } from '@/components/Nav';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';

// Server wrapper: feeds the client Nav real brands + recent packages for the
// brand switcher and ⌘K command palette. Resilient — renders an empty nav if
// the DB is unreachable.
export async function NavBar() {
  let brandRows: NavBrand[] = [];
  let pkgRows: NavPackage[] = [];
  try {
    brandRows = await db
      .select({ id: brands.id, slug: brands.slug, name: brands.name })
      .from(brands)
      .where(eq(brands.active, true))
      .orderBy(brands.slug);

    const rows = await db
      .select({
        id: packages.id,
        title: sources.title,
        originUrl: sources.originUrl,
        slug: brands.slug,
      })
      .from(packages)
      .innerJoin(sources, eq(sources.id, packages.sourceId))
      .innerJoin(brands, eq(brands.id, packages.brandId))
      .orderBy(desc(packages.updatedAt))
      .limit(20);
    pkgRows = rows.map((r) => ({
      id: r.id,
      title: r.title ?? r.originUrl ?? r.id,
      brand: r.slug,
    }));
  } catch {
    // DB unavailable — fall back to an empty nav.
  }

  return <Nav brands={brandRows} packages={pkgRows} />;
}
