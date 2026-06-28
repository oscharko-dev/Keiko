/**
 * Bounded LRU for the editor host's per-window session cache (Wave 2, item 2.8).
 *
 * The host keeps a full per-file snapshot (buffer text, version, cursor, save status, …) for every
 * file opened in the window so tab switches are instant and background-tab saves stay correct. That
 * map only shrank on explicit tab close, so a long session that opened many files grew it without
 * bound. This wrapper caps it and evicts the least-recently-used entry on overflow — but NEVER an
 * entry the caller marks protected (mid-save, dirty/unsaved, or the currently-active file), so the
 * save-correctness guarantees are preserved. It is API-compatible with the `Map` it replaces
 * (`get`/`set`/`delete`/`size`), so the call sites are unchanged.
 *
 * LRU is tracked via the Map's own insertion order: `get`/`set` re-insert the key so the most
 * recently touched entry moves to the end and the oldest sits first. Eviction is best-effort — if
 * every overflow candidate is protected the cap is briefly exceeded (correctness over the bound).
 */
export class LruSessionCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(
    private readonly capacity: number,
    /** Returns true for an entry that must never be evicted (active / saving / dirty). */
    private readonly isProtected: (key: string, value: V) => boolean,
  ) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Touch: move to the most-recently-used end.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evict();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    if (this.entries.size <= this.capacity) return;
    for (const [key, value] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (this.isProtected(key, value)) continue;
      this.entries.delete(key);
    }
  }
}
