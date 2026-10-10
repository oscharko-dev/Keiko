import { posix as path } from "node:path";
import { readWorkspaceFile } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import {
  gatherCandidates,
  limitCandidateSetForStructuralBuild,
  probeBinary,
  type CandidateSet,
} from "./repoSearchScan.js";
import {
  createStructuralExecutionControl,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";

export interface SourceFile {
  readonly scopePath: string;
  readonly text: string;
}

export interface EndpointSourceFileSet {
  readonly files: readonly SourceFile[];
  readonly filesSkipped: number;
  readonly candidateLimitReached: boolean;
}

export interface EndpointSourceReadDeps {
  readonly readSource?: ((scopePath: string, maxBytes: number) => string) | undefined;
  readonly isCandidateAllowed?: ((scopePath: string) => boolean) | undefined;
}

const CLIENT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function isEndpointSource(scopePath: string): boolean {
  const ext = path.extname(scopePath).toLowerCase();
  return ext === ".java" || CLIENT_EXTENSIONS.has(ext);
}

function endpointReadStopped(
  scopePath: string,
  control: StructuralExecutionControl,
  deps: EndpointSourceReadDeps,
): boolean {
  return structuralExecutionStopped(control) || deps.isCandidateAllowed?.(scopePath) === false;
}

function endpointText(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  scopePath: string,
  deps: EndpointSourceReadDeps,
): string {
  return deps.readSource === undefined
    ? readWorkspaceFile(scope.workspace, scopePath, { maxBytes: limits.maxBytesPerFileScanned }, fs)
        .text
    : deps.readSource(scopePath, limits.maxBytesPerFileScanned);
}

async function readEndpointSource(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  scopePath: string,
  control: StructuralExecutionControl,
  deps: EndpointSourceReadDeps,
): Promise<SourceFile | undefined> {
  try {
    if (endpointReadStopped(scopePath, control, deps)) return undefined;
    const absolute = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolute);
    if (!isCanonicalAllowedContainedPath(contained, scope.workspace.root, scopePath)) {
      return undefined;
    }
    const stat = fs.stat(contained.path);
    if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) return undefined;
    if (endpointReadStopped(scopePath, control, deps)) return undefined;
    if (await probeBinary(fs, contained.path, stat.size)) return undefined;
    if (endpointReadStopped(scopePath, control, deps)) return undefined;
    const text = endpointText(scope, limits, fs, scopePath, deps);
    if (structuralExecutionStopped(control)) return undefined;
    return { scopePath, text };
  } catch {
    return undefined;
  }
}

export async function endpointSourceFiles(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
): Promise<readonly SourceFile[]> {
  return endpointSourceFilesFromCandidates(scope, limits, fs, gatherCandidates(scope, limits, fs));
}

export async function endpointSourceFilesFromCandidates(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidateSet: CandidateSet,
): Promise<readonly SourceFile[]> {
  return (await endpointSourceFileSetFromCandidates(scope, limits, fs, candidateSet)).files;
}

export async function endpointSourceFileSetFromCandidates(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidateSet: CandidateSet,
  executionControl?: StructuralExecutionControl,
  deps: EndpointSourceReadDeps = {},
): Promise<EndpointSourceFileSet> {
  const out: SourceFile[] = [];
  const boundedCandidates = limitCandidateSetForStructuralBuild(candidateSet, limits, (file) =>
    isEndpointSource(file.relativePath),
  );
  const candidates = boundedCandidates.files.map((file) => file.relativePath);
  const control =
    executionControl ?? createStructuralExecutionControl(limits.elapsedMsMax, Date.now);
  let filesSkipped = 0;
  let executionTruncated = false;
  for (const scopePath of candidates) {
    if (structuralExecutionStopped(control)) {
      executionTruncated = true;
      break;
    }
    const file = await readEndpointSource(scope, limits, fs, scopePath, control, deps);
    if (structuralExecutionStopped(control)) {
      executionTruncated = true;
      break;
    }
    if (file === undefined) filesSkipped += 1;
    else out.push(file);
  }
  return {
    files: out,
    filesSkipped,
    candidateLimitReached: boundedCandidates.truncated || executionTruncated,
  };
}
