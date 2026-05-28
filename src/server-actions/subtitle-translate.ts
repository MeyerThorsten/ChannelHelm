'use server';

/**
 * Multi-language subtitle generation for a single Short clip.
 *
 * `translateClipSubtitles` reuses the existing transcript + subtitle
 * pipeline to produce translated SRT (+ ASS) sidecar files per target
 * language. It runs the LLM SYNCHRONOUSLY — the same documented
 * Content-Studio carve-out used by `regenerate.ts` / `comment-mining.ts`:
 * a bounded, text-only call. (One LLM call per language; each is a short
 * line-by-line translation of one clip's segments.)
 *
 * The produced files are recorded on the plan at
 * `payload.clips[clipIndex].subtitle_translations[lang]`. The plan is the
 * editable source of truth (mirrors `saveClipEdits`); we persist + then
 * `revalidatePath` the package.
 *
 * DEFERRED (do NOT build here — tracked in the contract addendum):
 *   - TTS dubbing (audio) — out of scope, large ML dependency.
 *   - Burned-in per-language re-render — the translated `.ass` written here
 *     is the BASIS for a future clip_render variant that would consume it to
 *     produce one `rendered_short_clip` per language, but that re-render is
 *     intentionally NOT wired. We stop at the sidecar files + plan record.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import type { AssStyle } from '@/lib/ass-subtitles';
import {
  type ClipSegment,
  extractClipSegments,
  isSupportedLanguage,
  languageLabel,
  numberedSourceLines,
  reconcileTranslations,
  serializeSrt,
  serializeTranslatedAss,
} from '@/lib/subtitle-translate';
import { complete } from '@workers/integrations/lm_studio';
import { loadPrompt, render } from '@workers/integrations/prompts';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export type TranslateResult = {
  language: string;
  segments: number;
  /** True when the LLM returned the wrong line count → captions are the source text. */
  usedFallback: boolean;
};

export async function translateClipSubtitles(input: {
  planAssetId: string;
  clipIndex: number;
  languages: string[];
}): Promise<TranslateResult[]> {
  const { planAssetId, clipIndex } = input;
  if (!planAssetId.startsWith('ast_')) throw new Error('invalid planAssetId');
  if (!Array.isArray(input.languages) || input.languages.length === 0) {
    throw new Error('pick at least one target language');
  }

  // De-dupe + validate language codes up front so a typo fails fast before
  // any LLM work.
  const languages = Array.from(new Set(input.languages.map((l) => l.trim().toLowerCase())));
  if (languages.length > 12) throw new Error('translate at most 12 languages at once');
  for (const lang of languages) {
    if (!isSupportedLanguage(lang)) {
      throw new Error(`unsupported language code '${lang}' (use ISO-639-1, e.g. es, de, fr, ja)`);
    }
  }

  // Load the plan + locate the clip (mirrors clip-edit.ts::loadPlanAndClip).
  const [plan] = await db.select().from(assets).where(eq(assets.id, planAssetId)).limit(1);
  if (!plan) throw new Error(`plan asset ${planAssetId} not found`);
  if (plan.type !== 'short_clip_plan' && plan.type !== 'long_clip_plan') {
    throw new Error(`asset ${planAssetId} is not a *_plan asset (type=${plan.type})`);
  }
  const payload = (plan.payload ?? {}) as { clips?: Record<string, unknown>[] };
  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  if (clipIndex < 0 || clipIndex >= clips.length) {
    throw new Error(`plan ${planAssetId} has no clip at index ${clipIndex} (len=${clips.length})`);
  }
  const clip = (clips[clipIndex] ?? {}) as ClipPayload;
  if (clip.deleted === true) throw new Error('clip has been deleted from the plan');

  // Pull the package transcript + the source dir (sidecars land beside the clip).
  const [joined] = await db
    .select({
      intelligence: packages.intelligence,
      processingProfile: packages.processingProfile,
      localMediaPath: sources.localMediaPath,
    })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, plan.packageId))
    .limit(1);
  if (!joined) throw new Error(`package/source for plan ${planAssetId} not found`);
  if (!joined.localMediaPath) {
    throw new Error('source has no local media path — cannot write subtitle sidecars');
  }

  // Effective trim (operator override wins; else LLM start/end), in SOURCE seconds.
  const clipStart = num(clip.trim?.start ?? clip.start, 0);
  const clipEnd = num(clip.trim?.end ?? clip.end, 0);
  if (clipEnd <= clipStart) throw new Error('clip has no valid time range (end ≤ start)');

  const segments = extractClipSegments(joined.intelligence, clipStart, clipEnd);
  if (segments.length === 0) {
    throw new Error(
      'no transcript segments fall inside this clip — the package may have no transcript, or the clip window is silent',
    );
  }

  // short_clip_plan → vertical 1080×1920; long_clip_plan → horizontal 1920×1080.
  const isLong = plan.type === 'long_clip_plan';
  const clipWidth = isLong ? 1920 : 1080;
  const clipHeight = isLong ? 1080 : 1920;

  const clipsDir = join(joined.localMediaPath, 'clips');
  await mkdir(clipsDir, { recursive: true });
  const safeIndex = String(clipIndex).padStart(3, '0');
  const baseName = `clip_${safeIndex}`;

  const prompt = await loadPrompt('subtitle_translation', 1);
  const numberedSource = numberedSourceLines(segments);

  const results: TranslateResult[] = [];
  const translations: Record<string, TranslationRecord> = {
    ...((clip.subtitle_translations as Record<string, TranslationRecord> | undefined) ?? {}),
  };

  for (const lang of languages) {
    const { texts, usedFallback } = await translateOne({
      lang,
      prompt,
      numberedSource,
      segments,
      profile: joined.processingProfile,
      planAssetId,
      clipIndex,
    });

    const srt = serializeSrt(segments, texts);
    const ass = serializeTranslatedAss({
      clipWidth,
      clipHeight,
      segments,
      texts,
      // Honour the operator's chosen styling block (font/colour/position) so
      // a translated track matches the clip's look where it makes sense.
      style: clip.styling,
    });

    const srtPath = join(clipsDir, `${baseName}.${lang}.srt`);
    const assPath = join(clipsDir, `${baseName}.${lang}.ass`);
    await writeFile(srtPath, srt, 'utf8');
    await writeFile(assPath, ass, 'utf8');

    translations[lang] = {
      srt_path: srtPath,
      ass_path: assPath,
      segments: segments.length,
      used_fallback: usedFallback,
      generated_at: new Date().toISOString(),
    };
    results.push({ language: lang, segments: segments.length, usedFallback });
  }

  // Persist onto the plan clip (mirror saveClipEdits: copy-on-write the clips
  // array, append an edits_log entry, bump updatedAt).
  const next: Record<string, unknown> = { ...clip, subtitle_translations: translations };
  const newClips = clips.slice();
  newClips[clipIndex] = next;
  const newPayload = appendEditsLog({ ...payload, clips: newClips }, clipIndex);

  await db
    .update(assets)
    .set({ payload: newPayload, updatedAt: sql`now()` })
    .where(eq(assets.id, planAssetId));

  revalidatePath(`/packages/${plan.packageId}`);
  revalidatePath(`/packages/${plan.packageId}/shorts/${clipIndex}`);
  return results;
}

