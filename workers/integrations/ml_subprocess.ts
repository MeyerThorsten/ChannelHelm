import { join } from 'node:path';
import { runProc } from './_proc';

const ML_DIR = join(process.cwd(), 'ml');

/**
 * The JSON envelope every ml/ CLI emits on its last stdout line per §5.6.
 * Concrete scripts add their own fields (model, language, segment_count, …).
 */
export type MlEnvelope = {
  ok: boolean;
  error?: string;
  output_path?: string;
  duration_ms?: number;
  host?: string;
  provider?: string;
  model?: string;
  [k: string]: unknown;
};

/**
 * Spawn `uv run python <script> <flags>` with cwd=ml/ so the script's
 * `from _lib import …` resolves and uv finds the right pyproject.toml.
 *
 * `args` keys may be either `--input` (dashed) or `input` (bare); the bare
 * form is auto-prefixed.
 */
export async function runMlScript(opts: {
  script: string; // e.g. 'transcribe.py', 'diarize.py'
  args: Record<string, string | number | undefined | null>;
  /** Override the cwd (default: <repo>/ml). */
  mlDir?: string;
}): Promise<MlEnvelope> {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(opts.args)) {
    if (value === undefined || value === null) continue;
    const flag = key.startsWith('--') ? key : `--${key}`;
    argv.push(flag, String(value));
  }
  const cwd = opts.mlDir ?? ML_DIR;
  const result = await runProc('uv', ['run', 'python', opts.script, ...argv], {
    cwd,
    logCommand: true,
  });

  // The last non-empty stdout line is the JSON envelope. Anything before it
  // came from the ML library itself (mlx_whisper sometimes prints progress).
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last) {
    throw new Error(`${opts.script}: produced no stdout envelope`);
  }
  let envelope: MlEnvelope;
  try {
    envelope = JSON.parse(last) as MlEnvelope;
  } catch {
    throw new Error(`${opts.script}: last stdout line was not JSON: ${last.slice(0, 200)}`);
  }
  if (!envelope.ok) {
    throw new Error(`${opts.script} reported failure: ${envelope.error ?? 'unknown error'}`);
  }
  return envelope;
}
