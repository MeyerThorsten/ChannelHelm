import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProc } from './_proc';

/**
 * yt-dlp wrapper. Spawns the system `yt-dlp` binary. Writes to
 * `${outputDir}/${baseName}.${ext}` and `${outputDir}/${baseName}.info.json`.
 *
 * v1 deliberately does not select formats by codec — we want yt-dlp's default
 * "best mp4 or fall back to best" merge, which is robust against YouTube's
 * routine format-id churn.
 */
export type YtDlpResult = {
  filePath: string;
  durationSeconds: number;
  title: string;
  ext: string;
  infoJsonPath: string;
};

export async function downloadVideo(opts: {
  url: string;
  outputDir: string;
  baseName?: string;
}): Promise<YtDlpResult> {
  const baseName = opts.baseName ?? 'original';
  await mkdir(opts.outputDir, { recursive: true });
  const outputTemplate = join(opts.outputDir, `${baseName}.%(ext)s`);

  await runProc(
    'yt-dlp',
    [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '-f',
      'best[ext=mp4]/best',
      '--write-info-json',
      '-o',
      outputTemplate,
      opts.url,
    ],
    { logCommand: true },
  );

  const infoJsonPath = join(opts.outputDir, `${baseName}.info.json`);
  const info = JSON.parse(await readFile(infoJsonPath, 'utf8')) as {
    ext?: string;
    duration?: number;
    title?: string;
    _filename?: string;
  };
  const ext = info.ext ?? 'mp4';
  const filePath = join(opts.outputDir, `${baseName}.${ext}`);
  return {
    filePath,
    durationSeconds: Math.round(info.duration ?? 0),
    title: info.title ?? '',
    ext,
    infoJsonPath,
  };
}

export async function ytDlpVersion(): Promise<string> {
  const { stdout } = await runProc('yt-dlp', ['--version']);
  return stdout.trim();
}
