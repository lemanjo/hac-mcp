export interface TtlCacheOptions {
  defaultTtlMs: number;
  now?: () => number;
}

interface CacheEntry<V> {
  expiresAt: number;
  value: V;
}

interface InFlightLoad<V> {
  promise: Promise<V>;
}

/** A small, timer-free TTL cache that also coalesces concurrent loads. */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly inFlight = new Map<K, InFlightLoad<V>>();
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private generation = 0;

  constructor(options: TtlCacheOptions | number) {
    const normalized = typeof options === "number" ? { defaultTtlMs: options } : options;
    this.assertTtl(normalized.defaultTtlMs);
    this.defaultTtlMs = normalized.defaultTtlMs;
    this.now = normalized.now ?? Date.now;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): V {
    this.assertTtl(ttlMs);
    this.generation += 1;
    this.inFlight.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return value;
  }

  async getOrLoad(key: K, loader: () => Promise<V>, ttlMs = this.defaultTtlMs): Promise<V> {
    this.assertTtl(ttlMs);
    if (this.has(key)) return this.entries.get(key)!.value;

    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing.promise;

    const generation = this.generation;
    const load = {} as InFlightLoad<V>;
    load.promise = (async () => {
      try {
        const value = await loader();
        if (this.generation === generation && this.inFlight.get(key) === load) {
          this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
        }
        return value;
      } finally {
        if (this.inFlight.get(key) === load) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, load);
    return load.promise;
  }

  delete(key: K): boolean {
    this.generation += 1;
    this.inFlight.delete(key);
    return this.entries.delete(key);
  }

  invalidate(predicate?: (key: K, value: V) => boolean): number {
    this.generation += 1;
    if (predicate === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      this.inFlight.clear();
      return removed;
    }

    // In-flight values have no value to test yet. Detach them so calls made after
    // invalidation load fresh data; the original callers still receive their result.
    this.inFlight.clear();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now() || predicate(key, entry.value)) {
        this.entries.delete(key);
        this.inFlight.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.invalidate();
  }

  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Cache TTL must be a positive finite number");
    }
  }
}
