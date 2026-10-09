import { createHash } from "node:crypto";
import type { FileMatches, SearchTextRunner } from "./repoSearchScan.js";
import {
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES,
  DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
  isWorkspaceIndexRecordCurrent,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoveredFile,
  type WorkspaceIndexPreparationReport,
  type WorkspaceIndexRecord,
  type WorkspaceIndexScopeKey,
} from "./workspaceIndex.js";
import {
  normalizeWorkspaceIndexQueryMatch,
  type WorkspaceIndexQueryMatch,
} from "./workspaceIndexQueryMatch.js";

const SHARDS = 16;
// Lazy query shards share the existing store's per-shard bounds; request memory has a smaller cap.
const MAX_REQUEST_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
// Each retained record also appears in discovery.files; the existing cap counts both rows.
const MAX_SHARD_RECORDS = Math.floor(DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES / 2);

interface QueryShard {
  readonly key: WorkspaceIndexScopeKey;
  readonly records: Map<string, WorkspaceIndexRecord>;
  readonly seen: Set<string>;
  bytes: number;
  dirty: boolean;
}

export interface StreamingWorkspaceIndexSession {
  readonly lookup: (
    metadata: WorkspaceIndexDiscoveredFile,
  ) => Promise<WorkspaceIndexQueryMatch | undefined>;
  readonly observeRead: (metadata: WorkspaceIndexDiscoveredFile) => void;
  readonly observeMatch: (
    path: string,
    matches: FileMatches | undefined,
    complete: boolean,
  ) => Promise<void>;
  readonly finalize: () => Promise<void>;
  readonly report: () => WorkspaceIndexPreparationReport;
}

function shardFor(path: string): number {
  return (createHash("sha256").update(path).digest().at(0) ?? 0) % SHARDS;
}

export class StreamingWorkspaceIndex implements StreamingWorkspaceIndexSession {
  private readonly shards = new Map<number, Promise<QueryShard>>();
  private readonly pendingReads = new Map<string, WorkspaceIndexDiscoveredFile>();
  private bytes = 0;
  private reusedRecords = 0;
  private staleRecords = 0;
  private indexedRecords = 0;
  private discoveredEntries = 0;

  public constructor(
    private readonly index: WorkspaceIndex,
    private readonly runner: SearchTextRunner,
    private readonly queryIdentitySha256: string,
    private readonly control: StructuralExecutionControl,
  ) {}

  private active(): boolean {
    return !structuralExecutionStopped(this.control);
  }

  private scopeKey(shard: number): WorkspaceIndexScopeKey {
    return {
      ...buildWorkspaceIndexScopeKey(
        this.runner.scope,
        { ...this.runner.policy, policyMode: this.runner.policy.mode },
        this.runner.limits.maxBytesPerFileScanned,
        DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_ENTRIES,
        this.runner.candidatePathGlobs,
      ),
      queryMatchShard: shard,
    };
  }

  private async load(shard: number): Promise<QueryShard> {
    const key = this.scopeKey(shard);
    const result: QueryShard = { key, records: new Map(), seen: new Set(), bytes: 0, dirty: false };
    if (!this.active()) return result;
    const snapshot = await this.index.loadSnapshot(key, () => this.active());
    if (!this.active() || snapshot === undefined) return result;
    for (const record of snapshot.records) {
      if (!this.active()) break;
      if (record.queryMatch === undefined) continue;
      this.retain(result, record);
    }
    return result;
  }

  private async shard(path: string): Promise<QueryShard> {
    const number = shardFor(path);
    let pending = this.shards.get(number);
    if (pending === undefined) {
      pending = this.load(number);
      this.shards.set(number, pending);
    }
    return pending;
  }

  private retain(shard: QueryShard, record: WorkspaceIndexRecord): boolean {
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    const previous = shard.records.get(record.scopePath);
    const oldSize =
      previous === undefined ? 0 : Buffer.byteLength(JSON.stringify(previous), "utf8");
    if (size > MAX_RECORD_BYTES || this.bytes - oldSize + size > MAX_REQUEST_RECORD_BYTES)
      return false;
    if (shard.bytes - oldSize + size > DEFAULT_FILE_WORKSPACE_INDEX_MAX_SNAPSHOT_BYTES / 4)
      return false;
    if (
      previous === undefined &&
      shard.records.size >= MAX_SHARD_RECORDS - shard.key.relativePaths.length
    )
      return false;
    shard.records.set(record.scopePath, record);
    shard.bytes += size - oldSize;
    this.bytes += size - oldSize;
    return true;
  }

  public async lookup(
    metadata: WorkspaceIndexDiscoveredFile,
  ): Promise<WorkspaceIndexQueryMatch | undefined> {
    if (!this.active()) return undefined;
    const shard = await this.shard(metadata.scopePath);
    if (!this.active()) return undefined;
    this.discoveredEntries += 1;
    const record = shard.records.get(metadata.scopePath);
    if (record !== undefined) shard.seen.add(metadata.scopePath);
    if (!isWorkspaceIndexRecordCurrent(record, metadata)) {
      if (record !== undefined) this.staleRecords += 1;
      return undefined;
    }
    if (record?.queryMatch?.queryIdentitySha256 !== this.queryIdentitySha256) return undefined;
    this.reusedRecords += 1;
    return record.queryMatch;
  }

  public observeRead(metadata: WorkspaceIndexDiscoveredFile): void {
    if (this.active()) this.pendingReads.set(metadata.scopePath, metadata);
  }

  public async observeMatch(
    path: string,
    matches: FileMatches | undefined,
    complete: boolean,
  ): Promise<void> {
    const metadata = this.pendingReads.get(path);
    this.pendingReads.delete(path);
    if (!this.active() || metadata === undefined || !complete) return;
    const queryMatch = matchingRecord(this.queryIdentitySha256, matches);
    if (queryMatch === undefined) return;
    const pending = this.shards.get(shardFor(path));
    if (pending === undefined) return;
    const shard = await pending;
    if (!this.active()) return;
    if (!this.retain(shard, { ...metadata, kind: "text", queryMatch })) return;
    shard.seen.add(path);
    shard.dirty = true;
    this.indexedRecords += 1;
  }

  private snapshot(shard: QueryShard): ReturnType<typeof buildWorkspaceIndexSnapshot> {
    const records = [...shard.records.values()].filter((record) =>
      shard.seen.has(record.scopePath),
    );
    return buildWorkspaceIndexSnapshot({
      queryMatchShard: shard.key.queryMatchShard,
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
    for (const pending of this.shards.values()) {
      if (!this.active()) return;
      const shard = await pending;
      if (!this.active()) return;
      if (!shard.dirty) continue;
      const snapshot = this.snapshot(shard);
      if (!this.active()) return;
      try {
        await this.index.saveSnapshot(shard.key, snapshot, () => this.active());
      } catch (error) {
        if (this.active()) throw error;
      }
    }
  }

  public report(): WorkspaceIndexPreparationReport {
    return {
      discoveredEntries: this.discoveredEntries,
      retainedEntries: this.discoveredEntries,
      indexedRecords: this.indexedRecords,
      reusedRecords: this.reusedRecords,
      staleRecords: this.staleRecords,
      skippedEntries: 0,
      deletedEntries: 0,
      droppedRecords: 0,
    };
  }
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
