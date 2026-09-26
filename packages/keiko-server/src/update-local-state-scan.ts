import { lstatSync, opendirSync, type Dir } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { UpdateCompatibilityScan, UpdateStateStore } from "@oscharko-dev/keiko-contracts";
import { UPDATE_STATE_STORES } from "@oscharko-dev/keiko-contracts/runtime/update-local-state";

export type ArtifactCategory =
  | "lifecycle"
  | "launcher"
  | "ui-database"
  | "gateway-config"
  | "credential-vault"
  | "memory-vault"
  | "local-knowledge"
  | "evidence"
  | "quality-intelligence"
  | "update-recovery";

export interface ArtifactNode {
  readonly relPath: string;
  readonly absPath: string;
  readonly category: ArtifactCategory;
}

export interface RetainedNode {
  readonly relPath: string;
  readonly owned: boolean;
  readonly category?: ArtifactCategory | undefined;
}

interface StateScanResult {
  readonly status: UpdateCompatibilityScan["stateDirStatus"];
  readonly files: readonly ArtifactNode[];
  readonly directories: readonly ArtifactNode[];
  readonly retained: readonly RetainedNode[];
}

export type StateScanLimit = "entry-count" | "depth" | "relative-path-bytes" | "elapsed-time";

export type StateScan = StateScanResult &
  (
    | { readonly completion: "complete" }
    | { readonly completion: "incomplete"; readonly limit: StateScanLimit }
  );

interface StateScanOptions {
  readonly maxEntries?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxRelativePathBytes?: number | undefined;
  readonly maxDurationMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface ScanLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxRelativePathBytes: number;
  readonly maxDurationMs: number;
}

interface WalkAcc {
  files: ArtifactNode[];
  directories: ArtifactNode[];
  retained: RetainedNode[];
  limit?: StateScanLimit | undefined;
  entries: number;
}

interface WalkContext {
  readonly limits: ScanLimits;
  readonly startedAt: number;
  readonly now: () => number;
}

export const UPDATE_DIR = "updates";

const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxEntries: 50_000,
  maxDepth: 64,
  maxRelativePathBytes: 4_096,
  maxDurationMs: 250,
};

const SCAN_LIMIT_LABELS: Readonly<Record<StateScanLimit, string>> = {
  "entry-count": "entry-count",
  depth: "depth",
  "relative-path-bytes": "relative-path-size",
  "elapsed-time": "elapsed-time",
};

export const CATEGORY_STORE: Readonly<Record<ArtifactCategory, UpdateStateStore>> = {
  lifecycle: "server-runtime",
  launcher: "server-runtime",
  "ui-database": "ui-layout",
  "gateway-config": "durable-config",
  "credential-vault": "durable-config",
  "memory-vault": "memory-vault",
  "local-knowledge": "local-knowledge",
  evidence: "evidence",
  "quality-intelligence": "evidence",
  "update-recovery": "server-runtime",
};

const STORE_ALIASES: Readonly<Record<UpdateStateStore, readonly string[]>> = {
  "ui-layout": ["ui", "ui-layout", "ui-database", "workspace-layout", "browser-ui"],
  "server-runtime": ["server-runtime", "runtime", "lifecycle", "launcher", "updates"],
  "durable-config": ["durable-config", "gateway-config", "config", "credentials"],
  evidence: ["evidence", "audit", "quality-intelligence", "qi"],
  "memory-vault": ["memory", "memory-vault", "memoriaviva"],
  "local-knowledge": ["local-knowledge", "knowledge", "local knowledge"],
  "workspace-references": ["workspace", "workspace-references", "repository-context"],
  "package-install": ["package", "install", "package-install", "npm", "yarn"],
};

export function canonicalStore(value: string): UpdateStateStore | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return UPDATE_STATE_STORES.find(
    (store) => store === normalized || STORE_ALIASES[store].includes(normalized),
  );
}

function rootFileCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "ui.pid" || relPath === "ui.log") return "lifecycle";
  if (relPath === "launcher-state.json" || relPath.startsWith(".launcher-state-"))
    return "launcher";
  if (relPath === "keiko.config.json") return "gateway-config";
  if (relPath === "keiko-ui.db" || relPath.startsWith("keiko-ui.db-")) return "ui-database";
  return undefined;
}

function knownStateSubtreeCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "credentials" || relPath.startsWith("credentials/")) return "credential-vault";
  if (relPath === "memory" || relPath.startsWith("memory/")) return "memory-vault";
  if (relPath === "local-knowledge" || relPath.startsWith("local-knowledge/")) {
    return "local-knowledge";
  }
  if (relPath === UPDATE_DIR || relPath.startsWith(`${UPDATE_DIR}/`)) return "update-recovery";
  return undefined;
}

function evidenceCategory(relPath: string): ArtifactCategory | undefined {
  if (relPath === "evidence") return "evidence";
  if (relPath.startsWith("evidence/qi/")) return "quality-intelligence";
  if (relPath.startsWith("evidence/figma/")) return "credential-vault";
  if (relPath.startsWith("evidence/")) return "evidence";
  return undefined;
}

function topCategory(relPath: string): ArtifactCategory | undefined {
  return (
    rootFileCategory(relPath) ?? knownStateSubtreeCategory(relPath) ?? evidenceCategory(relPath)
  );
}

function childPath(relDir: string, name: string): string {
  return relDir.length === 0 ? name : `${relDir}/${name}`;
}

function isInspectableFsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["EACCES", "ENOENT", "EIO", "EPERM"].includes(String(error.code));
}

