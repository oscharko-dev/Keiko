import { isValidScopePath } from "@oscharko-dev/keiko-contracts/connected-context";
import { isValidCodingRepositoryGlob } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { visitWorkspaceFiles, type StreamingDiscoveryStats } from "./discovery.js";
import { PathDeniedError, RepoSearchInvalidQueryError } from "./errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { compileIgnore, isDenied, isIgnored } from "./ignore.js";
import { admittedSearchScopeEntry, resolveEntryWalkRoot } from "./repoSearchEntries.js";
import { compileGlob } from "./repoSearchMatchers.js";
import { RetainedAtomHeap } from "./repoSearchRetention.js";
import { workspaceFsBoundToCanonicalRoot } from "./realpath.js";
import {
  executionControlledWorkspaceFs,
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  WORKSPACE_PATH_DISCOVERY_LIMITS,
  WORKSPACE_PATH_DISCOVERY_MODES,
  type DiscoveredFile,
  type WorkspaceInfo,
  type WorkspacePathDiscoveryEntry,
  type WorkspacePathDiscoveryMode,
  type WorkspacePathDiscoveryRequest,
  type WorkspacePathDiscoveryResult,
  type WorkspacePathDiscoveryStats,
  type WorkspacePathDiscoveryTruncationReason,
} from "./types.js";

function validRequestShape(request: unknown): request is Record<string, unknown> {
  if (typeof request !== "object" || request === null) return false;
  const keys = ["mode", "directory", "query", "maxResults"];
  return (
    Object.getPrototypeOf(request) === Object.prototype &&
    Reflect.ownKeys(request).length === keys.length &&
    keys.every((key) => Object.hasOwn(request, key)) &&
    Object.values(Object.getOwnPropertyDescriptors(request)).every((entry) => "value" in entry)
  );
}

function validRequestQuery(mode: unknown, query: unknown): query is string {
  if (typeof query !== "string") return false;
  if (mode === "directory") return query === "*";
  if (mode === "glob") return isValidCodingRepositoryGlob(query);
  return query.trim().length > 0 && query.length <= WORKSPACE_PATH_DISCOVERY_LIMITS.queryChars;
}

function validRequestMode(mode: unknown): mode is WorkspacePathDiscoveryMode {
  const modes: readonly string[] = WORKSPACE_PATH_DISCOVERY_MODES;
  return typeof mode === "string" && modes.includes(mode);
}

function validRequestDirectory(directory: unknown): directory is string {
  return (
    typeof directory === "string" &&
    (directory === "" || isValidScopePath(directory, { mustBeRelative: true }))
  );
}

function validResultCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= WORKSPACE_PATH_DISCOVERY_LIMITS.maxResults
  );
}

function validateRequest(request: unknown): WorkspacePathDiscoveryRequest {
  if (!validRequestShape(request)) {
    throw new RepoSearchInvalidQueryError("Invalid workspace path discovery request.");
  }
  const { mode, directory, query, maxResults } = request;
  if (
    !validRequestMode(mode) ||
    !validRequestDirectory(directory) ||
    !validRequestQuery(mode, query) ||
    !validResultCount(maxResults)
  )
    throw new RepoSearchInvalidQueryError("Invalid workspace path discovery request.");
  return Object.freeze({ mode, directory, query, maxResults });
}

function admittedDirectoryFs(
  workspace: WorkspaceInfo,
  directory: string,
  fs: WorkspaceFs,
): WorkspaceFs {
  if (resolveEntryWalkRoot(fs, workspace.root) !== workspace.root) {
    throw new PathDeniedError("Workspace root changed before discovery.", ".");
  }
  const bound = workspaceFsBoundToCanonicalRoot(fs, workspace.root);
  if (directory === "") return bound;
  if (isDenied(directory) || isIgnored(compileIgnore(workspace.ignoreLines), directory, true)) {
    throw new PathDeniedError("Selected discovery directory is excluded.", ".");
  }
  const entry = admittedSearchScopeEntry(bound, workspace.root, directory);
  if (entry?.stat.isDirectory !== true) {
    throw new RepoSearchInvalidQueryError("Selected discovery directory is unavailable.");
  }
  return bound;
}

function pathMatcher(request: WorkspacePathDiscoveryRequest): (path: string) => boolean {
  if (request.mode === "glob") {
    const glob = compileGlob(request.query);
    return (path) => glob.test(path);
  }
  if (request.query === "*") return () => true;
  const terms = request.query
    .toLowerCase()
    .split(/[\s/_.-]+/u)
    .filter(Boolean);
  if (terms.length === 0) throw new RepoSearchInvalidQueryError("Discovery keywords are empty.");
  return (path) => {
    const lower = path.toLowerCase();
    return terms.every((term) => lower.includes(term));
  };
}

