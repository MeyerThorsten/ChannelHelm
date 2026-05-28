import { Semaphore, providerSemaphore } from '@workers/integrations/llm/semaphore';
import { describe, expect, it } from 'vitest';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('Semaphore', () => {
  it('caps in-flight requests at max and queues the rest', async () => {
    const sem = new Semaphore(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let maxObserved = 0;
    const runs = gates.map((g) =>
      sem.run(async () => {
        maxObserved = Math.max(maxObserved, sem.inFlight);
        await g.promise;
      }),
    );

    await flush();
    expect(sem.inFlight).toBe(2); // two running
    expect(sem.queued).toBe(1); // one waiting

    gates[0]?.resolve();
    await flush();
    expect(sem.inFlight).toBe(2); // third promoted as first finished
    expect(sem.queued).toBe(0);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(runs);

    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(sem.inFlight).toBe(0);
  });

  it('releases the slot even when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sem.inFlight).toBe(0);

    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('providerSemaphore is per-key and the first max wins', () => {
    const a = providerSemaphore('openrouter@url', 3);
    const b = providerSemaphore('openrouter@url', 9);
    expect(a).toBe(b);
    expect(a.max).toBe(3);
    expect(providerSemaphore('other@url', 1)).not.toBe(a);
  });
});
