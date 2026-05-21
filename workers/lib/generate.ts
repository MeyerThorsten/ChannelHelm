import { db } from '@/db/client';
import { assets, brands, packages, sources, voiceExamples } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { patchPackageIntelligence } from '../integrations/db_patch';
import { complete } from '../integrations/lm_studio';
import { loadPrompt, render } from '../integrations/prompts';
import { produceAnalysis } from '../kinds/analyze_intelligence';
import { composeSceneLog } from '../kinds/fuse';

/**
 * Shared content generation used by BOTH the generate_asset worker (bulk
 * pipeline) and the interactive regenerate Server Action. Loads the
 * `prompts/{assetType}.v1.md` prompt, renders it with the package's
 * analysis + brand + top voice examples, calls the LLM, and returns the
 * parsed payload + §2.2 provenance. The caller decides whether to INSERT
 * (worker) or UPDATE (regenerate) the asset row.
 */
export type GeneratedAsset = {
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
};

export async function generateAssetContent(opts: {
  packageId: string;
  assetType: string;
  processingProfile?: string;
}): Promise<GeneratedAsset> {
  const { packageId, assetType } = opts;

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`generate: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;
  if (!intelligence.analysis) {
    throw new Error(
      'generate: package.intelligence.analysis missing — analyze_intelligence must run first',
    );
  }
  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`generate: brand ${pkg.brandId} not found`);
  const profile = opts.processingProfile ?? pkg.processingProfile;

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
  });

  const payload = parseJsonStrict(result.text, `generate:${assetType}`);
  return {
    payload: payload as Record<string, unknown>,
    provenance: result.provenance as unknown as Record<string, unknown>,
  };
}

export function summarizeSceneLog(sceneLog: unknown): unknown {
  if (!sceneLog || typeof sceneLog !== 'object') return null;
  const log = sceneLog as { windows?: { start: number; end: number; text: string }[] };
  return (log.windows ?? []).map((w) => ({
    start: w.start,
    end: w.end,
    text: w.text.length > 200 ? `${w.text.slice(0, 200)}…` : w.text,
  }));
}

/**
 * Make sure the package has the upstream artifacts a section generation
 * needs: a scene_log (fuse) and an analysis (analyze_intelligence). Builds
 * whichever is missing, inline. The scene_log is transcript-driven and
 * tolerates a missing frame_index, so sections can be generated from the
 * transcript alone — before the (slow) analyze_visual stage finishes.
 *
 * Throws if there isn't even a transcript yet.
 */
export async function ensureAnalysis(packageId: string): Promise<void> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`ensureAnalysis: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;

  if (!intelligence.scene_log) {
    const [source] = await db.select().from(sources).where(eq(sources.id, pkg.sourceId)).limit(1);
    if (!source) throw new Error(`ensureAnalysis: source ${pkg.sourceId} not found`);
    const sceneLog = composeSceneLog(intelligence, {
      sourceId: pkg.sourceId,
      durationSeconds: source.durationSeconds,
      profile: pkg.processingProfile,
    });
    if (!sceneLog) {
      throw new Error(
        'Transcript not ready yet — wait for transcription to finish, then generate.',
      );
    }
    await patchPackageIntelligence(packageId, { scene_log: sceneLog });
  }

  // Re-read in case we just wrote scene_log.
  const [fresh] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!(fresh?.intelligence as Record<string, unknown>)?.analysis) {
    await produceAnalysis(packageId);
  }
}

/**
 * Generate one section asset on demand and upsert it (update the existing
 * row of that type for the package, else insert). Ensures the analysis
 * exists first. Used by the studio's per-section "Generate" buttons.
 */
export async function upsertSectionAsset(packageId: string, assetType: string): Promise<string> {
  await ensureAnalysis(packageId);
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`upsertSectionAsset: package ${packageId} not found`);
  const { payload, provenance } = await generateAssetContent({ packageId, assetType });

  const [existing] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.packageId, packageId), eq(assets.type, assetType)))
    .limit(1);

  if (existing) {
    await db
      .update(assets)
      .set({ payload, provenance, status: 'ready_for_review', updatedAt: sql`now()` })
      .where(eq(assets.id, existing.id));
    return existing.id;
  }
  const [row] = await db
    .insert(assets)
    .values({
      packageId,
      brandId: pkg.brandId,
      type: assetType,
      status: 'ready_for_review',
      approvalRequired: true,
      payload,
      provenance,
    })
    .returning({ id: assets.id });
  if (!row) throw new Error('upsertSectionAsset: insert returned no row');
  return row.id;
}

export function parseJsonStrict(text: string, label: string): unknown {
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
