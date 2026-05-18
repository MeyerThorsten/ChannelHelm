import { db } from '@/db/client';
import { brands, packages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { complete } from '../integrations/lm_studio';
import { loadPrompt, render } from '../integrations/prompts';
import { type JobRow, enqueue } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

const ASSET_TYPES = [
  'youtube_title_set',
  'youtube_description',
  'youtube_chapters',
  'youtube_tags',
  'linkedin_post',
  'x_post',
  'x_thread',
  'article_brief',
  'newsletter_summary',
] as const;

/**
 * §13 step 8. Reads packages.intelligence.scene_log, calls Qwen3 via LM
 * Studio with the `analyze_intelligence.v1` prompt, parses the JSON output,
 * writes it into packages.intelligence.analysis with §2.2 provenance, then
 * fans out one `generate_asset` job per asset type listed in §9 of the
 * build sequence.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`analyze_intelligence: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;
  const sceneLog = intelligence.scene_log;
  if (!sceneLog) {
    throw new Error('analyze_intelligence: scene_log missing — fuse must run first');
  }
  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`analyze_intelligence: brand ${pkg.brandId} not found`);
  const profile = processingProfile ?? pkg.processingProfile;

  const prompt = await loadPrompt('analyze_intelligence', 1);
  const user = render(prompt, { brand, scene_log: sceneLog });

  console.log(
    `[analyze_intelligence] calling LLM (profile=${profile}, scene_log windows=${
      Array.isArray((sceneLog as { windows?: unknown[] }).windows)
        ? (sceneLog as { windows: unknown[] }).windows.length
        : 0
    })`,
  );
  const result = await complete({
    profile,
    system: prompt.system ?? undefined,
    user,
    promptVersion: `${prompt.name}.v${prompt.version}`,
    inputRefs: [`scene_log:${sourceId}`],
    maxTokens: 2048,
    temperature: 0.4,
    responseFormat: 'json_object',
  });

  const parsed = parseJsonStrict(result.text, 'analyze_intelligence');
  const parsedObj =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw: parsed };

  const nextIntelligence = {
    ...intelligence,
    analysis: {
      ...parsedObj,
      provenance: result.provenance,
    },
  };
  await db
    .update(packages)
    .set({ intelligence: nextIntelligence, status: 'analyzed' })
    .where(eq(packages.id, packageId));

  // Fan out generate_asset for every type from §13 step 9. Workers can also
  // produce short_clip_plan once analysis is in — that's a separate kind in
  // a later session; for now we generate the text assets in parallel.
  for (const assetType of ASSET_TYPES) {
    await enqueue({
      kind: 'generate_asset',
      payload: { sourceId, packageId, assetType, processingProfile: profile },
      idempotencyKey: `generate_asset:${packageId}:${assetType}`,
    });
  }
}

/**
 * Parses an LLM-returned JSON string. Tolerates surrounding ```json``` fences
 * even though we asked for raw JSON — LLMs slip them in routinely.
 */
function parseJsonStrict(text: string, label: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const preview = stripped.slice(0, 200);
    throw new Error(`${label}: model did not return valid JSON. First 200 chars: ${preview}`);
  }
}
