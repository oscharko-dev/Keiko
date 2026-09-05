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

/** Process-local, bounded content handles. No store, filesystem, or browser serialization path. */
export class GitChangeSnapshotRegistry {
  private readonly records = new Map<string, SnapshotRecord>();
  private readonly expiredReferences = new Map<string, object>();
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
      const oldest = this.records.keys().next().value;
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
