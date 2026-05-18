import { db } from '@/db/client';
import { assets, brands, packages, voiceExamples } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { complete } from '../integrations/lm_studio';
import { loadPrompt, render } from '../integrations/prompts';
import type { JobRow } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  assetType: z.string().min(1),
  processingProfile: z.string().optional(),
});

/**
 * §13 step 9. One prompt per asset type lives in `prompts/{type}.v{N}.md`.
 * This worker loads the prompt, renders it with the package's analysis +
 * brand + voice examples, calls the LLM, parses the JSON response, and
 * INSERTs a row into `assets` with §2.2 provenance attached.
 *
 * Idempotency key (set by the enqueuer) is `generate_asset:{package_id}:{type}`,
 * so re-running the analyze_intelligence step will not duplicate-create
 * assets unless the operator deletes the previous job row first.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, assetType, processingProfile } = Payload.parse(job.payload);

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`generate_asset: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;
  if (!intelligence.analysis) {
    throw new Error(
      'generate_asset: package.intelligence.analysis missing — analyze_intelligence must run first',
    );
  }
  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`generate_asset: brand ${pkg.brandId} not found`);
  const profile = processingProfile ?? pkg.processingProfile;

  // Top voice examples for this asset type, by performance_score DESC.
  const examples = await db
    .select({ text: voiceExamples.text, score: voiceExamples.performanceScore })
    .from(voiceExamples)
    .where(and(eq(voiceExamples.brandId, brand.id), eq(voiceExamples.assetType, assetType)))
    .orderBy(desc(voiceExamples.performanceScore))
    .limit(5);

  const prompt = await loadPrompt(assetType, 1);
  const sceneLogSummary = summarizeSceneLog(intelligence.scene_log);
  const user = render(prompt, {
    brand,
    intelligence: { ...intelligence, scene_log_summary: sceneLogSummary },
    voice_examples: examples.length > 0 ? examples : 'No prior voice examples for this type.',
  });

  console.log(`[generate_asset] type=${assetType} package=${packageId} profile=${profile}`);
  const result = await complete({
    profile,
    system: prompt.system ?? undefined,
    user,
    promptVersion: `${prompt.name}.v${prompt.version}`,
    inputRefs: [
      `analysis:${packageId}`,
      ...(examples.length > 0 ? [`voice_examples:${brand.id}:${assetType}`] : []),
    ],
    maxTokens: 2048,
    temperature: assetType === 'article_brief' ? 0.55 : 0.65,
    responseFormat: 'json_object',
  });

  const payload = parseJsonStrict(result.text, `generate_asset:${assetType}`);

  // Respect the brand's auto_dispatch_for list. Default is "approval required";
  // brands can opt specific asset types into auto-dispatch via that JSONB array.
  const autoDispatch =
    Array.isArray(brand.autoDispatchFor) && brand.autoDispatchFor.includes(assetType);
  const approvalRequired = !autoDispatch;

  const [row] = await db
    .insert(assets)
    .values({
      packageId,
      brandId: brand.id,
      type: assetType,
      status: approvalRequired ? 'ready_for_review' : 'approved',
      approvalRequired,
      payload: payload as Record<string, unknown>,
      provenance: result.provenance,
    })
    .returning();
  if (!row) throw new Error('generate_asset: insert returned no row');
  console.log(`[generate_asset] inserted ${row.id} type=${assetType}`);

  // We deliberately don't enqueue dispatch from here. Dispatch only fires
  // after the operator approves the package as a whole (§10).
  void sourceId;
}

function summarizeSceneLog(sceneLog: unknown): unknown {
  if (!sceneLog || typeof sceneLog !== 'object') return null;
  const log = sceneLog as { windows?: { start: number; end: number; text: string }[] };
  return (log.windows ?? []).map((w) => ({
    start: w.start,
    end: w.end,
    text: w.text.length > 200 ? `${w.text.slice(0, 200)}…` : w.text,
  }));
}

function parseJsonStrict(text: string, label: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const preview = stripped.slice(0, 200);
    throw new Error(`${label}: model did not return valid JSON. First 200 chars: ${preview}`);
  }
}
