import { type FSWatcher, type Stats, watch } from "node:fs";
import { readdir, realpath, stat, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix as pathPosix, relative, resolve } from "node:path";

import {
  EDITOR_M7_SCHEMA_VERSION,
  type EditorM7WatchDegradedReason,
  type EditorM7WatchEntryKind,
  type EditorM7WatchEvent,
  type EditorM7WatchEventKind,
  type EditorM7WatchHealth,
  type EditorM7WatchSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";

import { pathIsDenied } from "../../files-deny.js";

export interface WorkspaceWatchRawEvent {
  readonly eventType: "rename" | "change" | "overflow";
  readonly filename?: WorkspaceWatchEventPath;
  readonly oldFilename?: WorkspaceWatchEventPath;
}

type WorkspaceWatchEventPath = string | Buffer | null | undefined;

export interface WorkspaceNativeWatchHandle {
  readonly recursive: boolean;
  readonly close: () => void;
}

export interface WorkspaceWatchAdapter {
  readonly watch: (args: WorkspaceWatchAdapterArgs) => WorkspaceNativeWatchHandle;
}

export interface WorkspaceWatchAdapterArgs {
  readonly root: string;
  readonly onEvent: (event: WorkspaceWatchRawEvent) => void;
  readonly onError: (error: unknown) => void;
}

export interface WorkspaceWatchService {
  readonly subscribe: (args: WorkspaceWatchSubscribeArgs) => WorkspaceWatchSubscribeResult;
  readonly snapshot: (root: string) => EditorM7WatchSnapshot;
  readonly disposeRoot: (root: string) => void;
  readonly disposeAll: () => void;
}

export interface WorkspaceWatchSubscribeArgs {
  readonly root: string;
  readonly lastSequence?: number | undefined;
  readonly onEvent: (event: EditorM7WatchEvent) => void;
  readonly additionalExclusions?: readonly string[] | undefined;
}

export type WorkspaceWatchSubscribeResult =
  | {
      readonly kind: "ok";
      readonly snapshot: EditorM7WatchSnapshot;
      readonly replay: readonly EditorM7WatchEvent[];
      readonly snapshotRequired: boolean;
      readonly unsubscribe: () => void;
    }
  | { readonly kind: "subscriberLimit"; readonly snapshot: EditorM7WatchSnapshot };

export interface WorkspaceWatchServiceOptions {
  readonly adapter?: WorkspaceWatchAdapter | undefined;
  readonly coalesceMs?: number | undefined;
  readonly idleTearDownMs?: number | undefined;
  readonly fallbackPollMs?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly maxBatchSize?: number | undefined;
  readonly replayCapacity?: number | undefined;
  readonly maxSubscribersPerRoot?: number | undefined;
  readonly maxScanEntries?: number | undefined;
}

interface WatchSubscriber {
  readonly id: number;
  readonly onEvent: (event: EditorM7WatchEvent) => void;
}

interface PendingChange {
  readonly relativePath: string;
  readonly oldRelativePath?: string | undefined;
  readonly eventType: WorkspaceWatchRawEvent["eventType"];
}

interface FileMetadata {
  readonly relativePath: string;
  readonly entryKind: EditorM7WatchEntryKind;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly metadataHash: string;
}

type MetadataResult =
  | { readonly kind: "present"; readonly metadata: FileMetadata }
  | { readonly kind: "absent" }
  | { readonly kind: "unsafe" };

interface ScanResult {
  readonly entries: Map<string, FileMetadata>;
  readonly truncated: boolean;
}

interface WatchConfig {
  readonly adapter: WorkspaceWatchAdapter;
  readonly coalesceMs: number;
  readonly idleTearDownMs: number;
  readonly fallbackPollMs: number;
  readonly maxQueueDepth: number;
  readonly maxBatchSize: number;
  readonly replayCapacity: number;
  readonly maxSubscribersPerRoot: number;
  readonly maxScanEntries: number;
}

const DEFAULT_CONFIG: Omit<WatchConfig, "adapter"> = {
  coalesceMs: 50,
  idleTearDownMs: 3_000,
  fallbackPollMs: 2_000,
  maxQueueDepth: 1_024,
  maxBatchSize: 128,
  replayCapacity: 256,
  maxSubscribersPerRoot: 64,
  maxScanEntries: 20_000,
};

const EXCLUDED_SEGMENTS = new Set(["node_modules", ".next", ".turbo", "dist", "build", "out"]);
const EXCLUDED_PREFIXES = [".git/objects", ".git/logs", ".codex", ".keiko/private"] as const;

// User/workspace-configurable `watcherExclusions` (validated upstream by keiko-contracts'
// `safeSettingPathToken`, so entries are already NUL/traversal/absolute-path free). A pattern
// containing "/" is treated as a relative path prefix; a bare pattern is treated as a segment
// name, mirroring EXCLUDED_SEGMENTS/EXCLUDED_PREFIXES.
interface WatchExclusions {
  readonly segments: ReadonlySet<string>;
  readonly prefixes: readonly string[];
}

const NO_EXCLUSIONS: WatchExclusions = Object.freeze({
  segments: new Set<string>(),
  prefixes: [],
});

function exclusionsFromPatterns(patterns: readonly string[]): WatchExclusions {
  const segments = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("/")) prefixes.push(pattern);
    else segments.add(pattern);
  }
  return { segments, prefixes };
}

