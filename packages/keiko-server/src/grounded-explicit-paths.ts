import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPathWithinSelectedScope,
  isValidScopePath,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import {
  extractPathReferences,
  isGeneratedRankingPath,
  type SearchReference,
} from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  PathDeniedError,
  discoverWorkspacePaths,
  PathEscapeError,
  RepoSearchUnsupportedFileError,
  compileIgnore,
  containedRealPathInfo,
  findFiles,
  isDenied,
  isGeneratedArtifactPath,
  isIgnored,
  readExcerpt,
  resolveWithinWorkspace,
  type SearchResult,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { isCanonicalAllowedContainedPath } from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import { safeProperty } from "@oscharko-dev/keiko-activity-log";
import {
  isExtractableConnectedDocumentPath,
  isConnectedDocumentPath,
} from "./grounded-document-evidence.js";

export const EXPLICIT_PATH_REJECTION_REASONS = [
  "outside-scope",
  "denied",
  "missing",
  "ignored",
  "generated",
  "binary",
  "size-exceeded",
  "unsupported-format",
] as const;
export type ExplicitPathRejectionReason = (typeof EXPLICIT_PATH_REJECTION_REASONS)[number];

export type ExplicitPathReference = SearchReference;

export interface ExplicitPathObservation {
  readonly explicitPathAnchorCount: number;
  readonly explicitPathAdmittedCount: number;
  readonly explicitPathRejectedCount: number;
  readonly explicitPathRejectionReasons: readonly ExplicitPathRejectionReason[];
  readonly explicitLineHintCount: number;
  readonly basenameDiscoveryTermCount: number;
  readonly basenameDiscoveryMatchCount: number;
}

export interface ExplicitPathAdmission {
  readonly selections: readonly ExplicitPathReference[];
  readonly rejectedPaths: ReadonlySet<string>;
  readonly omitted: readonly OmittedContextEntry[];
  readonly observation: ExplicitPathObservation;
}

interface AdmissionInputs {
  readonly scope: SelectedScope;
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly references?: readonly ExplicitPathReference[] | undefined;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal | undefined;
  readonly tryReserveSearchCall: () => boolean;
}

interface AdmissionState {
  readonly selections: ExplicitPathReference[];
  readonly rejectedPaths: Set<string>;
  readonly omitted: OmittedContextEntry[];
  readonly reasons: Set<ExplicitPathRejectionReason>;
  readonly seen: Set<string>;
  anchorCount: number;
  rejectedCount: number;
  basenameTerms: number;
  basenameMatches: number;
}

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS);
const BASENAME_MATCH_CAP = 96;

export function explicitPathReferences(text: string): readonly ExplicitPathReference[] {
  return extractPathReferences(text);
}

export function normalizedExplicitReferencePath(
  reference: ExplicitPathReference,
  root: string,
): string | undefined {
  let path = reference.path;
  if (path.startsWith("file://")) {
    if (!URL.canParse(path)) return undefined;
    const url = new URL(path);
    if (url.hostname !== "" && url.hostname !== "localhost") return undefined;
    path = localFileUrlPath(url) ?? "";
  }
  if (isAbsolute(path)) path = relative(root, path);
  return isValidScopePath(path, { mustBeRelative: true }) ? path : undefined;
}

function localFileUrlPath(url: URL): string | undefined {
  try {
    return fileURLToPath(url);
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return undefined;
    throw error;
  }
}

function expectedPathFailure(error: unknown): ExplicitPathRejectionReason | undefined {
  if (error instanceof PathDeniedError) return "denied";
  const code = safeProperty(error, "code") ?? safeProperty(safeProperty(error, "cause"), "code");
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return code === "EACCES" || code === "EPERM" ? "denied" : undefined;
}

function pathPolicyRejection(
  path: string,
  inputs: AdmissionInputs,
): ExplicitPathRejectionReason | undefined {
  if (!isPathWithinSelectedScope(inputs.scope, new Set(inputs.scope.relativePaths), path))
    return "outside-scope";
  if (isDenied(path)) return "denied";
  if (
    !humanSelectedPath(path, inputs) &&
    (isGeneratedArtifactPath(path) || isGeneratedRankingPath(path))
  )
    return "generated";
  if (
    !humanSelectedPath(path, inputs) &&
    isIgnored(compileIgnore(inputs.searchScope.workspace.ignoreLines), path, false)
  )
    return "ignored";
  const absolute = resolveWithinWorkspace(inputs.searchScope.workspace.root, path);
  if (!inputs.fs.exists(absolute)) return "missing";
  try {
    return existingPathPolicyRejection(path, absolute, inputs);
  } catch (error) {
    const reason = expectedPathFailure(error);
    if (reason !== undefined) return reason;
    throw error;
  }
}

