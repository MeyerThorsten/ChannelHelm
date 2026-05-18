import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { jobs, packages, sources } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchPackageIntelligence } from '../integrations/db_patch';
import { runMlScript } from '../integrations/ml_subprocess';
import { type JobRow, enqueue } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

/**
 * §13 step 5. Transcribes the source's audio.wav via `ml/transcribe.py` (MLX
 * Whisper large-v3), attaches §2.2 provenance, writes the result to
 * `packages.intelligence.transcript`, and (per §6.2) enqueues `fuse` if the
 * sibling `analyze_visual` job is either done or doesn't exist for this
 * profile.
 *
 * Diarization (`ml/diarize.py` for multi-speaker labels) is intentionally
 * deferred — it requires HF model gating + a `HF_TOKEN`.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);

  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) throw new Error(`transcribe_audio: source ${sourceId} not found`);
  if (!source.localMediaPath) {
    throw new Error(
      `transcribe_audio: source ${sourceId} has no local_media_path (ingest must run first)`,
    );
  }

  const audioPath = join(source.localMediaPath, 'audio.wav');
  const transcriptPath = join(source.localMediaPath, 'transcript.json');
  const diarizationPath = join(source.localMediaPath, 'diarization.json');

  console.log(`[transcribe_audio] ${audioPath} → ${transcriptPath}`);
  const envelope = await runMlScript({
    script: 'transcribe.py',
    args: { input: audioPath, output: transcriptPath, language: 'auto' },
  });

  const transcript = JSON.parse(await readFile(transcriptPath, 'utf8')) as {
    text?: string;
    segments?: unknown[];
    language?: string;
  };

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`transcribe_audio: package ${packageId} not found`);
  const profile = processingProfile ?? pkg.processingProfile;

  // Per §5.5: diarize "yes if speaker_count > 1" for fast/standard, "yes
  // always" for premium. We don't have a separate VAD step yet, so we attempt
  // diarization on every non-fast run and let pyannote tell us the speaker
  // count. fast_audio_only stays mono-only.
  // Skipped (with a warning, not a failure) when HF_TOKEN is missing or the
  // user hasn't accepted the pyannote model license yet.
  let diarization: { turns: unknown[]; speakers: number } | null = null;
  if (profile !== 'fast_audio_only' && process.env.HF_TOKEN) {
    try {
      await runMlScript({
        script: 'diarize.py',
        args: { input: audioPath, output: diarizationPath },
      });
      const parsed = JSON.parse(await readFile(diarizationPath, 'utf8')) as {
        turns?: unknown[];
        speakers?: number;
      };
      diarization = { turns: parsed.turns ?? [], speakers: parsed.speakers ?? 0 };
      console.log(`[transcribe_audio] diarization: ${diarization.speakers} speaker(s)`);
    } catch (err) {
      console.warn(
        `[transcribe_audio] diarize.py failed (continuing with mono-speaker transcript): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else if (profile !== 'fast_audio_only') {
    console.log('[transcribe_audio] HF_TOKEN not set, skipping diarization');
  }

  await patchPackageIntelligence(packageId, {
    transcript: {
      text: transcript.text ?? '',
      language: transcript.language,
      segments: transcript.segments ?? [],
      speaker_turns: diarization?.turns ?? null,
      speaker_count: diarization?.speakers ?? null,
      provenance: {
        provider: 'mlx-whisper',
        model: String(envelope.model ?? 'mlx-community/whisper-large-v3-mlx'),
        host: String(envelope.host ?? hostname()),
        prompt_version: null,
        input_refs: [`audio:${sourceId}`],
        generated_at: new Date().toISOString(),
        profile,
        duration_ms: envelope.duration_ms,
        diarization_provider: diarization ? 'pyannote-audio' : null,
      },
    },
  });

  await maybeEnqueueFuse({ sourceId, packageId, profile });
}

/**
 * Enqueue `fuse` iff the sibling `analyze_visual` job is finished (or doesn't
 * exist at all — true for `fast_audio_only` packages per §5.5). Idempotent
 * via the §4 idempotency key, so it's safe if both siblings race.
 */
async function maybeEnqueueFuse(opts: {
  sourceId: string;
  packageId: string;
  profile: string;
}): Promise<void> {
  const { sourceId, packageId, profile } = opts;

  if (profile === 'fast_audio_only') {
    await enqueue({
      kind: 'fuse',
      payload: { sourceId, packageId, processingProfile: profile },
      idempotencyKey: `fuse:${sourceId}:${profile}`,
    });
    return;
  }

  // Look up the sibling analyze_visual job for this source via JSONB payload.
  const siblings = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.kind, 'analyze_visual'), sql`${jobs.payload}->>'sourceId' = ${sourceId}`))
    .limit(1);
  const sibling = siblings[0];
  if (!sibling || sibling.status === 'done') {
    await enqueue({
      kind: 'fuse',
      payload: { sourceId, packageId, processingProfile: profile },
      idempotencyKey: `fuse:${sourceId}:${profile}`,
    });
  } else {
    console.log(
      `[transcribe_audio] analyze_visual sibling status=${sibling.status}, deferring fuse enqueue`,
    );
  }
}
