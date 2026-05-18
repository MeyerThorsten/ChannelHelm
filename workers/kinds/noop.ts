import type { JobRow } from '../queue';

/**
 * The 'noop' job kind exists so the runner has something to claim and complete
 * before the real pipeline workers (ingest, transcribe_audio, …) come online.
 *
 * Behaviour:
 *   - if payload.sleepMs is a non-negative number, sleep that long
 *   - if payload.fail === true, throw (the runner records it via queue.fail)
 *   - otherwise just log and return
 */
export async function run(job: JobRow): Promise<void> {
  const payload = job.payload ?? {};
  const sleepMs = typeof payload.sleepMs === 'number' ? payload.sleepMs : 0;
  const shouldFail = payload.fail === true;

  if (sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  if (shouldFail) {
    throw new Error(typeof payload.error === 'string' ? payload.error : 'noop: forced failure');
  }
  console.log(`[noop] job=${job.id} attempts=${job.attempts} payload=${JSON.stringify(payload)}`);
}
