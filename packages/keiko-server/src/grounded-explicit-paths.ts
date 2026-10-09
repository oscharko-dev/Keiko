import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPathWithinSelectedScope,
  isValidScopePath,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import { extractAnchors, isGeneratedRankingPath } from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  PathEscapeError,
  RepoSearchUnsupportedFileError,
  compileIgnore,
  containedRealPathInfo,
  findFiles,
  isDenied,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
  isIgnored,
  readExcerpt,
  resolveWithinWorkspace,
  type SearchResult,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { isCanonicalAllowedContainedPath } from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import { isConnectedDocumentPath } from "./grounded-document-evidence.js";

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

export interface ExplicitPathReference {
  readonly path: string;
  readonly line?: number;
  readonly origin: "query" | "assistant" | "diagnostic";
}

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
  readonly references?: readonly ExplicitPathReference[];
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

const KNOWN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS);
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS);
const BASENAME_MATCH_CAP = 96;

function knownFilename(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (
    KNOWN_TEXT_EXTENSIONS.has(extension) ||
    DOCUMENT_EXTENSIONS.has(extension) ||
    isEcosystemSourceFile(path) ||
    isConnectedDocumentPath(path)
  );
}

function pathReference(term: string): ExplicitPathReference {
  const located = /^(.*?):(\d{1,9})(?::\d{1,9})?$/.exec(term);
  const line = Number(located?.[2]);
  return {
    path: located?.[1] ?? term,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    origin: "query",
  };
}

export function explicitPathReferences(text: string): readonly ExplicitPathReference[] {
  const { anchors } = extractAnchors({ text, maxAnchors: text.length, caseSensitive: true });
  const terms = new Set(
    anchors
      .filter((anchor) =>
        anchor.kind === "path"
          ? pathReference(anchor.term).path.split("/").at(-1)?.includes(".") === true
          : knownFilename(anchor.term),
      )
      .map((anchor) => anchor.sourceTerm ?? anchor.term),
  );
  // Denied dotfiles are targets too, even though ordinary word tokenization removes edge dots.
  for (const token of text.split(/[\s`"'()<>,;!?]+/u)) {
    if (token.startsWith(".") && isDenied(token)) terms.add(token);
  }
  return [...terms].map(pathReference);
}

function normalizedPath(reference: ExplicitPathReference, root: string): string | undefined {
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
  return existingPathPolicyRejection(path, absolute, inputs);
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
  const path = normalizedPath(reference, inputs.searchScope.workspace.root);
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

async function admitBasename(
  reference: ExplicitPathReference,
  inputs: AdmissionInputs,
  state: AdmissionState,
): Promise<void> {
  state.basenameTerms += 1;
  if (!inputs.tryReserveSearchCall()) return;
  const result = await findExplicitFiles(
    inputs,
    `**/${reference.path}`,
    inputs.searchScope.relativePaths,
    BASENAME_MATCH_CAP,
  );
  const paths = new Set(result.atoms.map((atom) => atom.scopePath));
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