function bufferToString(value: string | Buffer | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function rootToken(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex").slice(0, 24);
}

function normalizeEventPath(filename: string | Buffer | null | undefined): string | null {
  const raw = bufferToString(filename);
  if (raw === null || raw.includes("\0") || isAbsolute(raw)) return null;
  const normalized = pathPosix.normalize(raw.replaceAll("\\", "/"));
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function matchesPrefix(relativePath: string, prefix: string): boolean {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function hardExcluded(relativePath: string, additional: WatchExclusions): boolean {
  const segments = relativePath.split("/").filter((part) => part.length > 0);
  return (
    segments.some(
      (segment) => EXCLUDED_SEGMENTS.has(segment) || additional.segments.has(segment),
    ) ||
    EXCLUDED_PREFIXES.some((prefix) => matchesPrefix(relativePath, prefix)) ||
    additional.prefixes.some((prefix) => matchesPrefix(relativePath, prefix))
  );
}

function eventPathAllowed(relativePath: string, additional: WatchExclusions): boolean {
  return !pathIsDenied(relativePath) && !hardExcluded(relativePath, additional);
}

function relativePathFromNative(root: string, target: string): string {
  return relative(root, target).replaceAll("\\", "/");
}

function metadataHash(kind: EditorM7WatchEntryKind, stats: Stats): string {
  return createHash("sha256")
    .update(
      `${kind}:${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`,
    )
    .digest("hex")
    .slice(0, 24);
}

function entryKind(linkStats: Stats, targetStats: Stats): EditorM7WatchEntryKind {
  if (linkStats.isSymbolicLink()) return "symlink";
  if (targetStats.isDirectory()) return "directory";
  if (targetStats.isFile()) return "file";
  return "unknown";
}

async function metadataFor(
  root: string,
  relativePath: string,
  additional: WatchExclusions,
): Promise<MetadataResult> {
  if (!eventPathAllowed(relativePath, additional)) return { kind: "unsafe" };
  const candidate = relativePath.length === 0 ? root : resolve(root, ...relativePath.split("/"));
  try {
    const linkStats = await lstat(candidate);
    const real = await realpath(candidate);
    if (!containsPath(root, real)) return { kind: "unsafe" };
    const realRelativePath = relativePathFromNative(root, real);
    if (!eventPathAllowed(realRelativePath, additional)) return { kind: "unsafe" };
    const targetStats = await stat(real);
    const kind = entryKind(linkStats, targetStats);
    return {
      kind: "present",
      metadata: {
        relativePath,
        entryKind: kind,
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtimeMs,
        metadataHash: metadataHash(kind, targetStats),
      },
    };
  } catch {
    return { kind: "absent" };
  }
}

function eventFromMetadata(
  sequence: number,
  kind: EditorM7WatchEventKind,
  metadata: FileMetadata,
  oldRelativePath?: string,
): EditorM7WatchEvent {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence,
    kind,
    relativePath: metadata.relativePath,
    ...(oldRelativePath === undefined ? {} : { oldRelativePath }),
    entryKind: metadata.entryKind,
    sizeBytes: metadata.sizeBytes,
    modifiedAt: metadata.modifiedAt,
    metadataHash: metadata.metadataHash,
  };
}

function deletedEvent(sequence: number, relativePath: string): EditorM7WatchEvent {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence,
    kind: "deleted",
    relativePath,
    entryKind: "unknown",
  };
}

function createNodeAdapter(): WorkspaceWatchAdapter {
  return {
    watch: ({ root, onEvent, onError }): WorkspaceNativeWatchHandle => {
      const watcher: FSWatcher = watch(root, { recursive: true }, (eventType, filename) => {
        onEvent({ eventType, filename });
      });
      watcher.on("error", onError);
      return {
        recursive: true,
        close: (): void => {
          watcher.close();
        },
      };
    },
  };
}

function configFromOptions(options: WorkspaceWatchServiceOptions): WatchConfig {
  return {
    adapter: options.adapter ?? createNodeAdapter(),
    coalesceMs: options.coalesceMs ?? DEFAULT_CONFIG.coalesceMs,
    idleTearDownMs: options.idleTearDownMs ?? DEFAULT_CONFIG.idleTearDownMs,
    fallbackPollMs: options.fallbackPollMs ?? DEFAULT_CONFIG.fallbackPollMs,
    maxQueueDepth: options.maxQueueDepth ?? DEFAULT_CONFIG.maxQueueDepth,
    maxBatchSize: options.maxBatchSize ?? DEFAULT_CONFIG.maxBatchSize,
    replayCapacity: options.replayCapacity ?? DEFAULT_CONFIG.replayCapacity,
    maxSubscribersPerRoot: options.maxSubscribersPerRoot ?? DEFAULT_CONFIG.maxSubscribersPerRoot,
    maxScanEntries: options.maxScanEntries ?? DEFAULT_CONFIG.maxScanEntries,
  };
}

function replayOldestSequence(replay: readonly EditorM7WatchEvent[], sequence: number): number {
  return replay[0]?.sequence ?? sequence;
}

class WorkspaceWatchSession {
  private readonly subscribers = new Map<number, WatchSubscriber>();
  private readonly pending = new Map<string, PendingChange>();
  private readonly known = new Map<string, FileMetadata>();
  private readonly replay: EditorM7WatchEvent[] = [];
  private readonly degradedReasons = new Set<EditorM7WatchDegradedReason>();
  private nextSubscriberId = 0;
  private sequence = 0;
  private eventCount = 0;
  private health: EditorM7WatchHealth = "healthy";
  private handle: WorkspaceNativeWatchHandle | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private baselineReady: Promise<void> | null = null;
  private flushing = false;
  private disposed = false;
  private additionalExclusions: WatchExclusions = NO_EXCLUSIONS;

  public constructor(
    private readonly root: string,
    private readonly config: WatchConfig,
    private readonly onIdleDispose: (root: string) => void,
  ) {}

  public subscribe(args: WorkspaceWatchSubscribeArgs): WorkspaceWatchSubscribeResult {
    this.cancelIdleTimer();
    if (args.additionalExclusions !== undefined) {
      this.additionalExclusions = exclusionsFromPatterns(args.additionalExclusions);
    }
    this.ensureStarted();
    if (this.subscribers.size >= this.config.maxSubscribersPerRoot) {
      return { kind: "subscriberLimit", snapshot: this.snapshot(true) };
    }
    const subscriber = this.addSubscriber(args.onEvent);
    const replay = this.replayAfter(args.lastSequence);
    const snapshotRequired = this.snapshotRequired(args.lastSequence);
    return {
      kind: "ok",
      snapshot: this.snapshot(snapshotRequired),
      replay,
      snapshotRequired,
      unsubscribe: (): void => {
        this.unsubscribe(subscriber.id);
      },
    };
  }

  public snapshot(requiresSnapshot = false): EditorM7WatchSnapshot {
    return {
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      sequence: this.sequence,
      health: this.health,
      rootToken: rootToken(this.root),
      nativeWatcherCount: this.handle === null ? 0 : 1,
      subscriberCount: this.subscribers.size,
      queueDepth: this.pending.size,
      replayCapacity: this.config.replayCapacity,
      replayOldestSequence: replayOldestSequence(this.replay, this.sequence),
      eventCount: this.eventCount,
      requiresSnapshot,
      degradedReasons: [...this.degradedReasons].sort((left, right) => left.localeCompare(right)),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.handle?.close();
    this.handle = null;
    this.subscribers.clear();
    this.pending.clear();
    this.health = "stopped";
    this.degradedReasons.add("shutdown");
  }

  private addSubscriber(onEvent: (event: EditorM7WatchEvent) => void): WatchSubscriber {
    this.nextSubscriberId += 1;
    const subscriber = { id: this.nextSubscriberId, onEvent };
    this.subscribers.set(subscriber.id, subscriber);
    return subscriber;
  }

  private unsubscribe(id: number): void {
    this.subscribers.delete(id);
    if (this.subscribers.size === 0) this.scheduleIdleDispose();
  }

  private ensureStarted(): void {
    if (this.disposed || this.handle !== null || this.pollTimer !== null) return;
    try {
      this.handle = this.config.adapter.watch({
        root: this.root,
        onEvent: (event) => {
          this.handleRawEvent(event);
        },
        onError: () => {
          this.handleNativeWatchError();
        },
      });
      this.startBaselineSeed();
      if (!this.handle.recursive) this.enterDegraded("unsupported-recursive-watch");
    } catch {
      this.enterDegraded("native-watch-unavailable");
      this.startFallbackPolling();
    }
  }

  // A native watcher can stop delivering events after an async 'error' (watched directory
  // removed/unmounted, NFS disconnect, inotify limit) without the process ever throwing. Without
  // falling back to polling here, the session would stay degraded but silently stop reconciling.
  private handleNativeWatchError(): void {
    if (this.disposed) return;
    this.handle?.close();
    this.handle = null;
    this.enterDegraded("native-watch-unavailable");
    this.startFallbackPolling();
  }

  private handleRawEvent(event: WorkspaceWatchRawEvent): void {
    if (this.disposed) return;
    if (event.eventType === "overflow") {
      this.emitRescan("event-overflow", "overflow");
      return;
    }
    const relativePath = normalizeEventPath(event.filename);
    const oldRelativePath = normalizeEventPath(event.oldFilename);
    if (relativePath === null || (event.oldFilename !== undefined && oldRelativePath === null)) {
      this.emitRescan("ambiguous-event", "rescan");
      return;
    }
    if (!eventPathAllowed(relativePath, this.additionalExclusions)) {
      this.enterDegraded("unsafe-path");
      return;
    }
    this.queue({
      relativePath,
      oldRelativePath: oldRelativePath ?? undefined,
      eventType: event.eventType,
    });
  }

  private queue(change: PendingChange): void {
    if (this.pending.size >= this.config.maxQueueDepth && !this.pending.has(change.relativePath)) {
      this.pending.clear();
      this.emitRescan("event-overflow", "overflow");
      return;
    }
    this.pending.set(change.relativePath, change);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPending();
    }, this.config.coalesceMs);
    this.flushTimer.unref();
  }

  private async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.awaitBaseline();
      while (this.pending.size > 0 && !this.disposed) {
        const batch = [...this.pending.values()].slice(0, this.config.maxBatchSize);
        for (const change of batch) this.pending.delete(change.relativePath);
        for (const change of batch) await this.reconcileChange(change);
      }
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) this.scheduleFlush();
    }
  }

  private async reconcileChange(change: PendingChange): Promise<void> {
    if (this.disposed) return;
    if (change.oldRelativePath !== undefined) {
      await this.reconcileRename(change.oldRelativePath, change.relativePath);
      return;
    }
    const current = await metadataFor(this.root, change.relativePath, this.additionalExclusions);
    this.applyMetadataResult(change.relativePath, current);
  }

  private async reconcileRename(oldRelativePath: string, relativePath: string): Promise<void> {
    const current = await metadataFor(this.root, relativePath, this.additionalExclusions);
    if (current.kind !== "present") {
      this.emitRescan(current.kind === "unsafe" ? "unsafe-path" : "ambiguous-event", "rescan");
      return;
    }
    this.known.delete(oldRelativePath);
    this.known.set(relativePath, current.metadata);
    this.emit(eventFromMetadata(this.nextSequence(), "renamed", current.metadata, oldRelativePath));
  }

  private applyMetadataResult(relativePath: string, result: MetadataResult): void {
    if (result.kind === "unsafe") {
      this.enterDegraded("unsafe-path");
      return;
    }
    if (result.kind === "absent") {
      this.applyAbsent(relativePath);
      return;
    }
    this.applyPresent(result.metadata);
  }

  private applyAbsent(relativePath: string): void {
    if (!this.known.has(relativePath)) return;
    this.known.delete(relativePath);
    this.emit(deletedEvent(this.nextSequence(), relativePath));
  }

  private applyPresent(metadata: FileMetadata): void {
    const previous = this.known.get(metadata.relativePath);
    this.known.set(metadata.relativePath, metadata);
    if (previous === undefined) {
      this.emit(eventFromMetadata(this.nextSequence(), "created", metadata));
    } else if (previous.metadataHash !== metadata.metadataHash) {
      this.emit(eventFromMetadata(this.nextSequence(), "changed", metadata));
    }
  }

  private startBaselineSeed(): void {
    this.baselineReady ??= this.seedBaseline();
  }

  private async awaitBaseline(): Promise<void> {
    if (this.baselineReady !== null) await this.baselineReady;
  }

  private async seedBaseline(): Promise<void> {
    const next = await this.scanTree();
    if (next === null || this.disposed) return;
    this.known.clear();
    for (const metadata of next.entries.values()) this.known.set(metadata.relativePath, metadata);
  }

  private async scanAndEmitDiff(): Promise<void> {
    const next = await this.scanTree();
    if (next === null || this.disposed) return;
    // A truncated scan (maxScanEntries overflow) only saw part of the tree — treating unreached
    // known paths as deleted would fabricate deletions for files that still exist. Skip the
    // deletion diff for a truncated pass; the already-emitted overflow/rescan signal owns recovery.
    if (!next.truncated) {
      for (const [path, previous] of this.known)
        if (!next.entries.has(path))
          this.emit(deletedEvent(this.nextSequence(), previous.relativePath));
    }
    for (const metadata of next.entries.values()) this.applyPresent(metadata);
  }

  private async scanTree(): Promise<ScanResult | null> {
    try {
      const rootStats = await stat(this.root);
      if (!rootStats.isDirectory()) return this.rootReplaced();
      return await this.scanDirectory("");
    } catch {
      return this.rootReplaced();
    }
  }

  private rootReplaced(): null {
    this.emitRescan("root-replaced", "rescan");
    return null;
  }

  private async scanDirectory(start: string): Promise<ScanResult> {
    const found = new Map<string, FileMetadata>();
    const queue = [start];
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift() ?? "";
      if (found.size > this.config.maxScanEntries) {
        this.emitRescan("event-overflow", "overflow");
        truncated = true;
        break;
      }
      await this.scanOneDirectory(current, found, queue);
    }
    return { entries: found, truncated };
  }

  private async scanOneDirectory(
    relativeDirectory: string,
    found: Map<string, FileMetadata>,
    queue: string[],
  ): Promise<void> {
    const directory =
      relativeDirectory.length === 0 ? this.root : join(this.root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (!eventPathAllowed(relativePath, this.additionalExclusions)) continue;
      const result = await metadataFor(this.root, relativePath, this.additionalExclusions);
      if (result.kind !== "present") continue;
      found.set(relativePath, result.metadata);
      if (result.metadata.entryKind === "directory") queue.push(relativePath);
    }
  }

  private startFallbackPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.scanAndEmitDiff();
    }, this.config.fallbackPollMs);
    this.pollTimer.unref();
  }

  private enterDegraded(reason: EditorM7WatchDegradedReason): void {
    this.degradedReasons.add(reason);
    if (this.health === "healthy") this.health = "degraded";
  }

  private emitRescan(reason: EditorM7WatchDegradedReason, kind: "rescan" | "overflow"): void {
    this.degradedReasons.add(reason);
    this.health = "rescanRequired";
    this.emit({
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      sequence: this.nextSequence(),
      kind,
      relativePath: "",
      entryKind: "unknown",
      health: this.health,
      reason,
    });
  }

  private emit(event: EditorM7WatchEvent): void {
    if (this.disposed) return;
    this.eventCount += 1;
    this.replay.push(event);
    while (this.replay.length > this.config.replayCapacity) this.replay.shift();
    for (const subscriber of this.subscribers.values()) subscriber.onEvent(event);
  }

  private replayAfter(lastSequence: number | undefined): readonly EditorM7WatchEvent[] {
    if (lastSequence === undefined) return [];
    return this.replay.filter((event) => event.sequence > lastSequence);
  }

  private snapshotRequired(lastSequence: number | undefined): boolean {
    if (lastSequence === undefined || this.replay.length === 0) return false;
    return lastSequence < (this.replay[0]?.sequence ?? 0) - 1;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private scheduleIdleDispose(): void {
    if (this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.onIdleDispose(this.root);
    }, this.config.idleTearDownMs);
    this.idleTimer.unref();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearTimers(): void {
    this.cancelIdleTimer();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.flushTimer = null;
    this.pollTimer = null;
  }
}

export function createWorkspaceWatchService(
  options: WorkspaceWatchServiceOptions = {},
): WorkspaceWatchService {
  const config = configFromOptions(options);
  const sessions = new Map<string, WorkspaceWatchSession>();
  const sessionFor = (root: string): WorkspaceWatchSession => {
    const existing = sessions.get(root);
    if (existing !== undefined) return existing;
    const session = new WorkspaceWatchSession(root, config, (idleRoot) => {
      sessions.get(idleRoot)?.dispose();
      sessions.delete(idleRoot);
    });
    sessions.set(root, session);
    return session;
  };
  return {
    subscribe: (args): WorkspaceWatchSubscribeResult => sessionFor(args.root).subscribe(args),
    snapshot: (root): EditorM7WatchSnapshot => sessionFor(root).snapshot(),
    disposeRoot: (root): void => {
      sessions.get(root)?.dispose();
      sessions.delete(root);
    },
    disposeAll: (): void => {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}
