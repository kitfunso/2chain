export type WriteJob<T = unknown> = () => T;

export class SqliteWriteQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(private readonly onCommitted?: (table?: string) => void) {}

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
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  pendingCount(): number {
    return this.inFlight;
  }
}