function humanSelectedPath(path: string, inputs: AdmissionInputs): boolean {
  return (
    inputs.scope.explicitConnection === true &&
    inputs.scope.kind === "files" &&
    inputs.scope.relativePaths.includes(path)
  );
}

function existingPathPolicyRejection(
  path: string,
  absolute: string,
  inputs: AdmissionInputs,
): ExplicitPathRejectionReason | undefined {
  const contained = explicitContainedPath(inputs, absolute);
  if (contained === undefined) return "outside-scope";
  if (isDenied(contained.realRelative)) return "denied";
  if (!isCanonicalAllowedContainedPath(contained, inputs.searchScope.workspace.root, path))
    return "outside-scope";
  const stat = inputs.fs.stat(contained.path);
  if (!stat.isFile || stat.isSymbolicLink || (stat.hardLinkCount ?? 1) > 1) return "outside-scope";
  if (stat.size > DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned) return "size-exceeded";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (isConnectedDocumentPath(path) && !DOCUMENT_EXTENSIONS.has(extension))
    return "unsupported-format";
  return undefined;
}

function explicitContainedPath(
  inputs: AdmissionInputs,
  absolute: string,
): ReturnType<typeof containedRealPathInfo> | undefined {
  try {
    return containedRealPathInfo(inputs.fs, inputs.searchScope.workspace.root, absolute);
  } catch (error) {
    if (error instanceof PathEscapeError) return undefined;
    throw error;
  }
}

function rejectionReason(result: SearchResult, path: string): ExplicitPathRejectionReason {
  const reason = result.candidates.find((candidate) => candidate.scopePath === path)?.omitted;
  return reason === "binary" ||
    reason === "size-exceeded" ||
    reason === "ignored" ||
    reason === "generated" ||
    reason === "outside-scope"
    ? reason
    : "missing";
}

async function findExplicitFiles(
  inputs: AdmissionInputs,
  pattern: string,
  relativePaths: readonly string[],
  maxMatches: number,
): Promise<SearchResult> {
  return findFiles(
    { ...inputs.searchScope, relativePaths },
    {
      ...inputs.query,
      kind: "file-pattern",
      text: pattern,
      caseSensitive: true,
      maxResults: maxMatches,
    },
    { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: maxMatches },
    {
      fs: inputs.fs,
      nowMs: inputs.nowMs,
      deadlineAtMs: inputs.deadlineAtMs,
      ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    },
  );
}

function rejectPath(
  state: AdmissionState,
  path: string | undefined,
  reason: ExplicitPathRejectionReason,
  nowMs: number,
): void {
  state.rejectedCount += 1;
  state.reasons.add(reason);
  if (path === undefined) return;
  state.rejectedPaths.add(path);
  // Missing and denied paths are not corpus entries, and never become manifest paths.
  if (reason === "missing" || reason === "denied" || reason === "outside-scope") return;
  state.omitted.push({ scopePath: path, reason, omittedAtMs: nowMs });
}

function recordUnread(state: AdmissionState, path: string, nowMs: number): void {
  state.omitted.push({ scopePath: path, reason: "budget-exhausted", omittedAtMs: nowMs });
}

async function admitReference(
  reference: ExplicitPathReference,
  inputs: AdmissionInputs,
  state: AdmissionState,
  classified = false,
): Promise<void> {
  const path = normalizedExplicitReferencePath(reference, inputs.searchScope.workspace.root);
  const identity = `${path ?? reference.path}:${String(reference.line ?? "")}`;
  if (state.seen.has(identity)) return;
  state.seen.add(identity);
  state.anchorCount += 1;
  if (path === undefined) {
    rejectPath(state, path, "outside-scope", inputs.nowMs());
    return;
  }
  const reason =
    pathPolicyRejection(path, inputs) ?? (await classifiedPathRejection(path, inputs, classified));
  if (reason === "budget-exhausted") {
    recordUnread(state, path, inputs.nowMs());
    return;
  }
  if (reason !== undefined) {
    rejectPath(state, path, reason, inputs.nowMs());
    return;
  }
  state.selections.push({ ...reference, path });
}

async function classifiedPathRejection(
  path: string,
  inputs: AdmissionInputs,
  classified: boolean,
): Promise<ExplicitPathRejectionReason | "budget-exhausted" | undefined> {
  if (classified || isConnectedDocumentPath(path)) return undefined;
  if (!inputs.tryReserveSearchCall()) return "budget-exhausted";
  if (humanSelectedPath(path, inputs)) return classifyHumanSelectedFile(path, inputs);
  const result = await findExplicitFiles(inputs, path, [path], 1);
  return result.atoms.some((atom) => atom.scopePath === path)
    ? undefined
    : rejectionReason(result, path);
}

