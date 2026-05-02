// Single-writer queue for better-sqlite3.
//
// Why: better-sqlite3 is synchronous; a single Database connection can serve
// arbitrarily many sync calls per JS turn. The reason to wrap writes in a queue
// at all is *fairness across async producers* (one route handler shouldn't
// monopolise the writer while another is awaiting on something else) and
// *future-proofing* — if the embedded driver ever moves async (e.g. node:sqlite
// in Node 24+), the queue absorbs the change without touching call sites.
//
// The queue also keeps an audit hook (onCommitted) so tests can observe when
// writes drained, separate from the transaction log itself.

export type WriteJob<T = unknown> = () => T;

export class SqliteWriteQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(private readonly onCommitted?: (table?: string) => void) {}

  /** Enqueue a synchronous write; await the result. */
  run<T>(fn: WriteJob<T>, table?: string): Promise<T> {
    const next = this.chain.then(() => {
      this.inFlight++;
      try {
        const v = fn();
        return v;
      } finally {
        this.inFlight--;
        this.onCommitted?.(table);
      }
    });
    // Swallow rejections on the chain itself so a single failure doesn't poison
    // subsequent enqueued writes.
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  pendingCount(): number {
    return this.inFlight;
  }
}
