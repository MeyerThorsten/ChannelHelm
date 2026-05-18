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
