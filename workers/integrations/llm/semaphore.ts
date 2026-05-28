/**
 * Per-provider concurrency limiter (v1.5). This is an OUTBOUND-request rate
 * guard, NOT a job mutex — the queue's SELECT FOR UPDATE SKIP LOCKED remains
 * the only mutex for claiming work. When a provider row sets `max_concurrent`,
 * the resolver wraps its `chat()` so no more than that many requests are
 * in-flight to that upstream at once, across the worker's N concurrency slots
 * within this process. (Cross-process global limiting would need a distributed
 * semaphore; in-process matches the "N slots shouldn't hammer one provider"
 * intent and is sufficient for the single-master fleet.)
 */
export class Semaphore {
  readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  /** Run `fn` once a slot is free; always releases, even on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Visible for tests. */
  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const registry = new Map<string, Semaphore>();

/**
 * Get (or create) the process-wide semaphore for a provider key. The first max
 * seen for a key wins for the process lifetime — changing `max_concurrent` in
 * /providers takes effect on the next worker restart (same as other settings).
 */
export function providerSemaphore(key: string, max: number): Semaphore {
  const existing = registry.get(key);
  if (existing) return existing;
  const s = new Semaphore(max);
  registry.set(key, s);
  return s;
}
