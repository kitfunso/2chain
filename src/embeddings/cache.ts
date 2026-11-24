export interface CachedEntry {
  vec: Float32Array;
  ms: number;
  insertedAt: number;
}

export class LruEmbeddingCache {
  private readonly map = new Map<string, CachedEntry>();

  constructor(private readonly capacity: number = 256) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
  }

  get(key: string): CachedEntry | undefined {
    const v = this.map.get(key);
    if (!v) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, entry: CachedEntry): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (!oldest) break;
      this.map.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
