import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  /** Optional long-axis cap in pixels. e.g. 768 to downsize 1080p frames for the VLM. */
  maxDimension?: number;
}): Promise<{ timestamp: number; path: string }[]> {
  const fps = opts.fps ?? 1;
  await mkdir(opts.outputDir, { recursive: true });
  const scale = opts.maxDimension
    ? `,scale='if(gt(iw,ih),${opts.maxDimension},-2)':'if(gt(ih,iw),${opts.maxDimension},-2)'`
    : '';
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-i',
      opts.inputPath,
      '-vf',
      `fps=${fps}${scale}`,
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
 * Extract frames at a specific list of timestamps in a single ffmpeg pass.
 *
 * Uses the `select` filter with `between(t, ts-ε, ts+ε)` windows OR'd
 * together — one ffmpeg invocation, one process startup, regardless of how
 * many timestamps. Pairs with `sampleFrames` (dense, for OCR) when you
 * want a sparse, scene-aligned second pass (for the VLM).
 *
 * Timestamps within ~0.1 s of each other will land on the same source
 * frame; dedupe upstream if you don't want that.
 */
export async function sampleFramesAtTimestamps(opts: {
  inputPath: string;
  outputDir: string;
  timestamps: number[];
  maxDimension?: number;
  jpegQuality?: number;
}): Promise<{ timestamp: number; path: string }[]> {
  await mkdir(opts.outputDir, { recursive: true });
  if (opts.timestamps.length === 0) return [];
  const window = 0.05; // ±50 ms — wide enough for 30 fps source, narrow enough to dedupe
  const selectExpr = opts.timestamps
    .map((t) => `between(t\\,${(t - window).toFixed(3)}\\,${(t + window).toFixed(3)})`)
    .join('+');
  const scale = opts.maxDimension
    ? `,scale='if(gt(iw,ih),${opts.maxDimension},-2)':'if(gt(ih,iw),${opts.maxDimension},-2)'`
    : '';
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-i',
      opts.inputPath,
      '-vf',
      `select='${selectExpr}'${scale}`,
      '-vsync',
      'vfr',
      '-q:v',
      String(opts.jpegQuality ?? 3),
      join(opts.outputDir, 'frame_%06d.jpg'),
    ],
    { logCommand: true },
  );

  const files = (await readdir(opts.outputDir)).filter((f) => /^frame_\d+\.jpg$/.test(f)).sort();
  // ffmpeg writes one frame per matched timestamp in source order. The input
  // timestamps array is sorted by `pickVlmTimestamps` upstream, so pairing
  // by index is correct.
  return files.map((file, i) => ({
    timestamp: opts.timestamps[i] ?? 0,
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

/** macOS bold sans that ships on a default install; override via THUMBNAIL_FONT. */
const DEFAULT_THUMBNAIL_FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';

/**
 * Render a finished thumbnail from a generated image: scale/crop to the target
 * size (default 1280×720, YouTube's ratio) and — when a `headline` is given —
 * burn a centered, boxed headline near the bottom via the `drawtext` filter.
 *
 * The headline goes through a temp `textfile` (not `text=`) so arbitrary
 * punctuation needs no filtergraph escaping. drawtext requires a font file;
 * if the configured font is missing, drawtext fails — callers treat the
 * overlay as best-effort and fall back to the plain (no-headline) render.
 */
export async function renderThumbnail(opts: {
  inputPath: string;
  outputPath: string;
  width?: number;
  height?: number;
  headline?: string;
  fontPath?: string;
}): Promise<void> {
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const filters = [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`];

  let textfilePath: string | undefined;
  const headline = opts.headline?.trim();
  if (headline) {
    const font = opts.fontPath ?? process.env.THUMBNAIL_FONT ?? DEFAULT_THUMBNAIL_FONT;
    textfilePath = join(dirname(opts.outputPath), `.headline_${Date.now()}.txt`);
    await writeFile(textfilePath, headline, 'utf8');
    const fontSize = Math.round(h / 10); // ~72px at 720p
    filters.push(
      `drawtext=fontfile=${font}:textfile=${textfilePath}:fontcolor=white:fontsize=${fontSize}:` +
        `box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontSize / 3)}:` +
        `x=(w-text_w)/2:y=h-text_h-${Math.round(h / 12)}:line_spacing=8:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
    );
  }

  try {
    await runProc(
      'ffmpeg',
      ['-y', '-i', opts.inputPath, '-vf', filters.join(','), '-q:v', '2', opts.outputPath],
      { logCommand: true },
    );
  } finally {
    if (textfilePath) await rm(textfilePath, { force: true });
  }
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
  /** Plain VTT burn-in (no styling). Pass exactly one of subtitleVttPath / subtitleAssPath. */
  subtitleVttPath?: string;
  /**
   * ASS (Advanced SubStation Alpha) subtitle file with full styling +
   * inline animation tags. Use this when the operator has set a
   * `styling` block on the clip (font / animation / colour / position).
   * Emitted by `src/lib/ass-subtitles.ts`.
   */
  subtitleAssPath?: string;
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

  // Subtitle path — ASS takes precedence over VTT when both are set (so
  // callers can fall back gracefully). ffmpeg's `subtitles=` filter
  // accepts either; the file extension drives which parser libass uses.
  const subPath = opts.subtitleAssPath ?? opts.subtitleVttPath;
  const vf = subPath ? `${baseScale},subtitles=${escapeFilterPath(subPath)}` : baseScale;

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
