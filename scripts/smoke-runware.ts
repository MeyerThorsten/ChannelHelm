/**
 * Runware end-to-end smoke: exercises the real image-generation path without
 * the worker or a package — generate → download → ffmpeg thumbnail (plain +
 * headline overlay). Proves the API call, the CDN download, and the drawtext
 * overlay all work on this machine.
 *
 * Run (key stays in YOUR shell — never in chat or the repo):
 *   RUNWARE_API_KEY=… pnpm smoke:runware
 *
 * Or, if you've added a Runware provider at /providers (category=image), point
 * at the live DB so it resolves from there instead:
 *   DATABASE_URL=postgresql://thorstenmeyer@localhost:5432/channelhelm pnpm smoke:runware
 *
 * Output JPGs land in ./tmp/runware-smoke/ (gitignored).
 */
import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { renderThumbnail } from '../workers/integrations/ffmpeg';
import { downloadImage, getImageProvider } from '../workers/integrations/image/get_image_provider';
import { RunwareImageProvider } from '../workers/integrations/image/runware';
import type { ImageProvider } from '../workers/integrations/image/types';

const OUT = join(process.cwd(), 'tmp', 'runware-smoke');
const PROMPT =
  'A dramatic dark studio desk with a glowing high-end PC, cinematic teal-and-orange ' +
  'rim lighting, single bold focal point, generous empty space in the upper area, ' +
  'no text, no words, no watermark, high detail, 16:9';
const HEADLINE = 'IT MELTED';

async function resolveProvider(): Promise<ImageProvider | null> {
  // Prefer a /providers-configured image provider (reads DATABASE_URL); fall
  // back to RUNWARE_API_KEY from the env so a key never has to be persisted.
  const fromDb = await getImageProvider('all').catch((e) => {
    console.warn(`[smoke] DB image-provider lookup skipped: ${(e as Error).message}`);
    return null;
  });
  if (fromDb) return fromDb;
  if (process.env.RUNWARE_API_KEY) {
    return new RunwareImageProvider({
      name: 'Runware (env)',
      type: 'runware',
      baseUrl: process.env.RUNWARE_BASE_URL ?? 'https://api.runware.ai/v1',
      apiKey: process.env.RUNWARE_API_KEY,
      model: process.env.RUNWARE_MODEL ?? 'runware:z-image@turbo',
    });
  }
  return null;
}

async function main(): Promise<void> {
  const provider = await resolveProvider();
  if (!provider) {
    console.error(
      '[smoke] no image provider — set RUNWARE_API_KEY in your shell, or add a Runware\n' +
        '        provider at /providers (category=image) and point DATABASE_URL at the live DB.',
    );
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });
  console.log(`[smoke] provider=${provider.getName()} type=${provider.getType()} model=${provider.getModel()}`);

  const t0 = Date.now();
  const [img] = await provider.generateImages({ prompt: PROMPT, width: 1280, height: 720, numberResults: 1 });
  if (!img) throw new Error('provider returned no image');
  console.log(
    `[smoke] generated in ${((Date.now() - t0) / 1000).toFixed(1)}s · cost $${img.cost ?? '?'} · ${img.imageUrl}`,
  );

  const src = join(OUT, 'src.jpg');
  await downloadImage(img.imageUrl, src);
  console.log(`[smoke] downloaded → ${src}`);

  const plain = join(OUT, 'thumb_plain.jpg');
  await renderThumbnail({ inputPath: src, outputPath: plain });
  console.log(`[smoke] ✓ plain  → ${plain}`);

  const headline = join(OUT, 'thumb_headline.jpg');
  try {
    await renderThumbnail({ inputPath: src, outputPath: headline, headline: HEADLINE });
    console.log(`[smoke] ✓ headline → ${headline}`);
  } catch (e) {
    console.warn(
      `[smoke] ⚠ headline overlay failed (drawtext font?): ${(e as Error).message}\n` +
        '        plain variant is fine; set THUMBNAIL_FONT to a valid .ttf if needed.',
    );
  }
  console.log('[smoke] done — open the JPGs in tmp/runware-smoke/ to eyeball the result.');
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
