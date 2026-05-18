/**
 * Worker runner. Claims jobs whose kind is in `--kinds` and dispatches to the
 * handler module under `workers/kinds/`. Started by `launchd` in production,
 * by `tsx workers/runner.ts --kinds X,Y` in dev.
 *
 * Flags:
 *   --kinds <csv>     comma-separated list of job kinds to claim
 *   --once            run a single iteration: claim at most one job, ack, exit
 *   --idle-ms <int>   ms to sleep when no work is available (default 1000)
 *   --max-iter <int>  cap iterations even without --once (default unlimited)
 */
import { hostname } from 'node:os';
import { run as runIngest } from './kinds/ingest';
import { run as runNoop } from './kinds/noop';
import { run as runTranscribeAudio } from './kinds/transcribe_audio';
import { type JobRow, claim, complete, fail, shutdown } from './queue';

type Handler = (job: JobRow) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  noop: runNoop,
  ingest: runIngest,
  transcribe_audio: runTranscribeAudio,
};

function parseArgs(argv: string[]): {
  kinds: string[];
  once: boolean;
  idleMs: number;
  maxIter: number;
} {
  let kinds: string[] = [];
  let once = false;
  let idleMs = 1000;
  let maxIter = Number.POSITIVE_INFINITY;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--kinds') {
      kinds = (argv[++i] ?? '').split(',').filter(Boolean);
    } else if (flag === '--once') {
      once = true;
    } else if (flag === '--idle-ms') {
      idleMs = Number.parseInt(argv[++i] ?? '', 10);
    } else if (flag === '--max-iter') {
      maxIter = Number.parseInt(argv[++i] ?? '', 10);
    }
  }
  return { kinds, once, idleMs, maxIter };
}

let shuttingDown = false;
function installSignalHandlers(): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      console.log(`\n[runner] ${sig} received, finishing current job and exiting`);
      shuttingDown = true;
    });
  }
}

async function main(): Promise<void> {
  const { kinds, once, idleMs, maxIter } = parseArgs(process.argv.slice(2));
  if (kinds.length === 0) {
    console.error('runner: --kinds <csv> is required');
    process.exit(2);
  }
  const unknown = kinds.filter((k) => !HANDLERS[k]);
  if (unknown.length > 0) {
    console.error(`runner: no handler registered for kinds: ${unknown.join(', ')}`);
    process.exit(2);
  }

  const lockedBy = `${hostname()}:${process.pid}`;
  console.log(
    `[runner] started lockedBy=${lockedBy} kinds=${kinds.join(',')} once=${once} idleMs=${idleMs}`,
  );

  installSignalHandlers();

  let iter = 0;
  while (!shuttingDown && iter < maxIter) {
    iter++;
    const job = await claim(kinds, lockedBy);
    if (!job) {
      if (once) break;
      await sleep(idleMs);
      continue;
    }
    const handler = HANDLERS[job.kind];
    if (!handler) {
      // Defensive: claim filtered by kinds=[…], so this can't happen unless
      // a kind disappears between args parsing and the claim.
      await fail(job.id, `no handler for kind=${job.kind}`);
      continue;
    }
    try {
      await handler(job);
      await complete(job.id);
      console.log(`[runner] done job=${job.id} kind=${job.kind}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runner] fail job=${job.id} kind=${job.kind}: ${msg}`);
      await fail(job.id, msg);
    }
    if (once) break;
  }

  await shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[runner] fatal:', err);
  process.exit(1);
});
