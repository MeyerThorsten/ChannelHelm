/**
 * Integration test (real Postgres via Testcontainers) for image/LLM provider
 * resolution + the category-filtering guarantee that the pure unit tests
 * can't reach (the filter lives in the SQL `where category = …`).
 *
 * Gated behind RUN_INTEGRATION so the default `pnpm test` stays Docker-free.
 * Run with: `pnpm test:integration` (or `RUN_INTEGRATION=1 pnpm test`).
 *
 * Also exercises the full migration chain against a fresh DB as a side effect.
 */
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const RUN = process.env.RUN_INTEGRATION === '1';

// Modules imported dynamically AFTER DATABASE_URL is set (db/client reads it at
// module-eval time and creates the pool immediately).
type DbMod = typeof import('@/db/client');
type SchemaMod = typeof import('@/db/schema');
type ImgMod = typeof import('@workers/integrations/image/get_image_provider');
type LlmMod = typeof import('@workers/integrations/llm/get_provider');

describe.skipIf(!RUN)('provider resolution (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let db: DbMod['db'];
  let llmProviders: SchemaMod['llmProviders'];
  let getImageProvider: ImgMod['getImageProvider'];
  let getProvider: LlmMod['getProvider'];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    // Keep the env LLM fallback deterministic for the "never cross" assertion.
    process.env.LM_STUDIO_DEFAULT_HOST = 'http://localhost:1234/v1';
    process.env.LM_STUDIO_DEFAULT_MODEL = 'env-fallback-model';
    process.env.OPENCLAW_BASE_URL = '';

    ({ db } = await import('@/db/client'));
    ({ llmProviders } = await import('@/db/schema'));
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db, { migrationsFolder: resolve(process.cwd(), 'migrations') });

    ({ getImageProvider } = await import('@workers/integrations/image/get_image_provider'));
    ({ getProvider } = await import('@workers/integrations/llm/get_provider'));
  }, 180_000);

  afterAll(async () => {
    // Close the pg pool BEFORE stopping the container, else its idle
    // connections error with "terminating connection due to administrator
    // command" when the server goes away.
    await db?.$client?.end?.();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(llmProviders);
  });

  type Seed = Partial<typeof llmProviders.$inferInsert> & { name: string };
  const seed = (s: Seed) =>
    db.insert(llmProviders).values({
      baseUrl: 'https://example/v1',
      model: 'm',
      ...s,
    });

  it('migrated the llm_providers table with a category column', async () => {
    // A bare insert defaulting category proves the column + default exist.
    await seed({ name: 'probe' });
    const [row] = await db.select().from(llmProviders);
    expect(row?.category).toBe('text');
  });

  it('getImageProvider returns null when no image provider is configured', async () => {
    await seed({ name: 'chat', category: 'text', type: 'openai-compatible' });
    expect(await getImageProvider('all')).toBeNull();
  });

  it('getImageProvider resolves the configured Runware image provider', async () => {
    await seed({
      name: 'Runware',
      category: 'image',
      type: 'runware',
      baseUrl: 'https://api.runware.ai/v1',
      model: 'runware:z-image@turbo',
      apiKey: 'rw-key',
      isDefault: true,
    });
    const p = await getImageProvider('all');
    expect(p).not.toBeNull();
    expect(p?.getType()).toBe('runware');
    expect(p?.getName()).toBe('Runware');
    expect(p?.getModel()).toBe('runware:z-image@turbo');
  });

  it('getImageProvider honours purpose routing (exact over all)', async () => {
    await seed({
      name: 'img-all',
      category: 'image',
      type: 'runware',
      purpose: 'all',
      isDefault: true,
    });
    await seed({
      name: 'img-premium',
      category: 'image',
      type: 'runware',
      purpose: 'premium_multimodal',
      model: 'runware:premium',
    });
    const p = await getImageProvider('premium_multimodal');
    expect(p?.getName()).toBe('img-premium');
  });

  it('getImageProvider ignores disabled image providers', async () => {
    await seed({ name: 'img-off', category: 'image', type: 'runware', enabled: false });
    expect(await getImageProvider('all')).toBeNull();
  });

  it('NEVER crosses: getProvider (LLM) ignores image rows even when image is the only/default provider', async () => {
    await seed({
      name: 'Runware',
      category: 'image',
      type: 'runware',
      isDefault: true,
      model: 'runware:z-image@turbo',
    });
    // No text providers exist → LLM resolver must fall back to the env config,
    // NOT pick the image row.
    const llm = await getProvider('all');
    expect(llm.getType()).not.toBe('runware');
    expect(llm.getType()).toBe('openai-compatible'); // env fallback
  });

  it('both resolvers coexist: text→LLM, image→image', async () => {
    await seed({
      name: 'chat',
      category: 'text',
      type: 'openai-compatible',
      isDefault: true,
      model: 'gpt-x',
    });
    await seed({
      name: 'Runware',
      category: 'image',
      type: 'runware',
      isDefault: true,
      model: 'runware:z-image@turbo',
    });

    const llm = await getProvider('all');
    const img = await getImageProvider('all');
    expect(llm.getType()).toBe('openai-compatible');
    expect(llm.getModel()).toBe('gpt-x');
    expect(img?.getType()).toBe('runware');
    expect(img?.getModel()).toBe('runware:z-image@turbo');
  });
});