function retainedNode(relPath: string, category: ArtifactCategory | undefined): RetainedNode {
  return { relPath, owned: category !== undefined, category };
}

function retainUnreadable(
  relPath: string,
  category: ArtifactCategory | undefined,
  acc: { retained: RetainedNode[] },
): void {
  acc.retained.push(retainedNode(relPath.length === 0 ? "." : relPath, category));
}

function openDirectory(absDir: string, relDir: string, acc: WalkAcc): Dir | undefined {
  try {
    return opendirSync(absDir);
  } catch (error) {
    if (!isInspectableFsError(error)) throw error;
    retainUnreadable(relDir, topCategory(relDir), acc);
    return undefined;
  }
}

function scanLimits(options: StateScanOptions): ScanLimits {
  return {
    maxEntries: options.maxEntries ?? DEFAULT_SCAN_LIMITS.maxEntries,
    maxDepth: options.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth,
    maxRelativePathBytes: options.maxRelativePathBytes ?? DEFAULT_SCAN_LIMITS.maxRelativePathBytes,
    maxDurationMs: options.maxDurationMs ?? DEFAULT_SCAN_LIMITS.maxDurationMs,
  };
}

function stopScan(acc: WalkAcc, limit: StateScanLimit): void {
  acc.limit ??= limit;
}

function durationExhausted(acc: WalkAcc, context: WalkContext): boolean {
  if (context.now() - context.startedAt < context.limits.maxDurationMs) return false;
  stopScan(acc, "elapsed-time");
  return true;
}

function inspectedStat(
  absPath: string,
  relPath: string,
  category: ArtifactCategory | undefined,
  acc: WalkAcc,
  context: WalkContext,
): ReturnType<typeof lstatSync> | undefined {
  if (durationExhausted(acc, context)) return undefined;
  try {
    return lstatSync(absPath);
  } catch (error) {
    if (!isInspectableFsError(error)) throw error;
    retainUnreadable(relPath, category, acc);
    return undefined;
  }
}

function visitStateNode(
  absPath: string,
  relPath: string,
  depth: number,
  acc: WalkAcc,
  context: WalkContext,
): void {
  const category = topCategory(relPath);
  const stat = inspectedStat(absPath, relPath, category, acc, context);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    acc.retained.push(retainedNode(relPath, category));
    return;
  }
  if (stat.isDirectory()) {
    if (category === undefined) {
      acc.retained.push({ relPath, owned: false });
      return;
    }
    acc.directories.push({ relPath, absPath, category });
    if (depth >= context.limits.maxDepth) {
      stopScan(acc, "depth");
      return;
    }
    walkState(absPath, relPath, depth + 1, acc, context);
    return;
  }
  if (stat.isFile() && category !== undefined && stat.nlink <= 1) {
    acc.files.push({ relPath, absPath, category });
    return;
  }
  acc.retained.push(retainedNode(relPath, category));
}

function readDirectoryEntry(directory: Dir, relDir: string, acc: WalkAcc): string | undefined {
  try {
    return directory.readSync()?.name;
  } catch (error) {
    if (!isInspectableFsError(error)) throw error;
    retainUnreadable(relDir, topCategory(relDir), acc);
    return undefined;
  }
}

function walkState(
  absDir: string,
  relDir: string,
  depth: number,
  acc: WalkAcc,
  context: WalkContext,
): void {
  if (durationExhausted(acc, context)) return;
  const directory = openDirectory(absDir, relDir, acc);
  if (directory === undefined) return;
  try {
    while (acc.limit === undefined && !durationExhausted(acc, context)) {
      const name = readDirectoryEntry(directory, relDir, acc);
      if (name === undefined) return;
      if (acc.entries >= context.limits.maxEntries) {
        stopScan(acc, "entry-count");
        return;
      }
      acc.entries += 1;
      const relPath = childPath(relDir, name);
      if (Buffer.byteLength(relPath, "utf8") > context.limits.maxRelativePathBytes) {
        stopScan(acc, "relative-path-bytes");
        return;
      }
      visitStateNode(join(absDir, name), relPath, depth, acc, context);
    }
  } finally {
    directory.closeSync();
  }
}

function resultFromAcc(status: StateScan["status"], acc: WalkAcc): StateScan {
  const result = {
    status,
    files: acc.files,
    directories: acc.directories,
    retained: acc.retained,
  };
  return acc.limit === undefined
    ? { ...result, completion: "complete" }
    : { ...result, completion: "incomplete", limit: acc.limit };
}

function emptyScan(status: StateScan["status"]): StateScan {
  return { status, completion: "complete", files: [], directories: [], retained: [] };
}

export function incompleteScanWarning(scan: StateScan): string | undefined {
  if (scan.completion === "complete") return undefined;
  return `Runtime state scan stopped after reaching the ${SCAN_LIMIT_LABELS[scan.limit]} safety limit; partial traversal requires manual review.`;
}

export function scanStateDir(stateDir: string, options: StateScanOptions = {}): StateScan {
  try {
    const root = lstatSync(stateDir);
    if (root.isSymbolicLink()) return emptyScan("symlink");
    if (!root.isDirectory()) return emptyScan("not-directory");
    const acc = {
      files: [] as ArtifactNode[],
      directories: [] as ArtifactNode[],
      retained: [] as RetainedNode[],
      entries: 0,
    };
    const now = options.now ?? performance.now.bind(performance);
    const context = { limits: scanLimits(options), startedAt: now(), now };
    walkState(stateDir, "", 0, acc, context);
    return resultFromAcc("directory", acc);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return emptyScan("absent");
    }
    throw error;
  }
}