function pathDiscoveryStats(stats: StreamingDiscoveryStats): WorkspacePathDiscoveryStats {
  return {
    filesDiscovered: stats.filesDiscovered,
    directoriesDiscovered: stats.directoriesDiscovered ?? 0,
    directoriesPruned: stats.directoriesPruned ?? 0,
    denied: stats.denied,
    ignored: stats.ignored,
    ioErrors: stats.ioErrors,
    unrepresentablePaths: stats.unrepresentablePaths ?? 0,
  };
}

function coverageReasons(
  stats: WorkspacePathDiscoveryStats,
  timedOut: boolean,
): WorkspacePathDiscoveryTruncationReason[] {
  const reasons: WorkspacePathDiscoveryTruncationReason[] = [];
  if (stats.directoriesPruned > 0) reasons.push("directory-limit");
  if (stats.ioErrors > 0) reasons.push("io-error");
  if (timedOut) reasons.push("time-limit");
  if (stats.unrepresentablePaths > 0) reasons.push("unrepresentable-path");
  return reasons;
}

function projectDiscoveryResult(
  retained: RetainedAtomHeap<WorkspacePathDiscoveryEntry>,
  matchedCount: number,
  stats: WorkspacePathDiscoveryStats,
  timedOut: boolean,
): WorkspacePathDiscoveryResult {
  const entries = [...retained.sorted()];
  const reasons = coverageReasons(stats, timedOut);
  if (matchedCount > entries.length) reasons.unshift("result-limit");
  let text = JSON.stringify(entries);
  while (Buffer.byteLength(text) > WORKSPACE_PATH_DISCOVERY_LIMITS.outputBytes) {
    entries.pop();
    text = JSON.stringify(entries);
    if (!reasons.includes("output-limit")) reasons.push("output-limit");
  }
  return {
    entries,
    text,
    byteCount: Buffer.byteLength(text),
    matchedCount,
    coverageIncomplete: reasons.length > 0,
    truncationReasons: reasons,
    stats,
  };
}

interface PathDiscoveryCollector {
  readonly onFile: (file: DiscoveredFile) => Promise<void>;
  readonly onDirectory: (file: DiscoveredFile) => Promise<void>;
  readonly onStats: (stats: StreamingDiscoveryStats) => void;
}

async function streamDiscovery(
  workspace: WorkspaceInfo,
  request: WorkspacePathDiscoveryRequest,
  control: StructuralExecutionControl,
  fs: WorkspaceFs,
  collector: PathDiscoveryCollector,
): Promise<boolean> {
  try {
    const controlled = executionControlledWorkspaceFs(fs, control);
    const admitted = admittedDirectoryFs(workspace, request.directory, controlled);
    await visitWorkspaceFiles(
      workspace,
      request.directory === "" ? [] : [request.directory],
      true,
      admitted,
      control,
      { onFile: collector.onFile, onStats: collector.onStats },
      {
        recursive: request.mode !== "directory",
        boundPendingDirectories: true,
        onDirectory: collector.onDirectory,
      },
    );
    return false;
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError && error.reason === "timeout") return true;
    throw error;
  }
}

/** Path-only streaming discovery with bounded results and caller-owned execution control. */
export async function discoverWorkspacePaths(
  workspace: WorkspaceInfo,
  request: unknown,
  control: StructuralExecutionControl,
  fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<WorkspacePathDiscoveryResult> {
  const selected = validateRequest(request);
  const matches = pathMatcher(selected);
  const retained = new RetainedAtomHeap<WorkspacePathDiscoveryEntry>(
    selected.maxResults,
    (left, right) => compareStrings(left.relativePath, right.relativePath),
  );
  let matchedCount = 0;
  let stats = pathDiscoveryStats({ filesDiscovered: 0, ignored: 0, denied: 0, ioErrors: 0 });
  const retain = (
    file: DiscoveredFile,
    kind: WorkspacePathDiscoveryEntry["kind"],
  ): Promise<void> => {
    if (matches(file.relativePath)) {
      matchedCount += 1;
      retained.retain({ ...file, kind });
    }
    return Promise.resolve();
  };
  const timedOut = await streamDiscovery(workspace, selected, control, fs, {
    onFile: (file) => retain(file, "file"),
    onDirectory: (file) =>
      selected.mode === "directory" ? retain(file, "directory") : Promise.resolve(),
    onStats: (value) => {
      stats = pathDiscoveryStats(value);
    },
  });
  return projectDiscoveryResult(retained, matchedCount, stats, timedOut);
}