// ─── internals ──────────────────────────────────────────────────────────────

type ClipPayload = {
  start?: number;
  end?: number;
  trim?: { start?: number; end?: number };
  styling?: Partial<AssStyle>;
  subtitle_translations?: Record<string, unknown>;
  deleted?: boolean;
};

type TranslationRecord = {
  srt_path: string;
  ass_path: string;
  segments: number;
  used_fallback: boolean;
  generated_at: string;
};

type LoadedPrompt = Awaited<ReturnType<typeof loadPrompt>>;

/** One LLM round-trip → reconciled translated texts for `segments`. */
async function translateOne(args: {
  lang: string;
  prompt: LoadedPrompt;
  numberedSource: string;
  segments: readonly ClipSegment[];
  profile: string;
  planAssetId: string;
  clipIndex: number;
}): Promise<{ texts: string[]; usedFallback: boolean }> {
  const user = render(args.prompt, {
    target_language: languageLabel(args.lang),
    segments: args.numberedSource,
  });

  let parsed: unknown[] = [];
  try {
    const result = await complete({
      profile: args.profile,
      system: args.prompt.system ?? undefined,
      user,
      promptVersion: `${args.prompt.name}.v${args.prompt.version}`,
      inputRefs: [`plan:${args.planAssetId}`, `clip:${args.clipIndex}`, `lang:${args.lang}`],
      // Translation can be a touch longer than the source; budget generously.
      maxTokens: 2048,
      temperature: 0.3,
    });
    parsed = parseSegments(result.text);
  } catch (err) {
    // Don't crash the whole batch — fall back to source text for this lang.
    console.warn(`[translateClipSubtitles] LLM/parse failed for ${args.lang}:`, err);
    parsed = [];
  }

  return reconcileTranslations(args.segments, parsed);
}

/**
 * Parse the LLM's `{"segments":[...]}` object. Tolerates code fences. Returns
 * the segments array (or [] on any failure — the caller's reconcile guard then
 * falls back to source text, which is the right behaviour for a bad response).
 */
function parseSegments(text: string): unknown[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    const obj = JSON.parse(stripped) as { segments?: unknown };
    return Array.isArray(obj.segments) ? obj.segments : [];
  } catch {
    return [];
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Append a subtitle_translations entry to plan.payload.edits_log (mirrors clip-edit.ts). */
function appendEditsLog(
  payload: Record<string, unknown>,
  clipIndex: number,
): Record<string, unknown> {
  const log = Array.isArray(payload.edits_log)
    ? (payload.edits_log as { at: string; by: string; fields: string[] }[])
    : [];
  log.push({
    at: new Date().toISOString(),
    by: 'operator',
    fields: [`clips.${clipIndex}.subtitle_translations`],
  });
  return { ...payload, edits_log: log };
}
