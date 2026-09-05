import { randomBytes } from "node:crypto";
import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { GitSnapshotContentFile } from "./gitChangeSnapshotEntries.js";
import type { ServerLogSink } from "./observability/server-log.js";

export interface GitSnapshotContent {
  readonly snapshot: GitChangeSnapshot;
  readonly files: readonly GitSnapshotContentFile[];
}

interface SnapshotRecord {
  readonly scope: object;
  readonly content: GitSnapshotContent;
  readonly bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

// B2-8 — the registry is shared by every consumer that captures a retained snapshot (chat
// git-change context and PR-description proposal review). A reservation keeps a specific,
// still-in-use reference out of the LRU eviction sweep below without partitioning the registry
// into separate stores per consumer (AGENTS.md §5 — extend the one shared cache, don't grow a
// second one). The cap is strictly below the 32-slot capacity so eviction always has at least one
// unreserved candidate to reclaim; a reservation request beyond the cap is refused (fail-closed)
// rather than silently starving unrelated captures of every slot.
const MAX_RESERVED = 24;

/** Process-local, bounded content handles. No store, filesystem, or browser serialization path. */
export class GitChangeSnapshotRegistry {
  private readonly records = new Map<string, SnapshotRecord>();
  private readonly expiredReferences = new Map<string, object>();
  private readonly reserved = new Set<string>();
  private bytes = 0;

  public constructor(
    private readonly log: ServerLogSink,
    private readonly now: () => number,
  ) {}

  public put(content: GitSnapshotContent, scope: object, correlationId: string): string {
    this.prune();
    const bytes = Buffer.byteLength(JSON.stringify(content));
    if (bytes > 64 * 1024 * 1024) throw new RangeError("Snapshot registry capacity exceeded");
    while (this.records.size >= 32 || this.bytes + bytes > 64 * 1024 * 1024) {
      const oldest = this.oldestEvictable();
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const reference = `gcs_${randomBytes(16).toString("hex")}`;
    const timer = setTimeout(
      () => {
        this.rememberExpired(reference, scope);
        this.remove(reference);
        this.log.write({
          category: "process",
          op: "git.snapshot.expired",
          correlationId,
          extra: { snapshotDigest: content.snapshot.snapshotDigest },
        });
      },
      Math.max(1, Date.parse(content.snapshot.expiresAt) - this.now()),
    );
    timer.unref();
    this.records.set(reference, { scope, content: structuredClone(content), bytes, timer });
    this.bytes += bytes;
    return reference;
  }

  public get(
    reference: string,
    scope: object,
    correlationId: string,
  ): GitSnapshotContent | undefined {
    this.prune();
    const entry = this.records.get(reference);
    const allowed = entry?.scope === scope;
    this.log.write({
      category: "security",
      op: "git.snapshot.read",
      correlationId,
      extra: { allowed },
    });
    return allowed ? structuredClone(entry.content) : undefined;
  }

  public close(): void {
    for (const reference of this.records.keys()) this.remove(reference);
    this.expiredReferences.clear();
  }

  public wasExpired(reference: string, scope: object): boolean {
    return this.expiredReferences.get(reference) === scope;
  }

  public revoke(reference: string, scope: object, correlationId: string): void {
    if (this.records.get(reference)?.scope !== scope) return;
    this.remove(reference);
    this.log.write({ category: "security", op: "git.snapshot.invalidated", correlationId });
  }

  /**
   * Pins a still-retained reference out of the LRU eviction sweep in `put` — e.g. a PR-description
   * proposal that must be able to recheck its own snapshot later regardless of unrelated capture
   * activity elsewhere (B2-8). Returns false (fail-closed) when the reference/scope does not match
   * an existing record or the reservation cap is already at `MAX_RESERVED`; the caller must treat a
   * `false` result as "not protected" rather than assuming the reservation succeeded.
   */
  public reserve(reference: string, scope: object, correlationId: string): boolean {
    this.prune();
    const record = this.records.get(reference);
    if (record?.scope !== scope) return false;
    if (!this.reserved.has(reference) && this.reserved.size >= MAX_RESERVED) {
      this.log.write({
        category: "process",
        op: "git.snapshot.reserve-denied",
        correlationId,
        extra: { reservedCount: this.reserved.size },
      });
      return false;
    }
    this.reserved.add(reference);
    this.log.write({ category: "process", op: "git.snapshot.reserved", correlationId, extra: {} });
    return true;
  }

  /** Releases a reservation made by `reserve`, e.g. once a proposal is applied or abandoned. */
  public release(reference: string, scope: object, correlationId: string): void {
    if (this.records.get(reference)?.scope !== scope) return;
    if (this.reserved.delete(reference)) {
      this.log.write({ category: "process", op: "git.snapshot.released", correlationId, extra: {} });
    }
  }

  private oldestEvictable(): string | undefined {
    for (const reference of this.records.keys()) {
      if (!this.reserved.has(reference)) return reference;
    }
    return undefined;
  }

  private rememberExpired(reference: string, scope: object): void {
    if (this.expiredReferences.size >= 32) {
      const oldest = this.expiredReferences.keys().next().value;
      if (oldest !== undefined) this.expiredReferences.delete(oldest);
    }
    this.expiredReferences.set(reference, scope);
  }

  private remove(reference: string): void {
    const record = this.records.get(reference);
    if (record === undefined) return;
    clearTimeout(record.timer);
    this.bytes -= record.bytes;
    this.records.delete(reference);
    this.reserved.delete(reference);
  }

  private prune(): void {
    for (const [reference, record] of this.records) {
      if (Date.parse(record.content.snapshot.expiresAt) <= this.now()) {
        this.rememberExpired(reference, record.scope);
        this.remove(reference);
      }
    }
  }
}
