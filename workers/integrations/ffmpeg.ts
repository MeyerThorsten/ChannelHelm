import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProc } from './_proc';

/**
 * Thin ffmpeg/ffprobe wrappers. Shared by ingest (audio extract + scene
 * detection), clip_render (Session 14), and frame sampling (Session 06).
 */

export async function extractAudioWav(opts: {
  inputPath: string;
  outputPath: string;
  /** Whisper expects 16 kHz mono PCM by default. */
  sampleRate?: number;
}): Promise<void> {
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-i',
      opts.inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(opts.sampleRate ?? 16000),
      '-f',
      'wav',
      opts.outputPath,
    ],
    { logCommand: true },
  );
}

/**
 * Returns the list of scene-cut timestamps (seconds) detected by ffmpeg's
 * `select='gt(scene,N)',metadata=print` filter. Cuts at `[0]` represent the
 * head of every shot after the opening one. An empty array means no cuts
 * crossed the threshold (a single uninterrupted shot, e.g. a static webcam).
 */
export async function detectScenes(opts: {
  inputPath: string;
  /** 0..1 — higher means fewer false positives. 0.3 is a good default. */
  threshold?: number;
}): Promise<number[]> {
  const threshold = opts.threshold ?? 0.3;
  const { stderr } = await runProc(
    'ffmpeg',
    [
      '-i',
      opts.inputPath,
      '-vf',
      `select='gt(scene,${threshold})',metadata=print`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    { logCommand: true },
  );
  const cuts: number[] = [];
  for (const line of stderr.split('\n')) {
    const match = line.match(/pts_time:([\d.]+)/);
    if (match?.[1]) cuts.push(Number.parseFloat(match[1]));
  }
  // Dedup and sort defensively — ffmpeg occasionally emits duplicate frames
  // near keyframe boundaries.
  return [...new Set(cuts)].sort((a, b) => a - b);
}

export async function probeDurationSeconds(inputPath: string): Promise<number> {
  const { stdout } = await runProc('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ]);
  const n = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(n)) {
    throw new Error(`ffprobe: could not parse duration from output: ${stdout}`);
  }
  return n;
}

/**
 * Sample frames at a fixed fps. Writes `${outputDir}/frame_NNNNNN.jpg` and
 * returns a manifest of `{ timestamp, path }` for every frame written.
 *
 * fps=1 (default) matches §5.5's standard/premium profile spec. Scene
 * boundaries are NOT added here — they're surfaced separately by
 * `detectScenes` and merged into the scene log by the fuse worker.
 */
export async function sampleFrames(opts: {
  inputPath: string;
  outputDir: string;
  fps?: number;
  jpegQuality?: number;
}): Promise<{ timestamp: number; path: string }[]> {
  const fps = opts.fps ?? 1;
  await mkdir(opts.outputDir, { recursive: true });
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-i',
      opts.inputPath,
      '-vf',
      `fps=${fps}`,
      '-q:v',
      String(opts.jpegQuality ?? 3),
      join(opts.outputDir, 'frame_%06d.jpg'),
    ],
    { logCommand: true },
  );

  const files = (await readdir(opts.outputDir)).filter((f) => /^frame_\d+\.jpg$/.test(f)).sort();
  return files.map((file, i) => ({
    // ffmpeg's fps filter outputs frame N at t = N / fps (frame_000001 → t=0,
    // frame_000002 → t=1/fps, …).
    timestamp: i / fps,
    path: join(opts.outputDir, file),
  }));
}

/**
 * Extract a single still frame at a specific timestamp. Used by Session 15
 * thumbnail generation.
 */
export async function extractFrameAt(opts: {
  inputPath: string;
  timestamp: number; // seconds
  outputPath: string;
}): Promise<void> {
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-ss',
      String(opts.timestamp),
      '-i',
      opts.inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      opts.outputPath,
    ],
    { logCommand: true },
  );
}

/**
 * Render a vertical short clip from a slice of the source video.
 *
 * Inputs:
 *   inputPath  — the source MP4
 *   start, end — slice bounds in seconds
 *   outputPath — destination MP4 (vertical 1080×1920 by default)
 *   crop       — 'center-crop' (default) keeps the center vertical strip;
 *                'pillarbox' adds black bars to preserve the original aspect
 *   subtitleVttPath (optional) — burn-in VTT subtitles
 *
 * Used by `clip_render` (Session 14) to materialise `short_clip_plan`
 * entries into `rendered_short_clip` assets.
 */
export async function renderVerticalClip(opts: {
  inputPath: string;
  start: number;
  end: number;
  outputPath: string;
  width?: number;
  height?: number;
  crop?: 'center-crop' | 'pillarbox';
  subtitleVttPath?: string;
}): Promise<void> {
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1920;
  const duration = Math.max(opts.end - opts.start, 0.1);

  // Crop strategy: center-crop scales the source so its height fills the
  // target, then crops horizontally to width. Pillarbox scales to width
  // and pads top/bottom with black.
  const baseScale =
    opts.crop === 'pillarbox'
      ? `scale=${width}:-2,pad=${width}:${height}:0:(oh-ih)/2:color=black`
      : `scale=-2:${height},crop=${width}:${height}`;

  const vf = opts.subtitleVttPath
    ? `${baseScale},subtitles=${escapeFilterPath(opts.subtitleVttPath)}`
    : baseScale;

  await runProc(
    'ffmpeg',
    [
      '-y',
      '-ss',
      String(opts.start),
      '-i',
      opts.inputPath,
      '-t',
      String(duration),
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      opts.outputPath,
    ],
    { logCommand: true },
  );
}

function escapeFilterPath(p: string): string {
  // ffmpeg's filter parser treats `:` as an option separator and `'` as a
  // string delimiter. The `subtitles` filter wants the path single-quoted
  // with backslashes escaping any embedded single quotes.
  return `'${p.replace(/'/g, "\\'").replace(/:/g, '\\:')}'`;
}
