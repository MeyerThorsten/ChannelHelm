import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { channelUrlFrom, looksLikeChannelId } from '@/lib/url';
import { runProc } from './_proc';

// Allow an explicit binary path so the Next.js server process (which may have
// a slimmer PATH than an interactive shell) can still find yt-dlp.
const YT_DLP = process.env.YT_DLP_BIN ?? 'yt-dlp';

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
    YT_DLP,
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
  const { stdout } = await runProc(YT_DLP, ['--version']);
  return stdout.trim();
}

/**
 * Resolve a YouTube channel handle/URL/id to its canonical UC… channel id.
 * Returns the UC… id, or null if it can't be resolved. Already-canonical
 * ids pass straight through without a network call.
 */
export async function resolveChannelId(handleOrUrl: string): Promise<string | null> {
  if (looksLikeChannelId(handleOrUrl)) return handleOrUrl.trim();
  const channelUrl = channelUrlFrom(handleOrUrl);
  if (!channelUrl) return null;
  try {
    const { stdout } = await runProc(
      YT_DLP,
      [
        '--dump-single-json',
        '--skip-download',
        '--playlist-items',
        '1',
        '--no-warnings',
        channelUrl,
      ],
      { logCommand: true },
    );
    const info = JSON.parse(stdout) as { channel_id?: string; id?: string };
    return info.channel_id ?? (looksLikeChannelId(info.id) ? (info.id ?? null) : null);
  } catch (err) {
    console.warn('[ytdlp] resolveChannelId failed:', err);
    return null;
  }
}

export type YtDlpChannelMeta = {
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
  handle: string | null; // @handle from uploader_id
  title: string | null; // the video title
};

/**
 * Fetch a video's metadata WITHOUT downloading (fast, ~2-4s). Used at
 * link-submit time to discover which channel — and therefore which brand —
 * a YouTube URL belongs to.
 */
export async function fetchMetadata(url: string): Promise<YtDlpChannelMeta> {
  const { stdout } = await runProc(
    YT_DLP,
    ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', url],
    { logCommand: true },
  );
  const info = JSON.parse(stdout) as {
    channel?: string;
    channel_id?: string;
    channel_url?: string;
    uploader_id?: string;
    uploader_url?: string;
    title?: string;
  };
  const handle = info.uploader_id?.startsWith('@')
    ? info.uploader_id
    : info.uploader_url?.includes('/@')
      ? `@${info.uploader_url.split('/@')[1]?.split('/')[0]}`
      : null;
  return {
    channelId: info.channel_id ?? null,
    channelName: info.channel ?? null,
    channelUrl: info.channel_url ?? null,
    handle,
    title: info.title ?? null,
  };
}