async function classifyHumanSelectedFile(
  path: string,
  inputs: AdmissionInputs,
): Promise<ExplicitPathRejectionReason | undefined> {
  try {
    await readExcerpt(
      inputs.searchScope,
      {
        scopePath: path,
        startLine: 1,
        endLine: 1,
        maxBytes: 1,
      },
      {
        fs: inputs.fs,
        nowMs: inputs.nowMs,
        deadlineAtMs: inputs.deadlineAtMs,
        ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
      },
    );
    return undefined;
  } catch (error) {
    if (error instanceof FileTooLargeError) return "size-exceeded";
    if (error instanceof RepoSearchUnsupportedFileError && error.reason === "binary")
      return "binary";
    throw error;
  }
}

async function documentBasenamePaths(
  reference: ExplicitPathReference,
  inputs: AdmissionInputs,
): Promise<readonly string[]> {
  if (inputs.scope.kind === "files")
    return inputs.scope.relativePaths.filter((path) => path.split("/").at(-1) === reference.path);
  const directories = inputs.scope.kind === "directory" ? inputs.scope.relativePaths : [""];
  const paths = new Set<string>();
  for (const [index, directory] of directories.entries()) {
    if (index > 0 && !inputs.tryReserveSearchCall()) break;
    const result = await discoverWorkspacePaths(
      inputs.searchScope.workspace,
      {
        mode: "glob",
        directory,
        query: `**/${reference.path}`,
        maxResults: BASENAME_MATCH_CAP,
      },
      { nowMs: inputs.nowMs, deadlineAtMs: inputs.deadlineAtMs, signal: inputs.signal },
      inputs.fs,
    );
    for (const entry of result.entries) if (entry.kind === "file") paths.add(entry.relativePath);
  }
  return [...paths].sort().slice(0, BASENAME_MATCH_CAP);
}

async function basenamePaths(
  reference: ExplicitPathReference,
  inputs: AdmissionInputs,
): Promise<ReadonlySet<string>> {
  if (isExtractableConnectedDocumentPath(reference.path))
    return new Set(await documentBasenamePaths(reference, inputs));
  const result = await findExplicitFiles(
    inputs,
    `**/${reference.path}`,
    inputs.searchScope.relativePaths,
    BASENAME_MATCH_CAP,
  );
  return new Set(result.atoms.map((atom) => atom.scopePath));
}

async function admitBasename(
  reference: ExplicitPathReference,
  inputs: AdmissionInputs,
  state: AdmissionState,
): Promise<void> {
  state.basenameTerms += 1;
  if (!inputs.tryReserveSearchCall()) return;
  const paths = new Set(await basenamePaths(reference, inputs));
  for (const path of inputs.scope.relativePaths) {
    if (humanSelectedPath(path, inputs) && path.split("/").at(-1) === reference.path)
      paths.add(path);
  }
  state.basenameMatches += paths.size;
  for (const path of paths)
    await admitReference({ ...reference, path }, inputs, state, !humanSelectedPath(path, inputs));
}

function observation(state: AdmissionState): ExplicitPathObservation {
  return {
    explicitPathAnchorCount: state.anchorCount,
    explicitPathAdmittedCount: new Set(state.selections.map((selection) => selection.path)).size,
    explicitPathRejectedCount: state.rejectedCount,
    explicitPathRejectionReasons: EXPLICIT_PATH_REJECTION_REASONS.filter((reason) =>
      state.reasons.has(reason),
    ),
    explicitLineHintCount: state.selections.filter((selection) => selection.line !== undefined)
      .length,
    basenameDiscoveryTermCount: state.basenameTerms,
    basenameDiscoveryMatchCount: state.basenameMatches,
  };
}

export async function admitExplicitPaths(inputs: AdmissionInputs): Promise<ExplicitPathAdmission> {
  const state: AdmissionState = {
    selections: [],
    rejectedPaths: new Set(),
    omitted: [],
    reasons: new Set(),
    seen: new Set(),
    anchorCount: 0,
    rejectedCount: 0,
    basenameTerms: 0,
    basenameMatches: 0,
  };
  const references = inputs.references ?? explicitPathReferences(inputs.query.text);
  for (const reference of references) {
    if (inputs.signal?.aborted === true || inputs.nowMs() >= inputs.deadlineAtMs) break;
    if (!reference.path.includes("/") && !isDenied(reference.path))
      await admitBasename(reference, inputs, state);
    else await admitReference(reference, inputs, state);
  }
  return {
    selections: state.selections,
    rejectedPaths: state.rejectedPaths,
    omitted: state.omitted,
    observation: observation(state),
  };
}
