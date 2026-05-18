import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type JobRow, enqueue } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  words?: { word: string; start: number; end: number }[];
};

type FrameEntry = {
  timestamp: number;
  description: string;
  on_screen_text: { text: string; confidence: number; bbox: number[] }[];
  on_screen_text_joined: string;
};

const WINDOW_SECONDS = 8;

/**
 * §13 step 7. Pure TypeScript — merges the audio transcript, visual frame
 * index, and scene cut list into a §5.2 scene_log.json aligned to fixed-
 * width windows. Writes the result both to disk (alongside the source media)
 * and to `packages.intelligence.scene_log`, attaches §2.2 provenance, then
 * enqueues `analyze_intelligence`.
 *
 * Audio prosody features (energy_db, emphasis_words) are stubbed for now —
 * proper prosodic analysis lands when the diarize/prosody Python script is
 * added. speech_rate_wpm and pause_after_seconds are computed from the
 * Whisper segments directly.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);

  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) throw new Error(`fuse: source ${sourceId} not found`);
  if (!source.localMediaPath) {
    throw new Error(`fuse: source ${sourceId} has no local_media_path`);
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`fuse: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;
  const profile = processingProfile ?? pkg.processingProfile;

  const transcript = intelligence.transcript as
    | { text?: string; language?: string; segments?: TranscriptSegment[] }
    | undefined;
  if (!transcript || !transcript.segments) {
    throw new Error(`fuse: package ${packageId} has no transcript (run transcribe_audio first)`);
  }

  const frameIndex = intelligence.frame_index as
    | { frames?: FrameEntry[]; fps?: number }
    | undefined;
  // frame_index is absent under fast_audio_only — that's expected, not an error.
  const frames = frameIndex?.frames ?? [];

  const sceneCuts = Array.isArray(intelligence.scene_cuts)
    ? (intelligence.scene_cuts as number[])
    : [];

  // Find the source duration. Prefer the value cached on the source row (set
  // by ingest); fall back to the last transcript segment.
  const totalSeconds =
    source.durationSeconds ??
    Math.ceil((transcript.segments[transcript.segments.length - 1]?.end ?? 0) || 1);

  const windows = buildWindows({
    totalSeconds,
    windowSeconds: WINDOW_SECONDS,
    segments: transcript.segments,
    frames,
    sceneCuts,
  });

  const sceneLog = {
    source_id: sourceId,
    windows,
    global_features: {
      total_speakers: 1, // diarize.py would refine this
      total_scene_cuts: sceneCuts.length,
      average_speech_rate_wpm: averageWpm(windows),
      screen_text_density: classifyScreenTextDensity(windows),
    },
    provenance: {
      provider: 'fuse',
      model: 'fuse.v1',
      host: hostname(),
      prompt_version: null,
      input_refs: [
        `transcript:${sourceId}`,
        ...(frames.length > 0 ? [`frame_index:${sourceId}`] : []),
      ],
      generated_at: new Date().toISOString(),
      profile,
    },
  };

  const sceneLogPath = join(source.localMediaPath, 'scene_log.json');
  await writeFile(sceneLogPath, JSON.stringify(sceneLog, null, 2), 'utf8');

  const nextIntelligence = { ...intelligence, scene_log: sceneLog };
  await db
    .update(packages)
    .set({ intelligence: nextIntelligence })
    .where(eq(packages.id, packageId));

  await enqueue({
    kind: 'analyze_intelligence',
    payload: { sourceId, packageId, processingProfile: profile },
    idempotencyKey: `analyze_intelligence:${sourceId}:${profile}`,
  });
}

function buildWindows(opts: {
  totalSeconds: number;
  windowSeconds: number;
  segments: TranscriptSegment[];
  frames: FrameEntry[];
  sceneCuts: number[];
}) {
  const { totalSeconds, windowSeconds, segments, frames, sceneCuts } = opts;
  const out = [] as Array<{
    start: number;
    end: number;
    speaker: string | null;
    text: string;
    text_word_count: number;
    visual_descriptions: { timestamp: number; description: string }[];
    on_screen_text: { text: string; confidence: number; bbox: number[] }[];
    audio_features: {
      speech_rate_wpm: number;
      speech_rate_delta: string;
      emphasis_words: string[];
      pause_after_seconds: number;
      energy_db: number | null;
    };
    scene_boundary_within_window: boolean;
  }>;

  for (let start = 0; start < totalSeconds; start += windowSeconds) {
    const end = Math.min(start + windowSeconds, totalSeconds);

    const overlapping = segments.filter((s) => s.end > start && s.start < end);
    const text = overlapping
      .map((s) => s.text)
      .join(' ')
      .trim();
    const words = text.split(/\s+/).filter(Boolean);
    const wpm = (words.length / Math.max(end - start, 0.001)) * 60;

    const visualEntries = frames
      .filter((f) => f.timestamp >= start && f.timestamp < end)
      .map((f) => ({ timestamp: f.timestamp, description: f.description }));

    const ocrInWindow = frames
      .filter((f) => f.timestamp >= start && f.timestamp < end)
      .flatMap((f) => f.on_screen_text);

    const cutsInWindow = sceneCuts.some((t) => t >= start && t < end);

    out.push({
      start,
      end,
      speaker: null,
      text,
      text_word_count: words.length,
      visual_descriptions: visualEntries,
      on_screen_text: ocrInWindow,
      audio_features: {
        speech_rate_wpm: Math.round(wpm),
        // Filled in below once the full array exists.
        speech_rate_delta: '0%',
        emphasis_words: [],
        pause_after_seconds: 0,
        energy_db: null,
      },
      scene_boundary_within_window: cutsInWindow,
    });
  }

  // Second pass: speech_rate_delta vs previous window, pause_after_seconds.
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    if (!w) continue;
    const prev = i > 0 ? out[i - 1] : null;
    if (prev) {
      const prevWpm = prev.audio_features.speech_rate_wpm;
      const cur = w.audio_features.speech_rate_wpm;
      const delta = prevWpm > 0 ? Math.round(((cur - prevWpm) / prevWpm) * 100) : 0;
      w.audio_features.speech_rate_delta = `${delta >= 0 ? '+' : ''}${delta}%`;
    }
    const next = i + 1 < out.length ? out[i + 1] : null;
    if (next) {
      const lastEnd = lastSegmentEnd(segments, w.start, w.end);
      const nextStart = firstSegmentStart(segments, next.start, next.end);
      if (lastEnd != null && nextStart != null && nextStart > lastEnd) {
        w.audio_features.pause_after_seconds = round1(nextStart - lastEnd);
      }
    }
  }

  return out;
}

function lastSegmentEnd(segments: TranscriptSegment[], start: number, end: number): number | null {
  let lastEnd: number | null = null;
  for (const s of segments) {
    if (s.start < end && s.end > start) lastEnd = Math.max(lastEnd ?? 0, s.end);
  }
  return lastEnd;
}

function firstSegmentStart(
  segments: TranscriptSegment[],
  start: number,
  end: number,
): number | null {
  let firstStart: number | null = null;
  for (const s of segments) {
    if (s.start < end && s.end > start) {
      firstStart = firstStart == null ? s.start : Math.min(firstStart, s.start);
    }
  }
  return firstStart;
}

function averageWpm(windows: Array<{ audio_features: { speech_rate_wpm: number } }>): number {
  const wpms = windows.map((w) => w.audio_features.speech_rate_wpm).filter((n) => n > 0);
  if (wpms.length === 0) return 0;
  return Math.round(wpms.reduce((a, b) => a + b, 0) / wpms.length);
}

function classifyScreenTextDensity(
  windows: Array<{ on_screen_text: unknown[] }>,
): 'low' | 'medium' | 'high' {
  const avg =
    windows.reduce((acc, w) => acc + w.on_screen_text.length, 0) / Math.max(windows.length, 1);
  if (avg < 1) return 'low';
  if (avg < 4) return 'medium';
  return 'high';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
