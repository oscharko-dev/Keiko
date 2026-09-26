import { type Dirent, type FSWatcher, type Stats, watch } from "node:fs";
import { readdir, realpath, stat, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix as pathPosix, relative, resolve } from "node:path";

import type {
  EditorM7WatchDegradedReason,
  EditorM7WatchEntryKind,
  EditorM7WatchEvent,
  EditorM7WatchEventKind,
  EditorM7WatchHealth,
  EditorM7WatchSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { containsPath } from "@oscharko-dev/keiko-git";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";

import { pathIsDenied } from "../../files-deny.js";
import type { WorkspaceRootAccess } from "../../task-workspace/workspace-root-access.js";

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

/**
 * Re-proves the caller's authority over the watched root and returns the FRESH capability that
 * authorizes it; `undefined` denies (#3347 review, owner P1).
 *
 * A boolean re-proof was not enough for this long-lived effect: admission handed the watch session
 * an unforgeable `WorkspaceRootAccess` and the session then performed every stat/readDir through its
 * own configured filesystem, which in production defaults to the module-level Node filesystem. The
 * capability was therefore discarded the moment admission succeeded. Returning the access itself
 * lets each effect boundary run on the filesystem the re-proof just minted.
 */
type WorkspaceWatchRootReprover = () => WorkspaceRootAccess | undefined;

interface WorkspaceWatchSubscribeArgs {
  readonly root: string;
  readonly lastSequence?: number | undefined;
  readonly onEvent: (event: EditorM7WatchEvent) => void;
  readonly reproveRoot?: WorkspaceWatchRootReprover | undefined;
  readonly onAuthorityRevoked?: (() => void) | undefined;
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
  | { readonly kind: "subscriberLimit"; readonly snapshot: EditorM7WatchSnapshot }
  | { readonly kind: "rootUnavailable"; readonly snapshot: EditorM7WatchSnapshot };

export interface WorkspaceWatchServiceOptions {
  readonly adapter?: WorkspaceWatchAdapter | undefined;
  readonly fileSystem?: WorkspaceWatchFileSystem | undefined;
  readonly coalesceMs?: number | undefined;
  readonly idleTearDownMs?: number | undefined;
  readonly fallbackPollMs?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly maxBatchSize?: number | undefined;
  readonly replayCapacity?: number | undefined;
  readonly maxSubscribersPerRoot?: number | undefined;
  readonly maxScanEntries?: number | undefined;
}

export interface WorkspaceWatchFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<Stats>;
  readonly readdir: (path: string) => Promise<readonly Dirent[]>;
}

/** The metadata this service reads, in the one shape both filesystem sources normalize to. */
interface WatchEntryStat {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly identity: string;
}

/**
 * The narrow effect surface a watch session actually needs. Both the injectable
 * `WorkspaceWatchFileSystem` seam and a re-proved `WorkspaceRootAccess.fs` capability normalize to
 * it, so there is exactly ONE reconciliation code path and neither source can silently reach around
 * the other.
 */
interface WatchEffectFileSystem {
  readonly lstat: (path: string) => Promise<WatchEntryStat>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<WatchEntryStat>;
  readonly readdirNames: (path: string) => Promise<readonly string[]>;
}

interface WatchSubscriber {
  readonly id: number;
  readonly onEvent: (event: EditorM7WatchEvent) => void;
  readonly reproveRoot: WorkspaceWatchRootReprover | undefined;
  readonly onAuthorityRevoked: (() => void) | undefined;
}

/**
 * One re-proof result. `granted` without an `access` means the caller supplied no reprover at all
 * (in-process composition and tests) — the session then falls back to its configured seam; `granted`
 * WITH an access means every effect must run on that capability's filesystem.
 */
interface RootAuthorityProof {
  readonly granted: boolean;
  readonly access: WorkspaceRootAccess | undefined;
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
  | { readonly kind: "unavailable" }
  | { readonly kind: "unsafe" };

interface ScanResult {
  readonly entries: Map<string, FileMetadata>;
  readonly complete: boolean;
}

type ScanDirectoryResult = "complete" | "overflow" | "unavailable";

interface WatchConfig {
  readonly adapter: WorkspaceWatchAdapter;
  readonly fileSystem: WatchEffectFileSystem;
  readonly coalesceMs: number;
  readonly idleTearDownMs: number;
  readonly fallbackPollMs: number;
  readonly maxQueueDepth: number;
  readonly maxBatchSize: number;
  readonly replayCapacity: number;
  readonly maxSubscribersPerRoot: number;
  readonly maxScanEntries: number;
}

const NODE_FILE_SYSTEM: WorkspaceWatchFileSystem = {
  lstat,
  realpath,
  stat,
  readdir: async (path): Promise<readonly Dirent[]> => readdir(path, { withFileTypes: true }),
};

// Keeps a synchronous throw from a capability filesystem on the promise path, so every call site
// observes one failure mode instead of two.
function deferred<T>(read: () => T): Promise<T> {
  try {
    return Promise.resolve(read());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function entryStatFromNode(stats: Stats): WatchEntryStat {
  return {
    isSymbolicLink: stats.isSymbolicLink(),
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    identity: `${String(stats.dev)}:${String(stats.ino)}`,
  };
}

function entryStatFromWorkspace(stat: WorkspaceStat): WatchEntryStat {
  return {
    isSymbolicLink: stat.isSymbolicLink,
    isDirectory: stat.isDirectory,
    isFile: stat.isFile,
    sizeBytes: stat.size,
    modifiedAtMs: stat.mtimeMs ?? 0,
    identity: stat.fileIdentity ?? "",
  };
}

function watchEffectsFromSeam(fileSystem: WorkspaceWatchFileSystem): WatchEffectFileSystem {
  return {
    lstat: async (path): Promise<WatchEntryStat> => entryStatFromNode(await fileSystem.lstat(path)),
    realpath: (path): Promise<string> => fileSystem.realpath(path),
    stat: async (path): Promise<WatchEntryStat> => entryStatFromNode(await fileSystem.stat(path)),
    readdirNames: async (path): Promise<readonly string[]> =>
      (await fileSystem.readdir(path)).map((entry) => entry.name),
  };
}

/**
 * Runs this session's reads on the capability the re-proof minted. `WorkspaceFs.stat` is a
 * no-follow lstat, which is exactly what `metadataFor` needs on both of its steps: link metadata
 * from the requested pathname, target metadata from the already-canonicalised path.
 */
function watchEffectsFromCapability(fs: WorkspaceFs): WatchEffectFileSystem {
  return {
    lstat: (path): Promise<WatchEntryStat> => deferred(() => entryStatFromWorkspace(fs.stat(path))),
    realpath: (path): Promise<string> => deferred(() => fs.realPath(path)),
    stat: (path): Promise<WatchEntryStat> => deferred(() => entryStatFromWorkspace(fs.stat(path))),
    readdirNames: (path): Promise<readonly string[]> =>
      deferred(() => fs.readDir(path).map((entry) => entry.name)),
  };
}

function configuredFileSystem(
  fileSystem: WorkspaceWatchFileSystem | undefined,
): WatchEffectFileSystem {
  return watchEffectsFromSeam(fileSystem ?? NODE_FILE_SYSTEM);
}

const UNPROVED_ROOT_AUTHORITY: RootAuthorityProof = Object.freeze({
  granted: true,
  access: undefined,
});
const DENIED_ROOT_AUTHORITY: RootAuthorityProof = Object.freeze({
  granted: false,
  access: undefined,
});

// A capability minted for a different canonical root can never authorize THIS session: the session
// key, the native watch target and the containment base are all `root`.
function proveRoot(
  reprove: WorkspaceWatchRootReprover | undefined,
  root: string,
): RootAuthorityProof {
  if (reprove === undefined) return UNPROVED_ROOT_AUTHORITY;
  try {
    const access = reprove();
    if (access?.canonicalRoot !== root) return DENIED_ROOT_AUTHORITY;
    return { granted: true, access };
  } catch {
    return DENIED_ROOT_AUTHORITY;
  }
}

const DEFAULT_CONFIG: Omit<WatchConfig, "adapter" | "fileSystem"> = {
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

function metadataHash(kind: EditorM7WatchEntryKind, stats: WatchEntryStat): string {
  return createHash("sha256")
    .update(`${kind}:${stats.identity}:${String(stats.sizeBytes)}:${String(stats.modifiedAtMs)}`)
    .digest("hex")
    .slice(0, 24);
}

function entryKind(linkStats: WatchEntryStat, targetStats: WatchEntryStat): EditorM7WatchEntryKind {
  if (linkStats.isSymbolicLink) return "symlink";
  if (targetStats.isDirectory) return "directory";
  if (targetStats.isFile) return "file";
  return "unknown";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function confirmsAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function metadataFor(
  root: string,
  relativePath: string,
  additional: WatchExclusions,
  fileSystem: WatchEffectFileSystem,
): Promise<MetadataResult> {
  if (!eventPathAllowed(relativePath, additional)) return { kind: "unsafe" };
  const candidate = relativePath.length === 0 ? root : resolve(root, ...relativePath.split("/"));
  try {
    const linkStats = await fileSystem.lstat(candidate);
    const real = await fileSystem.realpath(candidate);
    if (!containsPath(root, real)) return { kind: "unsafe" };
    const realRelativePath = relativePathFromNative(root, real);
    if (!eventPathAllowed(realRelativePath, additional)) return { kind: "unsafe" };
    const targetStats = await fileSystem.stat(real);
    const kind = entryKind(linkStats, targetStats);
    return {
      kind: "present",
      metadata: {
        relativePath,
        entryKind: kind,
        sizeBytes: targetStats.sizeBytes,
        modifiedAt: targetStats.modifiedAtMs,
        metadataHash: metadataHash(kind, targetStats),
      },
    };
  } catch (error) {
    return { kind: confirmsAbsence(error) ? "absent" : "unavailable" };
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
    fileSystem: configuredFileSystem(options.fileSystem),
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
  private scanning = false;
  private disposed = false;
  private additionalExclusions: WatchExclusions = NO_EXCLUSIONS;
  private exclusionsInitialized = false;

  public constructor(
    private readonly root: string,
    private readonly config: WatchConfig,
    private readonly onIdleDispose: (root: string) => void,
    private readonly onRevoked: (root: string) => void,
  ) {}

  public subscribe(args: WorkspaceWatchSubscribeArgs): WorkspaceWatchSubscribeResult {
    this.cancelIdleTimer();
    if (!proveRoot(args.reproveRoot, this.root).granted) {
      this.revokeRoot();
      return { kind: "rootUnavailable", snapshot: this.snapshot(true) };
    }
    if (this.subscribers.size >= this.config.maxSubscribersPerRoot) {
      return { kind: "subscriberLimit", snapshot: this.snapshot(true) };
    }
    this.initializeExclusions(args.additionalExclusions);
    // The subscriber is registered BEFORE the watcher starts so that ensureStarted()'s re-proof —
    // and every effect boundary after it — resolves authority from a subscriber set that already
    // contains this caller, instead of from whoever happened to subscribe first (#3347 owner P2).
    const subscriber = this.addSubscriber(args);
    this.ensureStarted();
    if (this.pending.size > 0) this.scheduleFlush();
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

  public isDisposed(): boolean {
    return this.disposed;
  }

  public dispose(): void {
    if (this.disposed) {
      this.clearTimers();
      return;
    }
    this.disposed = true;
    this.clearTimers();
    this.handle?.close();
    this.handle = null;
    this.subscribers.clear();
    this.pending.clear();
    this.health = "stopped";
    this.degradedReasons.add("shutdown");
  }

  // Exclusions are fixed at first-subscribe for the life of the session: the initial baseline scan
  // (seedBaseline, triggered by ensureStarted) is filtered by whatever is set here, so accepting a
  // different value from a later subscriber would leave the seeded `known` map inconsistent with
  // the exclusions applied to subsequent scans. All subscribers for a root resolve the same
  // watcherExclusions setting in practice, so this only matters for the first.
  private initializeExclusions(patterns: readonly string[] | undefined): void {
    if (this.exclusionsInitialized) return;
    this.additionalExclusions = exclusionsFromPatterns(patterns ?? []);
    this.exclusionsInitialized = true;
  }

  private addSubscriber(args: WorkspaceWatchSubscribeArgs): WatchSubscriber {
    this.nextSubscriberId += 1;
    const subscriber = {
      id: this.nextSubscriberId,
      onEvent: args.onEvent,
      reproveRoot: args.reproveRoot,
      onAuthorityRevoked: args.onAuthorityRevoked,
    };
    this.subscribers.set(subscriber.id, subscriber);
    return subscriber;
  }

  private unsubscribe(id: number): void {
    this.subscribers.delete(id);
    if (this.subscribers.size === 0) this.scheduleIdleDispose();
  }

  private ensureStarted(): void {
    if (this.disposed || this.handle !== null || this.pollTimer !== null) return;
    // The native watcher has no WorkspaceFs equivalent, so it is gated by the same fresh re-proof
    // and bound to `this.root` — which proveRoot() has just confirmed is the capability's own
    // canonicalRoot, so the watch cannot be started on a root nobody proved.
    if (!this.ensureLiveRootAuthority()) return;
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
    const proof = this.currentAuthority();
    if (proof === null) {
      this.markUnattendedChange();
      return;
    }
    if (!proof.granted) {
      this.revokeRoot();
      return;
    }
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
    if (this.flushing || !this.ensureLiveRootAuthority()) return;
    this.flushing = true;
    try {
      await this.awaitBaseline();
      while (this.pending.size > 0 && !this.disposed) {
        if (!this.ensureLiveRootAuthority()) return;
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
    const fileSystem = this.effectFileSystem();
    if (fileSystem === null) return;
    const current = await metadataFor(
      this.root,
      change.relativePath,
      this.additionalExclusions,
      fileSystem,
    );
    if (!this.ensureLiveRootAuthority()) return;
    this.applyMetadataResult(change.relativePath, current);
  }

  private async reconcileRename(oldRelativePath: string, relativePath: string): Promise<void> {
    const fileSystem = this.effectFileSystem();
    if (fileSystem === null) return;
    const current = await metadataFor(
      this.root,
      relativePath,
      this.additionalExclusions,
      fileSystem,
    );
    if (!this.ensureLiveRootAuthority()) return;
    if (current.kind !== "present") {
      const reason = current.kind === "unsafe" ? "unsafe-path" : "ambiguous-event";
      this.emitRescan(reason, "rescan");
      if (current.kind === "unavailable") this.startFallbackPolling();
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
    if (result.kind === "unavailable") {
      this.emitRescan("ambiguous-event", "rescan");
      this.startFallbackPolling();
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
    if (next === null || !next.complete || this.disposed || !this.ensureLiveRootAuthority()) {
      return;
    }
    this.known.clear();
    for (const metadata of next.entries.values()) this.known.set(metadata.relativePath, metadata);
  }

  private async scanAndEmitDiff(): Promise<void> {
    if (this.scanning || !this.ensureLiveRootAuthority()) return;
    this.scanning = true;
    try {
      const next = await this.scanTree();
      if (next === null || !next.complete || this.disposed || !this.ensureLiveRootAuthority()) {
        return;
      }
      for (const [path, previous] of this.known)
        if (!next.entries.has(path))
          this.emit(deletedEvent(this.nextSequence(), previous.relativePath));
      for (const metadata of next.entries.values()) this.applyPresent(metadata);
      this.recoverAfterCompleteScan();
    } finally {
      this.scanning = false;
    }
  }

  private async scanTree(): Promise<ScanResult | null> {
    const fileSystem = this.effectFileSystem();
    if (fileSystem === null) return null;
    try {
      const rootStats = await fileSystem.stat(this.root);
      if (!this.ensureLiveRootAuthority()) return null;
      if (!rootStats.isDirectory) return this.rootReplaced();
      return await this.scanDirectory("");
    } catch (error) {
      if (confirmsAbsence(error)) return this.rootReplaced();
      this.emitRescan("ambiguous-event", "rescan");
      this.startFallbackPolling();
      return null;
    }
  }

  // Disk-level detection (the watched path is gone or is no longer a directory) is a distinct
  // condition from caller-authority revocation (reproveRoot rejecting the operation-scoped
  // authority, e.g. a managed workspace being torn down): the former asks the caller to rescan
  // the still-subscribed session, the latter stops it outright. Routing this through revokeRoot
  // collapsed the two and made every disk-level root replacement look like a stopped session
  // (#3347 fallout) — keep this on the pre-existing rescanRequired path instead.
  private rootReplaced(): null {
    this.emitRescan("root-replaced", "rescan");
    return null;
  }

  private async scanDirectory(start: string): Promise<ScanResult> {
    const found = new Map<string, FileMetadata>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() ?? "";
      const result = await this.scanOneDirectory(current, found, queue);
      if (result === "complete") continue;
      this.emitRescan(
        result === "overflow" ? "event-overflow" : "ambiguous-event",
        result === "overflow" ? "overflow" : "rescan",
      );
      this.startFallbackPolling();
      return { entries: found, complete: false };
    }
    return { entries: found, complete: true };
  }

  private async scanOneDirectory(
    relativeDirectory: string,
    found: Map<string, FileMetadata>,
    queue: string[],
  ): Promise<ScanDirectoryResult> {
    const directory =
      relativeDirectory.length === 0 ? this.root : join(this.root, relativeDirectory);
    const fileSystem = this.effectFileSystem();
    if (fileSystem === null) return "unavailable";
    let names: readonly string[];
    try {
      names = await fileSystem.readdirNames(directory);
    } catch {
      return "unavailable";
    }
    if (!this.ensureLiveRootAuthority()) return "unavailable";
    for (const name of names) {
      const outcome = await this.scanDirectoryEntry(relativeDirectory, name, found, queue);
      if (outcome !== "continue") return outcome;
    }
    return "complete";
  }

  private async scanDirectoryEntry(
    relativeDirectory: string,
    name: string,
    found: Map<string, FileMetadata>,
    queue: string[],
  ): Promise<ScanDirectoryResult | "continue"> {
    const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
    if (!eventPathAllowed(relativePath, this.additionalExclusions)) return "continue";
    if (found.size >= this.config.maxScanEntries) return "overflow";
    const fileSystem = this.effectFileSystem();
    if (fileSystem === null) return "unavailable";
    const result = await metadataFor(
      this.root,
      relativePath,
      this.additionalExclusions,
      fileSystem,
    );
    if (!this.ensureLiveRootAuthority()) return "unavailable";
    if (result.kind === "unavailable") return "unavailable";
    if (result.kind !== "present") return "continue";
    found.set(relativePath, result.metadata);
    if (result.metadata.entryKind === "directory") queue.push(relativePath);
    return "continue";
  }

  private startFallbackPolling(): void {
    if (this.disposed || this.pollTimer !== null) return;
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
    const alreadyRequired = this.health === "rescanRequired" && this.degradedReasons.has(reason);
    this.degradedReasons.add(reason);
    this.health = "rescanRequired";
    if (alreadyRequired) return;
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

  private recoverAfterCompleteScan(): void {
    this.degradedReasons.delete("ambiguous-event");
    this.degradedReasons.delete("event-overflow");
    if (this.degradedReasons.has("root-replaced") || this.degradedReasons.has("sequence-gap")) {
      this.health = "rescanRequired";
    } else {
      this.health = this.degradedReasons.size === 0 ? "healthy" : "degraded";
    }
    if (this.handle !== null && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emit(event: EditorM7WatchEvent): void {
    if (this.disposed || !this.ensureLiveRootAuthority()) return;
    this.eventCount += 1;
    this.replay.push(event);
    while (this.replay.length > this.config.replayCapacity) this.replay.shift();
    for (const subscriber of this.subscribers.values()) {
      if (!proveRoot(subscriber.reproveRoot, this.root).granted) {
        subscriber.onAuthorityRevoked?.();
        this.subscribers.delete(subscriber.id);
        continue;
      }
      subscriber.onEvent(event);
    }
  }

  /**
   * Resolves session authority from the CURRENT subscriber set on every effect boundary (#3347
   * review, owner P2). Pinning the first subscriber's resolver for the life of the shared session
   * let a departed subscriber's stale-VALID answer authorize a later subscriber's scanning, and its
   * stale-REVOKED answer tear a later subscriber's otherwise valid watch down.
   *
   * `null` means no current subscriber can speak for this root at all — the idle-retention window
   * between the last unsubscribe and idle teardown. That is an absence of a caller, not a
   * revocation: no effect may run, and the session is left intact for a reconnect.
   */
  private currentAuthority(): RootAuthorityProof | null {
    let denied = false;
    for (const subscriber of this.subscribers.values()) {
      const proof = proveRoot(subscriber.reproveRoot, this.root);
      if (proof.granted) return proof;
      denied = true;
    }
    return denied ? DENIED_ROOT_AUTHORITY : null;
  }

  /**
   * The filesystem this boundary's effect must run on: the re-proved capability when the caller
   * holds one, the injectable seam only when no capability was supplied at all. `null` means "do
   * not touch the filesystem" — either nobody is here to authorize it, or authority was just
   * revoked and the session torn down.
   */
  private effectFileSystem(): WatchEffectFileSystem | null {
    if (this.disposed) return null;
    const proof = this.currentAuthority();
    if (proof === null) return null;
    if (!proof.granted) {
      this.revokeRoot();
      return null;
    }
    return proof.access === undefined
      ? this.config.fileSystem
      : watchEffectsFromCapability(proof.access.fs);
  }

  private ensureLiveRootAuthority(): boolean {
    return this.effectFileSystem() !== null;
  }

  // A native change arrived while no subscriber held authority for this root. Reconciling it under
  // a departed subscriber's grant is exactly the defect currentAuthority() removes, so the change is
  // not reconciled — but it is not dropped silently either: the session is marked rescanRequired so
  // the next subscriber's first snapshot tells it to rescan rather than trust a gap it cannot see.
  private markUnattendedChange(): void {
    this.degradedReasons.add("ambiguous-event");
    this.health = "rescanRequired";
  }

  private revokeRoot(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.handle?.close();
    this.handle = null;
    this.pending.clear();
    this.degradedReasons.add("root-replaced");
    this.health = "rescanRequired";
    const event: EditorM7WatchEvent = {
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      sequence: this.nextSequence(),
      kind: "rescan",
      relativePath: "",
      entryKind: "unknown",
      health: this.health,
      reason: "root-replaced",
    };
    this.eventCount += 1;
    for (const subscriber of this.subscribers.values()) {
      subscriber.onEvent(event);
      subscriber.onAuthorityRevoked?.();
    }
    // Authority is revoked and handles are closed above, but the reported health stays a
    // terminal, tombstoned "rescanRequired" (not "stopped" -- that means deliberate shutdown, see
    // dispose()) so a later snapshot still explains why the watch ended. Scheduling idle-dispose
    // here would let onIdleDispose remove this session from the map after idleTearDownMs, and the
    // next access would then construct a brand-new session defaulting to "healthy", silently
    // erasing the very reason a client needs to see. This session now stays disposed-but-present
    // until an explicitly valid re-subscribe (sessionFor(root, true)) replaces it.
    this.subscribers.clear();
    this.releaseRetainedState();
    this.onRevoked(this.root);
  }

  /**
   * Keeps the tombstone bounded (#3347 review, owner P2). Retaining a revoked session forever turns
   * revocation evidence into unbounded retained state: `known` holds up to `maxScanEntries` metadata
   * records, `replay` a full event ring, and the exclusion sets their resolved patterns. None of it
   * is reachable once the session is terminal — every effect boundary now fails closed — and none of
   * it is part of the explanation a client needs, which is the terminal health, the degraded reasons
   * and the sequence/event counters kept above. So the heavy state is released here rather than held
   * until a valid re-subscribe happens to replace the session.
   */
  private releaseRetainedState(): void {
    this.known.clear();
    this.replay.length = 0;
    this.pending.clear();
    this.additionalExclusions = NO_EXCLUSIONS;
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

/**
 * How many revoked roots may keep a tombstone at once (#3347 review, owner P2).
 *
 * A revoked session stays in the map so a later snapshot still explains why the watch ended, but a
 * multi-root workspace would otherwise accumulate one retained session per revoked root forever.
 * The durable record of every revocation is the `editor.workspace-watch.authority-revoked` activity
 * log line, not this in-memory cache, so evicting the OLDEST tombstone loses no evidence and grants
 * no authority: a re-subscribe re-proves the root from scratch either way.
 */
export const MAX_RETAINED_REVOKED_WATCH_SESSIONS = 32;

interface WatchSessionRegistry {
  readonly sessions: Map<string, WorkspaceWatchSession>;
  readonly revokedRoots: Set<string>;
}

function forgetWatchSession(registry: WatchSessionRegistry, root: string): void {
  registry.sessions.delete(root);
  registry.revokedRoots.delete(root);
}

function retainRevokedWatchSession(registry: WatchSessionRegistry, root: string): void {
  // Delete-then-add so a re-revoked root counts as the newest rather than keeping its old position.
  registry.revokedRoots.delete(root);
  registry.revokedRoots.add(root);
  while (registry.revokedRoots.size > MAX_RETAINED_REVOKED_WATCH_SESSIONS) {
    const oldest = registry.revokedRoots.values().next().value;
    if (oldest === undefined) return;
    registry.revokedRoots.delete(oldest);
    if (registry.sessions.get(oldest)?.isDisposed() === true) registry.sessions.delete(oldest);
  }
}

function watchSessionFor(
  registry: WatchSessionRegistry,
  config: WatchConfig,
  root: string,
  replaceDisposed: boolean,
): WorkspaceWatchSession {
  const existing = registry.sessions.get(root);
  if (existing !== undefined && (!replaceDisposed || !existing.isDisposed())) return existing;
  existing?.dispose();
  forgetWatchSession(registry, root);
  const session = new WorkspaceWatchSession(
    root,
    config,
    (idleRoot) => {
      registry.sessions.get(idleRoot)?.dispose();
      forgetWatchSession(registry, idleRoot);
    },
    (revokedRoot) => {
      retainRevokedWatchSession(registry, revokedRoot);
    },
  );
  registry.sessions.set(root, session);
  return session;
}

export function createWorkspaceWatchService(
  options: WorkspaceWatchServiceOptions = {},
): WorkspaceWatchService {
  const config = configFromOptions(options);
  const registry: WatchSessionRegistry = { sessions: new Map(), revokedRoots: new Set() };
  return {
    subscribe: (args): WorkspaceWatchSubscribeResult =>
      watchSessionFor(registry, config, args.root, true).subscribe(args),
    snapshot: (root): EditorM7WatchSnapshot =>
      watchSessionFor(registry, config, root, false).snapshot(),
    disposeRoot: (root): void => {
      registry.sessions.get(root)?.dispose();
      forgetWatchSession(registry, root);
    },
    disposeAll: (): void => {
      for (const session of registry.sessions.values()) session.dispose();
      registry.sessions.clear();
      registry.revokedRoots.clear();
    },
  };
}
