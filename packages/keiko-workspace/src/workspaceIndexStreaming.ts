import { createHash } from "node:crypto";
import { CODE_REDACTION_REVISION } from "@oscharko-dev/keiko-security/redaction";
import { workspaceContentPolicy, workspaceContentSecrets } from "./discovery.js";
import type { FileMatches, SearchTextRunner } from "./repoSearchScan.js";
import {
  raceStructuralExecution,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES,
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
  isWorkspaceIndexRecordCurrent,
  WORKSPACE_INDEX_SHARD_COUNT,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoveredFile,
  type WorkspaceIndexPreparationReport,
  type WorkspaceIndexRecord,
  type WorkspaceIndexScopeKey,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";
import {
  decodeWorkspaceIndexContent,
  encodeWorkspaceIndexContent,
  workspaceIndexContentPolicyFingerprint,
} from "./workspaceIndexContent.js";
import {
  normalizeWorkspaceIndexQueryMatch,
  type WorkspaceIndexQueryMatch,
} from "./workspaceIndexQueryMatch.js";

// Lazy query shards share the existing store's per-shard bounds; request memory has a smaller cap.
const MATCH_LIMITS: ShardFamilyLimits = {
  recordBytes: 8 * 1024,
  shardBytes: DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES / 4,
  requestBytes: 64 * 1024 * 1024,
};
// #4457: sealing encodes a snapshot as base64url (4/3), so a content shard keeps its plaintext
// under two thirds of the existing per-snapshot byte bound. One record may use a quarter of it.
const CONTENT_SHARD_BYTES = Math.floor((DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES * 2) / 3);
const CONTENT_LIMITS: ShardFamilyLimits = {
  recordBytes: Math.floor(CONTENT_SHARD_BYTES / 4),
  shardBytes: CONTENT_SHARD_BYTES,
  requestBytes: 96 * 1024 * 1024,
};
// Each retained record also appears in discovery.files; the existing cap counts both rows.
const MAX_SHARD_RECORDS = Math.floor(DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES / 2);

interface ShardFamilyLimits {
  readonly recordBytes: number;
  readonly shardBytes: number;
  readonly requestBytes: number;
}

interface IndexShard {
  readonly key: WorkspaceIndexScopeKey;
  readonly records: Map<string, WorkspaceIndexRecord>;
  readonly seen: Set<string>;
  bytes: number;
  dirty: boolean;
}

interface ShardFamilyHost {
  readonly active: () => boolean;
  readonly usable: () => boolean;
  readonly load: (key: WorkspaceIndexScopeKey) => Promise<WorkspaceIndexSnapshot | undefined>;
  readonly save: (key: WorkspaceIndexScopeKey, records: WorkspaceIndexRecord[]) => Promise<void>;
  readonly dropRecord: () => false;
}

/** What one stored record proves for the current question without reading the file again. */
export type StreamingWorkspaceIndexHit =
  | { readonly kind: "match"; readonly match: WorkspaceIndexQueryMatch }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" };

/** What one redacting read observed, offered to the query-independent content layer. */
export type StreamingWorkspaceIndexObservation =
  { readonly kind: "text"; readonly text: string } | { readonly kind: "binary" };

export interface StreamingWorkspaceIndexSession {
  readonly lookup: (
    metadata: WorkspaceIndexDiscoveredFile,
  ) => Promise<StreamingWorkspaceIndexHit | undefined>;
  readonly observeReuse: (
    metadata: WorkspaceIndexDiscoveredFile,
    kind: StreamingWorkspaceIndexHit["kind"],
  ) => Promise<void>;
  readonly observeRead: (
    metadata: WorkspaceIndexDiscoveredFile,
    observed: StreamingWorkspaceIndexObservation,
  ) => Promise<void>;
  readonly observeMatch: (
    path: string,
    matches: FileMatches | undefined,
    complete: boolean,
  ) => Promise<void>;
  readonly finalize: () => Promise<void>;
  readonly report: () => WorkspaceIndexPreparationReport;
}

function shardFor(path: string): number {
  return (createHash("sha256").update(path).digest().at(0) ?? 0) % WORKSPACE_INDEX_SHARD_COUNT;
}

function recordBytes(record: WorkspaceIndexRecord): number {
  if (record.content === undefined) return Buffer.byteLength(JSON.stringify(record), "utf8");
  // The base64 payload is ASCII; measuring the remainder avoids copying the payload once more.
  const rest = { ...record, content: { ...record.content, deflated: "" } };
  return Buffer.byteLength(JSON.stringify(rest), "utf8") + record.content.deflated.length;
}

class ShardFamily {
  private readonly shards = new Map<number, Promise<IndexShard>>();
  private bytes = 0;

  public constructor(
    private readonly host: ShardFamilyHost,
    private readonly limits: ShardFamilyLimits,
    private readonly keyFor: (shard: number) => WorkspaceIndexScopeKey,
    private readonly loadable: (record: WorkspaceIndexRecord) => boolean,
  ) {}

  public async shard(path: string): Promise<IndexShard> {
    const number = shardFor(path);
    let pending = this.shards.get(number);
    if (pending === undefined) {
      pending = this.load(number);
      this.shards.set(number, pending);
    }
    return pending;
  }

  private async load(number: number): Promise<IndexShard> {
    const key = this.keyFor(number);
    const result: IndexShard = { key, records: new Map(), seen: new Set(), bytes: 0, dirty: false };
    if (!this.host.active()) return result;
    const snapshot = await this.host.load(key);
    if (!this.host.usable() || snapshot === undefined) return result;
    for (const record of snapshot.records) {
      if (!this.host.active()) break;
      if (this.loadable(record)) this.retain(result, record);
    }
    return result;
  }

  public retain(shard: IndexShard, record: WorkspaceIndexRecord): boolean {
    const size = recordBytes(record);
    const previous = shard.records.get(record.scopePath);
    const oldSize = previous === undefined ? 0 : recordBytes(previous);
    if (size > this.limits.recordBytes || this.bytes - oldSize + size > this.limits.requestBytes)
      return this.host.dropRecord();
    if (shard.bytes - oldSize + size > this.limits.shardBytes) return this.host.dropRecord();
    if (
      previous === undefined &&
      shard.records.size >= MAX_SHARD_RECORDS - shard.key.relativePaths.length
    )
      return this.host.dropRecord();
    shard.records.set(record.scopePath, record);
    shard.bytes += size - oldSize;
    this.bytes += size - oldSize;
    return true;
  }

  /** Returns whether the path was not seen before in this request. */
  public markSeen(shard: IndexShard, path: string): boolean {
    if (shard.seen.has(path)) return false;
    shard.seen.add(path);
    return true;
  }

  public async finalize(): Promise<void> {
    const shards = await Promise.all(this.shards.values());
    // Unseen advisory records may release capacity even when every new record was refused.
    // Eviction never asserts file deletion or changes fresh traversal's coverage authority.
    const changed = shards.filter((shard) => shard.dirty || shard.seen.size !== shard.records.size);
    // Shards are saved one after another so only one serialized snapshot is held at a time; the
    // first failure ends the chain, and a stopped or unusable request publishes nothing further.
    await changed.reduce<Promise<void>>(
      (previous, shard) => previous.then(() => this.saveShard(shard)),
      Promise.resolve(),
    );
  }

  private async saveShard(shard: IndexShard): Promise<void> {
    if (!this.host.usable()) return;
    const records = [...shard.records.values()].filter((record) =>
      shard.seen.has(record.scopePath),
    );
    await this.host.save(shard.key, records);
  }
}

interface PendingRead {
  readonly metadata: WorkspaceIndexDiscoveredFile;
  readonly reused: boolean;
}

export class StreamingWorkspaceIndex implements StreamingWorkspaceIndexSession {
  private readonly pendingReads = new Map<string, PendingRead>();
  private readonly matches: ShardFamily;
  private readonly contents: ShardFamily;
  private reusedRecords = 0;
  private staleRecords = 0;
  private indexedRecords = 0;
  private discoveredEntries = 0;
  private retainedEntries = 0;
  private skippedEntries = 0;
  private droppedRecords = 0;
  private available = true;

  public constructor(
    private readonly index: WorkspaceIndex,
    private readonly runner: SearchTextRunner,
    private readonly queryIdentitySha256: string,
    private readonly control: StructuralExecutionControl,
  ) {
    const host = this.host();
    const contentPolicySha256 = workspaceIndexContentPolicyFingerprint(
      CODE_REDACTION_REVISION,
      workspaceContentPolicy(runner.scope.workspace),
      workspaceContentSecrets(runner.scope.workspace),
    );
    this.matches = new ShardFamily(
      host,
      MATCH_LIMITS,
      (shard) => ({ ...this.scopeKey(), queryMatchShard: shard }),
      (record) => record.queryMatch !== undefined,
    );
    this.contents = new ShardFamily(
      host,
      CONTENT_LIMITS,
      (shard) => ({ ...this.scopeKey(), contentShard: shard, contentPolicySha256 }),
      (record) => record.kind === "binary" || record.content !== undefined,
    );
  }

  private host(): ShardFamilyHost {
    return {
      active: (): boolean => this.active(),
      usable: (): boolean => this.usable(),
      load: (key) => this.loadSnapshot(key),
      save: (key, records) => this.saveSnapshot(key, records),
      dropRecord: (): false => this.dropRecord(),
    };
  }

  private active(): boolean {
    return !structuralExecutionStopped(this.control);
  }

  private usable(): boolean {
    return this.active() && this.available;
  }

  private scopeKey(): WorkspaceIndexScopeKey {
    return buildWorkspaceIndexScopeKey(
      this.runner.scope,
      { ...this.runner.policy, policyMode: this.runner.policy.mode },
      this.runner.limits.maxBytesPerFileScanned,
      DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
      this.runner.candidatePathGlobs,
    );
  }

  private async loadSnapshot(
    key: WorkspaceIndexScopeKey,
  ): Promise<WorkspaceIndexSnapshot | undefined> {
    try {
      return await raceStructuralExecution(
        this.index.loadSnapshot(key, () => this.active()),
        this.control,
      );
    } catch {
      // The observed owning adapter records the failure; source search remains independent of storage.
      this.available = false;
      return undefined;
    }
  }

  /** Rejects when the store fails; `finalize` owns that failure for both shard families. */
  private async saveSnapshot(
    key: WorkspaceIndexScopeKey,
    records: WorkspaceIndexRecord[],
  ): Promise<void> {
    const snapshot = this.snapshot(key, records);
    if (!this.active()) return;
    await raceStructuralExecution(
      this.index.saveSnapshot(key, snapshot, () => this.active()),
      this.control,
    );
  }

  private dropRecord(): false {
    this.droppedRecords += 1;
    return false;
  }

  public async lookup(
    metadata: WorkspaceIndexDiscoveredFile,
  ): Promise<StreamingWorkspaceIndexHit | undefined> {
    if (!this.usable()) return undefined;
    this.discoveredEntries += 1;
    const [matchShard, contentShard] = await Promise.all([
      this.matches.shard(metadata.scopePath),
      this.contents.shard(metadata.scopePath),
    ]);
    if (!this.usable()) return undefined;
    const match = currentRecord(matchShard, metadata);
    const content = currentRecord(contentShard, metadata);
    // One changed file counts once, whichever layers still held its earlier state.
    if (match === "stale" || content === "stale") this.staleRecords += 1;
    const queryMatch = match === "stale" ? undefined : match?.queryMatch;
    if (queryMatch?.queryIdentitySha256 === this.queryIdentitySha256)
      return { kind: "match", match: queryMatch };
    return content === "stale" ? undefined : this.contentHit(content);
  }

  private contentHit(
    record: WorkspaceIndexRecord | undefined,
  ): StreamingWorkspaceIndexHit | undefined {
    if (record?.kind === "binary") return { kind: "binary" };
    if (record?.content === undefined) return undefined;
    const text = decodeWorkspaceIndexContent(record.content);
    if (text !== undefined) return { kind: "text", text };
    // A payload that no longer proves its digest is a miss; the live read replaces it.
    this.dropRecord();
    return undefined;
  }

  public async observeReuse(
    metadata: WorkspaceIndexDiscoveredFile,
    kind: StreamingWorkspaceIndexHit["kind"],
  ): Promise<void> {
    const path = metadata.scopePath;
    const [matchShard, contentShard] = await Promise.all([
      this.matches.shard(path),
      this.contents.shard(path),
    ]);
    if (!this.usable()) return;
    if (contentShard.records.has(path)) this.contents.markSeen(contentShard, path);
    if (kind === "match" && this.matches.markSeen(matchShard, path)) this.retainedEntries += 1;
    if (kind === "text") this.pendingReads.set(path, { metadata, reused: true });
    this.reusedRecords += 1;
  }

  public async observeRead(
    metadata: WorkspaceIndexDiscoveredFile,
    observed: StreamingWorkspaceIndexObservation,
  ): Promise<void> {
    if (!this.usable()) return;
    const path = metadata.scopePath;
    if (observed.kind === "text") this.pendingReads.set(path, { metadata, reused: false });
    const record = contentRecord(metadata, observed);
    if (record === undefined) {
      this.dropRecord();
      return;
    }
    const shard = await this.contents.shard(path);
    if (!this.usable() || !this.contents.retain(shard, record)) return;
    this.contents.markSeen(shard, path);
    shard.dirty = true;
  }

  public async observeMatch(
    path: string,
    matches: FileMatches | undefined,
    complete: boolean,
  ): Promise<void> {
    const pending = this.pendingReads.get(path);
    this.pendingReads.delete(path);
    if (!this.usable() || pending === undefined) return;
    if (!complete) {
      this.skippedEntries += 1;
      return;
    }
    const queryMatch = matchingRecord(this.queryIdentitySha256, matches);
    if (queryMatch === undefined) {
      this.dropRecord();
      return;
    }
    const shard = await this.matches.shard(path);
    if (!this.usable()) return;
    if (!this.matches.retain(shard, { ...pending.metadata, kind: "text", queryMatch })) return;
    if (this.matches.markSeen(shard, path)) this.retainedEntries += 1;
    shard.dirty = true;
    // A match computed from stored lane text reused that file; only a live read indexes it anew.
    if (!pending.reused) this.indexedRecords += 1;
  }

  private snapshot(
    key: WorkspaceIndexScopeKey,
    records: readonly WorkspaceIndexRecord[],
  ): WorkspaceIndexSnapshot {
    return buildWorkspaceIndexSnapshot({
      queryMatchShard: key.queryMatchShard,
      contentShard: key.contentShard,
      scope: { ...this.runner.scope, candidatePathGlobs: this.runner.candidatePathGlobs },
      policy: { ...this.runner.policy, policyMode: this.runner.policy.mode },
      maxBytesPerFileScanned: this.runner.limits.maxBytesPerFileScanned,
      maxFilesScanned: DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
      records,
      discovery: {
        files: records,
        directories: [],
        filesDiscovered: records.length,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: true,
      },
    });
  }

  public async finalize(): Promise<void> {
    this.pendingReads.clear();
    if (!this.usable()) return;
    try {
      await this.matches.finalize();
      await this.contents.finalize();
    } catch {
      // The observed owning adapter records the failure; the answer keeps its live evidence.
      this.available = false;
    }
  }

  public report(): WorkspaceIndexPreparationReport {
    return {
      discoveredEntries: this.discoveredEntries,
      retainedEntries: this.retainedEntries,
      indexedRecords: this.indexedRecords,
      reusedRecords: this.reusedRecords,
      staleRecords: this.staleRecords,
      skippedEntries: this.skippedEntries,
      deletedEntries: 0,
      droppedRecords: this.droppedRecords,
    };
  }
}

/** The shard's record for this file, "stale" when the file changed since it was stored. */
function currentRecord(
  shard: IndexShard,
  metadata: WorkspaceIndexDiscoveredFile,
): WorkspaceIndexRecord | "stale" | undefined {
  const record = shard.records.get(metadata.scopePath);
  if (record === undefined) return undefined;
  return isWorkspaceIndexRecordCurrent(record, metadata) ? record : "stale";
}

function contentRecord(
  metadata: WorkspaceIndexDiscoveredFile,
  observed: StreamingWorkspaceIndexObservation,
): WorkspaceIndexRecord | undefined {
  if (observed.kind === "binary") return { ...metadata, kind: "binary" };
  const content = encodeWorkspaceIndexContent(observed.text);
  return content === undefined ? undefined : { ...metadata, kind: "text", content };
}

function matchingRecord(
  queryIdentitySha256: string,
  matches: FileMatches | undefined,
): WorkspaceIndexQueryMatch | undefined {
  return normalizeWorkspaceIndexQueryMatch({
    queryIdentitySha256,
    best: matches?.best ?? [],
    maxScore: matches?.maxScore ?? 0,
    ...(matches?.contentScore === undefined ? {} : { contentScore: matches.contentScore }),
    ...(matches?.definitionMatch === undefined ? {} : { definitionMatch: matches.definitionMatch }),
  });
}
