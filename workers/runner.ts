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
import { loadSettingsIntoEnv, subscribeSettingsChanges } from '@/lib/settings';
import { run as runAnalyzeIntelligence } from './kinds/analyze_intelligence';
import { run as runAnalyzeVisual } from './kinds/analyze_visual';
import { run as runArchivePackage } from './kinds/archive_package';
import { run as runClipRender } from './kinds/clip_render';
import { run as runCollectSignal } from './kinds/collect_signal';
import { run as runDispatch } from './kinds/dispatch';
import { run as runExperimentTick } from './kinds/experiment_tick';
import { run as runFuse } from './kinds/fuse';
import { run as runGenerateAsset } from './kinds/generate_asset';
import { run as runIngest } from './kinds/ingest';
import { run as runNoop } from './kinds/noop';
import { run as runPromoteVoiceExamples } from './kinds/promote_voice_examples';
import { run as runThumbnailConcepts } from './kinds/thumbnail_concepts';
import { run as runTranscribeAudio } from './kinds/transcribe_audio';
import {
  type JobRow,
  RequeueLater,
  claim,
  complete,
  fail,
  reclaimStaleJobs,
  requeueAt,
  shutdown,
} from './queue';

type Handler = (job: JobRow) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  noop: runNoop,
  ingest: runIngest,
  transcribe_audio: runTranscribeAudio,
  analyze_visual: runAnalyzeVisual,
  fuse: runFuse,
  analyze_intelligence: runAnalyzeIntelligence,
  generate_asset: runGenerateAsset,
  clip_render: runClipRender,
  thumbnail_concepts: runThumbnailConcepts,
  dispatch: runDispatch,
  collect_signal: runCollectSignal,
  promote_voice_examples: runPromoteVoiceExamples,
  archive_package: runArchivePackage,
  experiment_tick: runExperimentTick,
};

function parseArgs(argv: string[]): {
  kinds: string[];
  once: boolean;
  idleMs: number;
  maxIter: number;
  concurrency: number;
} {
  let kinds: string[] = [];
  let once = false;
  let idleMs = 1000;
  let maxIter = Number.POSITIVE_INFINITY;
  // §13/perf: how many concurrent job slots this worker process holds. Each
  // slot is an independent claim→run→ack loop. SKIP LOCKED on the queue
  // ensures no two slots ever take the same job. LLM-bound kinds
  // (generate_asset, analyze_intelligence) benefit the most; CPU-bound kinds
  // (analyze_visual VLM) just see modest gains from overlapping I/O.
  let concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 3;

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
    } else if (flag === '--concurrency') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 1) concurrency = n;
    }
  }
  return { kinds, once, idleMs, maxIter, concurrency };
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
  const { kinds, once, idleMs, maxIter, concurrency } = parseArgs(process.argv.slice(2));
  if (kinds.length === 0) {
    console.error('runner: --kinds <csv> is required');
    process.exit(2);
  }
  const unknown = kinds.filter((k) => !HANDLERS[k]);
  if (unknown.length > 0) {
    console.error(`runner: no handler registered for kinds: ${unknown.join(', ')}`);
    process.exit(2);
  }

  // Hydrate runtime settings into process.env (DB > .env), then subscribe to
  // pg_notify('chs_settings') so changes made on /settings propagate live.
  try {
    await loadSettingsIntoEnv();
    await subscribeSettingsChanges();
  } catch (err) {
    // Don't crash the worker on a fresh checkout — the settings table may not
    // exist yet before `pnpm db:migrate`. Workers fall back to bare .env.
    console.warn('[runner] settings hydration deferred:', (err as Error).message);
  }

  const lockedBy = `${hostname()}:${process.pid}`;
  console.log(
    `[runner] started lockedBy=${lockedBy} kinds=${kinds.join(',')} once=${once} idleMs=${idleMs} concurrency=${concurrency}`,
  );

  installSignalHandlers();

  // Stale-lock reclaim runs centrally on a 30 s timer rather than inside each
  // slot — one query per cycle regardless of `concurrency`. Doesn't conflict
  // with running slots because reclaim only targets `running` rows whose
  // `locked_at` exceeds the per-kind timeout (i.e. genuinely abandoned).
  const reclaimTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const reclaimed = await reclaimStaleJobs(kinds);
      if (reclaimed.length > 0) {
        console.warn(
          `[runner] reclaimed ${reclaimed.length} stale job(s): ${reclaimed
            .map((r) => `${r.id}/${r.kind}`)
            .join(', ')}`,
        );
      }
    } catch (err) {
      console.error('[runner] reclaim failed:', err);
    }
  }, 30_000);

  // Spawn N concurrent claim slots. Each is an independent claim→run→ack
  // loop. The queue's `SELECT … FOR UPDATE SKIP LOCKED` (queue.ts) guarantees
  // no two slots ever pick the same job, so we don't need any in-process
  // locking. `--once` collapses to a single slot for deterministic test runs.
  const effectiveConcurrency = once ? 1 : concurrency;
  const iterPerSlot = Math.ceil(maxIter / effectiveConcurrency);
  await Promise.all(
    Array.from({ length: effectiveConcurrency }, (_, slot) =>
      runSlot({ slot, lockedBy, kinds, once, idleMs, maxIter: iterPerSlot }),
    ),
  );

  clearInterval(reclaimTimer);
  await shutdown();
}

/**
 * One claim slot: loops claim → handler → ack until shutdown or maxIter.
 * `slot` is purely for logging context so it's easy to read interleaved
 * output. The DB queue is the source of truth — no in-process state.
 */
async function runSlot(opts: {
  slot: number;
  lockedBy: string;
  kinds: string[];
  once: boolean;
  idleMs: number;
  maxIter: number;
}): Promise<void> {
  const { slot, lockedBy, kinds, once, idleMs, maxIter } = opts;
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
      console.log(`[runner${slot > 0 ? `:${slot}` : ''}] done job=${job.id} kind=${job.kind}`);
    } catch (err) {
      if (err instanceof RequeueLater) {
        await requeueAt(job.id, err.runAfter);
        console.log(
          `[runner${slot > 0 ? `:${slot}` : ''}] requeued job=${job.id} kind=${job.kind} until ${err.runAfter.toISOString()} (${err.message})`,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[runner${slot > 0 ? `:${slot}` : ''}] fail job=${job.id} kind=${job.kind}: ${msg}`);
        await fail(job.id, msg);
      }
    }
    if (once) break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[runner] fatal:', err);
  process.exit(1);
});
