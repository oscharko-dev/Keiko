// Governed coding-context providers (Issue #1211, ADR-0042 D6). Each provider wraps an EXISTING
// retrieval seam and returns redacted, byte-bounded excerpt candidates plus a content-free omission
// when the source is unavailable, not-ready, denied, or excluded for the request's purpose. No
// provider invents retrieval logic: repo-search reuses keiko-workspace `searchText`/`readExcerpt`,
// Local Knowledge reuses the query-only `runLocalKnowledgeRetrieval` path (no answer generation), and
// memory reuses the `retrieveMemoryContext` pipeline already wired for /api/memory/context. Retrieved
// editor state reuses the singleton editor-agent registry. Retrieved text is untrusted model input
// (OWASP LLM08/LLM01): every candidate is tagged with its source tier (by the orchestrator) and
// stripped of unsafe format characters before it can reach a model or the harness.

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CodingContextOmission,
  CodingContextSourceKind,
  EditorAgentDiagnostic,
  EditorAgentSessionSnapshot,
  GitEditorBlameResponse,
  GitEditorDiffResponse,
  GitRepositoryStatusResponse,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  LanguageRange,
  RetrievalQuery,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_EDITOR_BLAME_MAX_LINES,
  GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
  GIT_AGENT_CONTEXT_MAX_FILES,
  GIT_AGENT_CONTEXT_MAX_HUNKS,
  parseGitEditorBlameResponse,
  parseGitEditorDiffResponse,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { validateGitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import type { MemoryScope, ProjectId } from "@oscharko-dev/keiko-contracts/memory";
import {
  DEFAULT_SEARCH_LIMITS,
  detectWorkspaceAt,
  readExcerpt,
  searchText,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { readCitationExcerpt } from "@oscharko-dev/keiko-local-knowledge";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
import type { UiHandlerDeps } from "../deps.js";
import {
  buildCodeContextPack,
  type CodeContextConnector,
  type CodeContextConnectorConfig,
  type CodeContextPackItem,
  type CodeContextPackResult,
  type CodeContextRef,
  type CodeContextSource,
} from "../coding-context/codeContextConnector.js";
import { createGitHubCodeContextConnector } from "../coding-context/githubCodeContextConnector.js";
import type { GitHubCodeContextApiPort } from "../coding-context/githubCodeContextConnector.js";
import {
  gitHubCodeContextPortFor,
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "../coding-context/githubIssueReaderAuthorization.js";
import { createJiraCodeContextConnector } from "../coding-context/jiraCodeContextConnector.js";
import { handleGitBlame, handleGitStatus, handleGitStructuredDiff } from "../gitRoutes.js";
import { openStoreForDeps } from "../local-knowledge-grounded-qa.js";
import { vaultAsQueryPort } from "../memory-conv-handlers.js";
import { memoryCapturePolicyForDeps } from "../memory-capture-policy.js";
import {
  buildConversationRetrievalSignals,
  conversationFusionMode,
  semanticRetrievalGateForText,
} from "../memory-retrieval-signals.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  buildLocalKnowledgeScope,
  retrieveEditorLocalKnowledge,
} from "./localKnowledgeRetrieval.js";

// A pre-budget excerpt candidate. `text` is already redacted, format-char-stripped, and clamped to
// the per-excerpt cap; the orchestrator applies the overall byte budget and assigns final ranks.
export interface RawExcerpt {
  readonly sourceKind: CodingContextSourceKind;
  readonly id: string;
  readonly score: number;
  readonly citationRef: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ProviderOutcome {
  readonly excerpts: readonly RawExcerpt[];
  readonly omission: CodingContextOmission | undefined;
}

export interface ProviderContext {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly fs: WorkspaceFs;
  readonly signal: AbortSignal;
  readonly maxBytesPerExcerpt: number;
  // Request metadata keeps the stable `nowMs`; lease decisions use this live clock at consumption.
  readonly currentTimeMs: () => number;
  readonly nowMs: number;
  readonly gitContextReader?: GitContextReader | undefined;
  /**
   * The originating editor request's correlation id. The git context is assembled by CALLING the
   * git routes in-process, so without it every line those routes emit — a failed read, a
   * spawn-boundary refusal — lands under `UNKNOWN_CORRELATION_ID` and cannot be joined to the
   * editor operation that triggered it (AGENTS.md §8 Rule 1).
   */
  readonly correlationId?: string | undefined;
}

export interface GitContextReadResult {
  readonly status: GitRepositoryStatusResponse;
  readonly diffs: readonly GitEditorDiffResponse[];
  readonly blame: GitEditorBlameResponse | undefined;
}

export type GitContextReader = (input: {
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly activeFile: string | null;
  readonly startLine: number;
  readonly correlationId?: string | undefined;
}) => Promise<GitContextReadResult | undefined>;

const REPO_SEARCH_MAX_HITS = 6;
const FILES_FOCUS_MAX_LINES = 240;
const FILES_FOCUS_MAX_CHANGED_FILES = 4;
const LOCAL_KNOWLEDGE_MAX_REFERENCES = 8;
const MEMORY_MAX_ENTRIES = 8;
const MAX_CITATION_REF_CHARS = 160;
// A live-state excerpt is intentionally narrower than the 50-file changeset ceiling and the
// 128-item snapshot diagnostics ceiling so it cannot crowd out the rest of the context pack.
const EDITOR_STATE_MAX_DIRTY_FILES = 32;
const EDITOR_STATE_MAX_DIAGNOSTICS = 32;
const EDITOR_STATE_EXCERPT_ID = "editor-state-current";
// A request that observed a live bridge may finish a bounded in-flight context read if the bridge
// disconnects while another provider awaits. The lease is server-minted, memory-only, and short;
// caller-supplied snapshot timestamps never establish liveness.
export const EDITOR_STATE_CONTEXT_LEASE_TTL_MS = 15_000;
const EDITOR_STATE_CONTEXT_LEASE_BRAND: unique symbol = Symbol("editor-state-context-lease");
const GIT_CONTEXT_SUMMARY_EXCERPT_ID = "git-context-summary";

export interface EditorStateContextLease {
  readonly sessionId: string;
  readonly expiresAtMs: number;
  readonly [EDITOR_STATE_CONTEXT_LEASE_BRAND]: true;
}

function basename(scopePath: string): string {
  const parts = scopePath.split("/");
  return parts.at(-1) ?? scopePath;
}

// strip-then-redact, mirroring grounded-qa redactString: format-char stripping first (GRD-001)
// prevents Trojan-source splits from confusing the redactor; the redactor then removes secrets.
function redactExcerpt(deps: UiHandlerDeps, text: string): string {
  return String(deps.redactor(stripUnsafeFormatChars(text)));
}

function sanitizeCitationRef(
  ctx: ProviderContext,
  citationRef: string | undefined,
): string | undefined {
  if (citationRef === undefined) {
    return undefined;
  }
  const redacted = String(ctx.deps.redactor(stripUnsafeFormatChars(citationRef)));
  let out = "";
  let pendingSpace = false;
  for (const char of redacted) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
    if (out.length >= MAX_CITATION_REF_CHARS) {
      break;
    }
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// UTF-8-safe byte clamp (no multi-byte split).
function clampToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: true };
  }
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(0, maxBytes))
    .replace(/\uFFFD$/u, "");
  return { text: decoded, truncated: true };
}

function prepareExcerpt(
  ctx: ProviderContext,
  raw: {
    sourceKind: CodingContextSourceKind;
    id: string;
    score: number;
    citationRef: string | undefined;
    text: string;
    truncated?: boolean;
  },
): RawExcerpt | undefined {
  const redacted = redactExcerpt(ctx.deps, raw.text);
  const clamped = clampToBytes(redacted, ctx.maxBytesPerExcerpt);
  if (clamped.text.length === 0) {
    return undefined;
  }
  return {
    sourceKind: raw.sourceKind,
    id: raw.id,
    score: raw.score,
    citationRef: sanitizeCitationRef(ctx, raw.citationRef),
    text: clamped.text,
    // truncated if the upstream read clamped OR our per-excerpt cap clamped.
    truncated: (raw.truncated ?? false) || clamped.truncated,
  };
}

function omission(
  sourceKind: CodingContextSourceKind,
  reason: CodingContextOmission["reason"],
): CodingContextOmission {
  return { sourceKind, reason };
}

function buildScope(
  realRoot: string,
  relativePaths: readonly string[],
  fs: WorkspaceFs,
): SearchScope {
  return {
    workspace: detectWorkspaceAt(realRoot, fs),
    scopeId: "editor-coding-context",
    relativePaths,
  };
}

function buildQuery(text: string, symbol: string | undefined, nowMs: number): RetrievalQuery {
  return {
    kind: symbol !== undefined ? "exact-symbol" : "natural-language",
    text,
    caseSensitive: false,
    maxResults: REPO_SEARCH_MAX_HITS,
    emittedAtMs: nowMs,
  };
}

async function readHitExcerpt(
  signal: AbortSignal,
  scope: SearchScope,
  fs: WorkspaceFs,
  atom: { scopePath: string; lineRange: { startLine: number; endLine: number } | undefined },
  maxBytes: number,
): Promise<{ content: string; truncated: boolean } | undefined> {
  const startLine = atom.lineRange?.startLine ?? 1;
  const endLine = atom.lineRange?.endLine ?? startLine;
  try {
    const result = await readExcerpt(
      scope,
      {
        scopePath: atom.scopePath,
        startLine,
        endLine,
        maxBytes,
      },
      { signal, fs },
    );
    return { content: result.content, truncated: result.truncated };
  } catch {
    return undefined;
  }
}

// AbortSignal.aborted is a live getter that can flip true across an await, but TS narrows it to
// `false` after an early-return guard. Reading it through this helper defeats that narrowing so the
// cooperative cancellation checks stay live (and lint-clean).
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// ─── live editor-state provider ─────────────────────────────────────────────────────
function copyLanguageRange(range: LanguageRange): LanguageRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function summarizeEditorDiagnostic(diagnostic: EditorAgentDiagnostic): EditorAgentDiagnostic {
  return {
    severity: diagnostic.severity,
    range: copyLanguageRange(diagnostic.range),
    message: diagnostic.message,
  };
}

function summarizeEditorState(snapshot: EditorAgentSessionSnapshot): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const dirtyFiles = snapshot.dirtyFiles.slice(0, EDITOR_STATE_MAX_DIRTY_FILES);
  const detail = snapshot.diagnosticsDetail;
  const diagnosticsDetail =
    detail === undefined
      ? null
      : {
          items: detail.items.slice(0, EDITOR_STATE_MAX_DIAGNOSTICS).map(summarizeEditorDiagnostic),
          truncated: detail.truncated || detail.items.length > EDITOR_STATE_MAX_DIAGNOSTICS,
        };
  return {
    text: JSON.stringify(
      {
        activeFile: snapshot.activeFile,
        selection: snapshot.selection === null ? null : copyLanguageRange(snapshot.selection),
        diagnosticsSummary:
          snapshot.diagnosticsSummary === null
            ? null
            : {
                errors: snapshot.diagnosticsSummary.errors,
                warnings: snapshot.diagnosticsSummary.warnings,
                infos: snapshot.diagnosticsSummary.infos,
              },
        dirtyFiles,
        diagnosticsDetail,
      },
      null,
      2,
    ),
    truncated:
      snapshot.dirtyFiles.length > EDITOR_STATE_MAX_DIRTY_FILES ||
      (diagnosticsDetail?.truncated ?? false),
  };
}

export function acquireEditorStateContextLease(
  sessionId: string,
  nowMs: number,
): EditorStateContextLease | undefined {
  if (!editorAgentRegistry.hasLiveBridge(sessionId) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return undefined;
  }
  const expiresAtMs = nowMs + EDITOR_STATE_CONTEXT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(expiresAtMs)) return undefined;
  return { sessionId, expiresAtMs, [EDITOR_STATE_CONTEXT_LEASE_BRAND]: true };
}

function editorStateLeaseValid(
  lease: EditorStateContextLease | undefined,
  sessionId: string,
  nowMs: number,
): boolean {
  return (
    lease?.[EDITOR_STATE_CONTEXT_LEASE_BRAND] === true &&
    lease.sessionId === sessionId &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    nowMs < lease.expiresAtMs
  );
}

function editorStateSessionAvailable(
  ctx: ProviderContext,
  input: { readonly sessionId: string; readonly lease?: EditorStateContextLease | undefined },
): boolean {
  const currentTimeMs = ctx.currentTimeMs();
  return (
    editorAgentRegistry.hasLiveBridge(input.sessionId) ||
    editorStateLeaseValid(input.lease, input.sessionId, currentTimeMs)
  );
}

export function runEditorStateProvider(
  ctx: ProviderContext,
  input: { readonly sessionId: string; readonly lease?: EditorStateContextLease | undefined },
): ProviderOutcome {
  if (isAborted(ctx.signal) || !editorStateSessionAvailable(ctx, input)) {
    return { excerpts: [], omission: omission("editor-state", "unavailable") };
  }
  const snapshot = editorAgentRegistry.snapshotFor(input.sessionId);
  if (snapshot === undefined || isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("editor-state", "unavailable") };
  }
  if (snapshot.workspaceRoot !== ctx.realRoot) {
    return { excerpts: [], omission: omission("editor-state", "denied") };
  }
  const summary = summarizeEditorState(snapshot);
  const excerpt = prepareExcerpt(ctx, {
    sourceKind: "editor-state",
    id: EDITOR_STATE_EXCERPT_ID,
    score: 1,
    citationRef: snapshot.activeFile === null ? undefined : basename(snapshot.activeFile),
    text: summary.text,
    truncated: summary.truncated,
  });
  return excerpt === undefined
    ? { excerpts: [], omission: omission("editor-state", "out-of-budget") }
    : { excerpts: [excerpt], omission: undefined };
}

// ─── read-only Git-context provider ────────────────────────────────────────────────
// Carries the originating request's correlation id into the in-process git route call, so the
// lines that route emits are joinable to the editor operation rather than orphaned under
// `UNKNOWN_CORRELATION_ID`. `RouteContext.correlationId` is optional and the project runs
// `exactOptionalPropertyTypes`, so it is spread rather than assigned.
function gitRouteContext(
  path: string,
  correlationId: string | undefined,
): import("../routes.js").RouteContext {
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL(path, "http://127.0.0.1"),
    correlationId,
  };
}

function availableStatus(body: unknown): GitRepositoryStatusResponse | undefined {
  const validation = validateGitRepositoryStatusResponse(body);
  if (!validation.ok) return undefined;
  const status = body as GitRepositoryStatusResponse;
  return status.available ? status : undefined;
}

async function readStructuredDiff(
  deps: UiHandlerDeps,
  realRoot: string,
  activeFile: string,
  scope: "staged" | "unstaged",
  correlationId: string | undefined,
): Promise<GitEditorDiffResponse | undefined> {
  const query = new URLSearchParams({ root: realRoot, path: activeFile, scope });
  const result = await handleGitStructuredDiff(
    gitRouteContext(`/api/git/diff/structured?${query.toString()}`, correlationId),
    deps,
    deps.gitRouteOptions,
  );
  const parsed = parseGitEditorDiffResponse(result.body);
  return result.status === 200 && parsed.ok ? parsed.value : undefined;
}

async function readBlame(
  deps: UiHandlerDeps,
  realRoot: string,
  activeFile: string,
  startLine: number,
  correlationId: string | undefined,
): Promise<GitEditorBlameResponse | undefined> {
  const query = new URLSearchParams({
    root: realRoot,
    path: activeFile,
    startLine: String(startLine),
    maxLines: String(Math.min(GIT_AGENT_CONTEXT_MAX_BLAME_LINES, GIT_EDITOR_BLAME_MAX_LINES)),
  });
  const result = await handleGitBlame(
    gitRouteContext(`/api/git/blame?${query.toString()}`, correlationId),
    deps,
    deps.gitRouteOptions,
  );
  const parsed = parseGitEditorBlameResponse(result.body);
  return result.status === 200 && parsed.ok ? parsed.value : undefined;
}

const defaultGitContextReader: GitContextReader = async (input) => {
  const query = new URLSearchParams({ root: input.realRoot });
  const result = await handleGitStatus(
    gitRouteContext(`/api/git/status?${query.toString()}`, input.correlationId),
    input.deps,
    input.deps.gitRouteOptions,
  );
  const status = result.status === 200 ? availableStatus(result.body) : undefined;
  if (status === undefined) return undefined;
  if (input.activeFile === null) return { status, diffs: [], blame: undefined };
  const diffs = await Promise.all(
    (["staged", "unstaged"] as const).map((scope) =>
      readStructuredDiff(
        input.deps,
        input.realRoot,
        input.activeFile ?? "",
        scope,
        input.correlationId,
      ),
    ),
  );
  const blame = await readBlame(
    input.deps,
    input.realRoot,
    input.activeFile,
    input.startLine,
    input.correlationId,
  );
  return {
    status,
    diffs: diffs.filter((diff): diff is GitEditorDiffResponse => diff !== undefined),
    blame,
  };
};

function gitSummaryText(result: GitContextReadResult): { text: string; truncated: boolean } {
  const changedFiles = result.status.changes.slice(0, GIT_AGENT_CONTEXT_MAX_FILES);
  const conflictedFiles = changedFiles.filter((change) => change.conflicted);
  return {
    text: JSON.stringify({
      hasConflictMarkers: result.status.conflictedCount > 0,
      changedFileCount: result.status.changes.length,
      conflictedFiles: conflictedFiles.map((change) => basename(change.path)),
      changedFiles: changedFiles.map((change) => ({
        file: basename(change.path),
        staged: change.staged,
        unstaged: change.unstaged,
        untracked: change.untracked,
        conflicted: change.conflicted,
      })),
    }),
    truncated:
      result.status.truncated || result.status.changes.length > GIT_AGENT_CONTEXT_MAX_FILES,
  };
}

function prepareGitSummary(
  ctx: ProviderContext,
  snapshot: EditorAgentSessionSnapshot,
  result: GitContextReadResult,
): RawExcerpt | undefined {
  const summary = gitSummaryText(result);
  return prepareExcerpt(ctx, {
    sourceKind: "git-context",
    id: GIT_CONTEXT_SUMMARY_EXCERPT_ID,
    score: 1,
    citationRef: snapshot.activeFile === null ? "workspace" : basename(snapshot.activeFile),
    text: summary.text,
    truncated: summary.truncated,
  });
}

function prepareGitHunks(
  ctx: ProviderContext,
  citationRef: string,
  result: GitContextReadResult,
): { excerpts: RawExcerpt[]; truncated: boolean } {
  const files = result.diffs.flatMap((diff) =>
    diff.files.map((file) => ({ scope: diff.scope, file })),
  );
  const hunks = files
    .slice(0, GIT_AGENT_CONTEXT_MAX_FILES)
    .flatMap(({ scope, file }) => file.hunks.map((hunk) => ({ scope, file, hunk })));
  const excerpts = hunks.slice(0, GIT_AGENT_CONTEXT_MAX_HUNKS).flatMap((entry, index) => {
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "git-context",
      id: `git-context-hunk-${String(index)}`,
      score: 0.9,
      citationRef,
      text: JSON.stringify({
        scope: entry.scope,
        file: basename(entry.file.path),
        header: entry.hunk.header,
        lines: entry.hunk.lines,
      }),
      truncated: entry.file.truncated || entry.hunk.truncated,
    });
    return prepared === undefined ? [] : [prepared];
  });
  return {
    excerpts,
    truncated:
      hunks.length > GIT_AGENT_CONTEXT_MAX_HUNKS ||
      files.length > GIT_AGENT_CONTEXT_MAX_FILES ||
      result.diffs.some(
        (diff) => diff.truncated || diff.files.length > GIT_AGENT_CONTEXT_MAX_FILES,
      ),
  };
}

function prepareGitBlame(
  ctx: ProviderContext,
  citationRef: string,
  blame: GitEditorBlameResponse | undefined,
): { excerpt: RawExcerpt | undefined; truncated: boolean } {
  if (blame === undefined) return { excerpt: undefined, truncated: false };
  const lines = blame.lines.slice(0, GIT_AGENT_CONTEXT_MAX_BLAME_LINES);
  return {
    excerpt: prepareExcerpt(ctx, {
      sourceKind: "git-context",
      id: "git-context-blame",
      score: 0.8,
      citationRef,
      text: JSON.stringify({
        lines: lines.map(({ line, commitHash, authorTime, summary }) => ({
          line,
          commitHash,
          authorTime,
          summary,
        })),
      }),
      truncated: blame.truncated || blame.lines.length > GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
    }),
    truncated: blame.truncated || blame.lines.length > GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
  };
}

function gitContextSnapshot(
  ctx: ProviderContext,
  input: { readonly sessionId: string; readonly lease?: EditorStateContextLease | undefined },
): EditorAgentSessionSnapshot | ProviderOutcome {
  if (isAborted(ctx.signal) || !editorStateSessionAvailable(ctx, input)) {
    return { excerpts: [], omission: omission("git-context", "unavailable") };
  }
  const snapshot = editorAgentRegistry.snapshotFor(input.sessionId);
  if (snapshot === undefined || isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("git-context", "unavailable") };
  }
  if (snapshot.workspaceRoot !== ctx.realRoot) {
    return { excerpts: [], omission: omission("git-context", "denied") };
  }
  return snapshot;
}

async function readGitContext(
  ctx: ProviderContext,
  snapshot: EditorAgentSessionSnapshot,
): Promise<GitContextReadResult | undefined> {
  try {
    return await (ctx.gitContextReader ?? defaultGitContextReader)({
      deps: ctx.deps,
      realRoot: ctx.realRoot,
      activeFile: snapshot.activeFile,
      startLine: (snapshot.cursor?.line ?? 0) + 1,
      correlationId: ctx.correlationId,
    });
  } catch {
    return undefined;
  }
}

function preparedGitContextOutcome(
  ctx: ProviderContext,
  snapshot: EditorAgentSessionSnapshot,
  result: GitContextReadResult,
): ProviderOutcome {
  const citationRef = snapshot.activeFile === null ? "workspace" : basename(snapshot.activeFile);
  const summary = prepareGitSummary(ctx, snapshot, result);
  const hunks = prepareGitHunks(ctx, citationRef, result);
  const blame = prepareGitBlame(ctx, citationRef, result.blame);
  const excerpts = [summary, ...hunks.excerpts, blame.excerpt].filter(
    (excerpt): excerpt is RawExcerpt => excerpt !== undefined,
  );
  const truncated = hunks.truncated || blame.truncated || summary?.truncated === true;
  return {
    excerpts,
    omission:
      excerpts.length === 0 || truncated ? omission("git-context", "out-of-budget") : undefined,
  };
}

export async function runGitContextProvider(
  ctx: ProviderContext,
  input: { readonly sessionId: string; readonly lease?: EditorStateContextLease | undefined },
): Promise<ProviderOutcome> {
  const snapshot = gitContextSnapshot(ctx, input);
  if ("excerpts" in snapshot) return snapshot;
  const result = await readGitContext(ctx, snapshot);
  if (result === undefined || isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("git-context", "unavailable") };
  }
  return preparedGitContextOutcome(ctx, snapshot, result);
}

// ─── files-focus + repo-search provider ─────────────────────────────────────────────
// Grounds the model in the active document and the top lexical hits for the symbol/query, all from
// the contained workspace via the governed keiko-workspace facade (deny/realpath/size enforced there).
async function readFocusExcerpt(
  ctx: ProviderContext,
  scope: SearchScope,
  documentPath: string,
  score = 1,
): Promise<RawExcerpt | "denied" | undefined> {
  try {
    const focus = await readExcerpt(
      scope,
      {
        scopePath: documentPath,
        startLine: 1,
        endLine: FILES_FOCUS_MAX_LINES,
        maxBytes: ctx.maxBytesPerExcerpt,
      },
      { signal: ctx.signal, fs: ctx.fs },
    );
    return prepareExcerpt(ctx, {
      sourceKind: "files-focus",
      id: focus.atom.stableId,
      score,
      citationRef: basename(documentPath),
      text: focus.content,
      truncated: focus.truncated,
    });
  } catch {
    return "denied";
  }
}

async function searchHitExcerpts(
  ctx: ProviderContext,
  scope: SearchScope,
  term: string,
  symbol: string | undefined,
): Promise<readonly RawExcerpt[] | "unavailable"> {
  let hits: Awaited<ReturnType<typeof searchText>>;
  try {
    hits = await searchText(scope, buildQuery(term, symbol, ctx.nowMs), DEFAULT_SEARCH_LIMITS, {
      signal: ctx.signal,
      fs: ctx.fs,
      ...(ctx.deps.workspaceIndexForRoot === undefined
        ? {}
        : { workspaceIndex: ctx.deps.workspaceIndexForRoot(scope.workspace.root) }),
    });
  } catch {
    return "unavailable";
  }
  const excerpts: RawExcerpt[] = [];
  for (const atom of hits.atoms.slice(0, REPO_SEARCH_MAX_HITS)) {
    if (isAborted(ctx.signal)) {
      break;
    }
    const hit = await readHitExcerpt(ctx.signal, scope, ctx.fs, atom, ctx.maxBytesPerExcerpt);
    if (hit === undefined) {
      continue;
    }
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "repo-search",
      id: atom.stableId,
      score: atom.score,
      citationRef: basename(atom.scopePath),
      text: hit.content,
      truncated: hit.truncated,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

async function readFocusExcerpts(
  ctx: ProviderContext,
  scope: SearchScope,
  documentPath: string,
  changedFiles: readonly string[] | undefined,
): Promise<readonly RawExcerpt[] | "denied"> {
  const focus = await readFocusExcerpt(ctx, scope, documentPath);
  if (focus === "denied") {
    return "denied";
  }
  const excerpts: RawExcerpt[] = focus !== undefined ? [focus] : [];
  for (const changed of (changedFiles ?? []).slice(0, FILES_FOCUS_MAX_CHANGED_FILES)) {
    if (changed === documentPath || isAborted(ctx.signal)) {
      continue;
    }
    const changedFocus = await readFocusExcerpt(ctx, scope, changed, 0.85);
    if (changedFocus !== undefined && changedFocus !== "denied") {
      excerpts.push(changedFocus);
    }
  }
  return excerpts;
}

export async function runRepoSearchProvider(
  ctx: ProviderContext,
  input: {
    readonly documentPath: string;
    readonly symbol: string | undefined;
    readonly queryText: string | undefined;
    readonly changedFiles: readonly string[] | undefined;
  },
): Promise<ProviderOutcome> {
  if (isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("repo-search", "unavailable") };
  }
  const focusPaths = [input.documentPath, ...(input.changedFiles ?? [])];
  const focusScope = buildScope(ctx.realRoot, focusPaths, ctx.fs);
  const searchScope = buildScope(ctx.realRoot, [], ctx.fs);
  const excerpts = await readFocusExcerpts(ctx, focusScope, input.documentPath, input.changedFiles);
  if (excerpts === "denied") {
    return { excerpts: [], omission: omission("files-focus", "denied") };
  }
  const term = input.symbol ?? input.queryText ?? basename(input.documentPath);
  if (term.trim().length === 0 || isAborted(ctx.signal)) {
    return { excerpts, omission: undefined };
  }
  const hits = await searchHitExcerpts(ctx, searchScope, term, input.symbol);
  if (hits === "unavailable") {
    return { excerpts, omission: omission("repo-search", "unavailable") };
  }
  return { excerpts: [...excerpts, ...hits], omission: undefined };
}

// ─── Local Knowledge provider (query-only, no answer generation) ─────────────────────
function localKnowledgeExcerpts(
  ctx: ProviderContext,
  store: ReturnType<typeof openStoreForDeps>["store"],
  references: readonly RetrievalReference[],
): RawExcerpt[] {
  const excerpts: RawExcerpt[] = [];
  for (const reference of references.slice(0, LOCAL_KNOWLEDGE_MAX_REFERENCES)) {
    if (isAborted(ctx.signal)) {
      break;
    }
    const text = readCitationExcerpt(store, reference.capsuleId, reference.citation);
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "local-knowledge",
      id: reference.chunkId,
      score: reference.score,
      citationRef: reference.citation.safeDisplayName,
      text,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

export async function runLocalKnowledgeProvider(
  ctx: ProviderContext,
  input: {
    readonly queryText: string | undefined;
    readonly capsuleId: string | undefined;
    readonly capsuleSetId: string | undefined;
  },
): Promise<ProviderOutcome> {
  const query = input.queryText;
  if (query === undefined || query.trim().length === 0) {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  const scope = buildLocalKnowledgeScope(input.capsuleId, input.capsuleSetId);
  if (scope === undefined) {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  let env: ReturnType<typeof openStoreForDeps>;
  try {
    env = openStoreForDeps(ctx.deps);
  } catch {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  }
  try {
    const outcome = await retrieveEditorLocalKnowledge(
      ctx.deps,
      env.store,
      scope,
      query,
      ctx.signal,
    );
    if (outcome.kind === "conflict") {
      return { excerpts: [], omission: omission("local-knowledge", "denied") };
    }
    if (outcome.kind === "not-ready" || outcome.noEvidence) {
      return { excerpts: [], omission: omission("local-knowledge", "not-ready") };
    }
    return {
      excerpts: localKnowledgeExcerpts(ctx, env.store, outcome.references),
      omission: undefined,
    };
  } catch {
    return { excerpts: [], omission: omission("local-knowledge", "unavailable") };
  } finally {
    env.close();
  }
}

// ─── Memory provider (query-only, reuses retrieveMemoryContext) ───────────────────────
function editorMemoryScopes(realRoot: string): readonly MemoryScope[] {
  return [{ kind: "project", projectId: realRoot as ProjectId }];
}

async function runMemoryRetrieval(
  ctx: ProviderContext,
  vault: NonNullable<UiHandlerDeps["memoryVault"]>,
  queryText: string | undefined,
  scopes: readonly MemoryScope[],
): Promise<ReturnType<typeof retrieveMemoryContext>> {
  if (isAborted(ctx.signal)) {
    throw new Error("memory retrieval aborted");
  }
  const semanticGate = semanticRetrievalGateForText(
    ctx.deps,
    queryText,
    memoryCapturePolicyForDeps(ctx.deps),
  );
  const signals = await buildConversationRetrievalSignals(
    ctx.deps,
    vault,
    queryText,
    scopes,
    ctx.nowMs,
    semanticGate,
    ctx.signal,
  );
  if (isAborted(ctx.signal)) {
    throw new Error("memory retrieval aborted");
  }
  return retrieveMemoryContext(
    {
      scopes,
      nowMs: ctx.nowMs,
      maxIncluded: MEMORY_MAX_ENTRIES,
      budgetTokens: Math.max(1, Math.ceil((ctx.maxBytesPerExcerpt * MEMORY_MAX_ENTRIES) / 4)),
      ...(queryText !== undefined ? { queryText } : {}),
      fusion: conversationFusionMode(ctx.deps),
      ...(signals.semanticById !== undefined ? { semanticById: signals.semanticById } : {}),
      ...(signals.strengthById.size > 0 ? { strengthById: signals.strengthById } : {}),
      ...(signals.embeddingById.size > 0 ? { embeddingById: signals.embeddingById } : {}),
      ...(signals.mmrLambda !== undefined ? { mmrLambda: signals.mmrLambda } : {}),
    },
    vaultAsQueryPort(vault),
  );
}

function memoryExcerpts(
  ctx: ProviderContext,
  result: ReturnType<typeof retrieveMemoryContext>,
): RawExcerpt[] {
  const scoreById = new Map(result.included.map((item) => [item.memoryId, item.score]));
  const excerpts: RawExcerpt[] = [];
  for (const entry of result.contextBlock.memories.slice(0, MEMORY_MAX_ENTRIES)) {
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "memory",
      id: entry.memoryId,
      score: scoreById.get(entry.memoryId) ?? entry.confidence,
      citationRef: entry.inclusionReason,
      text: entry.bodyExcerpt,
    });
    if (prepared !== undefined) {
      excerpts.push(prepared);
    }
  }
  return excerpts;
}

export async function runMemoryProvider(
  ctx: ProviderContext,
  input: { readonly queryText: string | undefined },
): Promise<ProviderOutcome> {
  const vault = ctx.deps.memoryVault;
  if (vault === undefined) {
    return { excerpts: [], omission: omission("memory", "unavailable") };
  }
  let result: ReturnType<typeof retrieveMemoryContext>;
  try {
    result = await runMemoryRetrieval(
      ctx,
      vault,
      input.queryText,
      editorMemoryScopes(ctx.realRoot),
    );
  } catch {
    return { excerpts: [], omission: omission("memory", "unavailable") };
  }
  return { excerpts: memoryExcerpts(ctx, result), omission: undefined };
}

// ─── connected-context provider (Issue #1989 intake, Epic #2556 Target Outcome 6) ────
// Reuses the existing coding-context intake (buildCodeContextPack + the GitHub/Jira connectors)
// through the `codingContextGitHubPort` / `codingContextJiraPort` seam on UiHandlerDeps. No second
// connector, pack, or registration path: this provider only ADAPTS the intake result into excerpt
// candidates. The read is outbound network work, so the orchestrator gates it exactly like the
// embedding-cost providers (`requiresEmbedding`), which keeps it off the keystroke-sensitive
// purposes with a `too-expensive` omission instead of a silent skip.
//
// The referenced objects come from the request's own query text — an editor request has no
// connector-scope grant of its own, so authority is server-owned: the deployment ceiling supplies
// the effective mode and the default-false connector authorization supplies the scope. Anything
// unauthorized is blocked by the intake before an outbound call and surfaces as `denied`.
const CONNECTED_CONTEXT_MAX_REFS = 4;
const CONNECTED_CONTEXT_RUN_ID = "editor-coding-context";
const CONNECTED_CONTEXT_SCORE = 0.75;
// `owner/repo#123`; GitHub serves pull requests from the issues endpoint, so "issue" reads both.
const GITHUB_REF_PATTERN =
  /([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})#([1-9]\d{0,9})/gu;
const JIRA_REF_PATTERN = /\b([A-Z][A-Z0-9_]{1,20})-([1-9]\d{0,9})\b/gu;

interface ConnectedContextIntake {
  readonly connectors: Readonly<Record<CodeContextSource, CodeContextConnector>>;
  readonly connectorConfig: CodeContextConnectorConfig;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly effectiveMode: CodingWorkbenchMode;
}

const CONNECTED_CONTEXT_UNCONFIGURED: CodeContextConnector = {
  read: () => Promise.reject(new Error("coding context connector is not configured")),
};

function githubContextRefs(queryText: string): CodeContextRef[] {
  const refs: CodeContextRef[] = [];
  for (const [, ownerAndRepo, objectId] of queryText.matchAll(GITHUB_REF_PATTERN)) {
    if (ownerAndRepo !== undefined && objectId !== undefined) {
      refs.push({ source: "github", objectKind: "issue", ownerAndRepo, objectId });
    }
  }
  return refs;
}

function jiraContextRefs(queryText: string): CodeContextRef[] {
  const refs: CodeContextRef[] = [];
  for (const [, projectKey, objectId] of queryText.matchAll(JIRA_REF_PATTERN)) {
    if (projectKey !== undefined && objectId !== undefined) {
      refs.push({ source: "jira", objectKind: "issue", projectKey, objectId });
    }
  }
  return refs;
}

function connectedContextRefKey(ref: CodeContextRef): string {
  return ref.source === "github"
    ? `github:${ref.ownerAndRepo}#${ref.objectId}`
    : `jira:${ref.projectKey}-${ref.objectId}`;
}

// Bounded and de-duplicated: one query text may name the same object several times, and each ref
// costs outbound connector calls.
function connectedContextRefs(queryText: string | undefined): readonly CodeContextRef[] {
  if (queryText === undefined || queryText.trim().length === 0) return [];
  const seen = new Set<string>();
  const refs: CodeContextRef[] = [];
  for (const ref of [...githubContextRefs(queryText), ...jiraContextRefs(queryText)]) {
    const key = connectedContextRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length === CONNECTED_CONTEXT_MAX_REFS) break;
  }
  return refs;
}

// Connector authorization is default-false and server-owned: an editor request can never widen it.
function connectorAuthorizedInEnv(deps: UiHandlerDeps, key: string): boolean {
  return deps.env[key] === "true";
}

function connectedContextScopes(
  deps: UiHandlerDeps,
  config: CodeContextConnectorConfig,
  // The port this intake will actually read through, NOT the launch-time field. Keying the scope
  // off `deps.codingContextGitHubPort` meant that starting Keiko without an initial project built a
  // working fallback port and could carry a live grant, and then withheld `source-control.read` so
  // `authorizeCodeContextRead` answered `missing-scope` — denying the exact case the fallback
  // exists to serve. The pack route already derives its flag from the resolved port; this is the
  // editor twin catching up.
  githubPort: GitHubCodeContextApiPort | undefined,
): readonly CodingWorkbenchConnectorScope[] {
  const scopes: CodingWorkbenchConnectorScope[] = [];
  if (githubPort !== undefined && config.github_connector_authorized === true) {
    scopes.push("source-control.read");
  }
  if (deps.codingContextJiraPort !== undefined && config.jira_connector_authorized === true) {
    scopes.push("issue-tracker.read");
  }
  return scopes;
}

function connectedContextIntake(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  correlationId: string | undefined,
  // The `owner/repo` this checkout's remote resolves to; resolved by the async caller because
  // reading a git remote is a subprocess. Undefined denies every GitHub ref.
  allowedOwnerAndRepo: string | undefined,
): ConnectedContextIntake | undefined {
  // Same rule as the route: the port follows the repository this provider is operating on. Building
  // it only from the launch project left GitHub context permanently unavailable whenever Keiko was
  // started without an initial project, however the grant was set.
  const githubPort =
    deps.codingContextGitHubPort ?? gitHubCodeContextPortFor(repositoryRoot, deps.env);
  const jiraPort = deps.codingContextJiraPort;
  if (githubPort === undefined && jiraPort === undefined) return undefined;
  const connectorConfig: CodeContextConnectorConfig = {
    // #3385: the GitHub reader is authorized per local checkout by a persisted grant, not by a
    // launch-path environment variable. The grant is written through
    // `PUT /api/coding-workbench/github-authorization`; no settings screen calls that route yet, so
    // "the settings surface" would overstate what exists. The root is the one this provider is
    // actually operating on (`ctx.realRoot`), not the process-wide launch directory: an editor
    // working in checkout B must be denied unless B itself carries a grant, and A's grant must
    // never authorize B. Jira keeps its existing environment gate; #3385 does not change it.
    github_connector_authorized: isGitHubIssueReaderAuthorized(deps, repositoryRoot, {
      correlationId,
    }),
    // The grant admits GitHub; this says WHICH repository it admits.
    github_allowed_owner_and_repo: allowedOwnerAndRepo,
    jira_connector_authorized: connectorAuthorizedInEnv(deps, "JIRA_CONNECTOR_AUTHORIZED"),
  };
  return {
    connectors: {
      github:
        githubPort === undefined
          ? CONNECTED_CONTEXT_UNCONFIGURED
          : createGitHubCodeContextConnector(githubPort),
      jira:
        jiraPort === undefined
          ? CONNECTED_CONTEXT_UNCONFIGURED
          : createJiraCodeContextConnector(jiraPort),
    },
    connectorConfig,
    connectorScopes: connectedContextScopes(deps, connectorConfig, githubPort),
    effectiveMode: deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
  };
}

function connectedContextItemText(item: CodeContextPackItem): string {
  return JSON.stringify({
    untrusted: item.untrusted,
    label: item.label,
    title: item.title,
    body: item.body,
    comments: item.comments.map((comment) => ({ id: comment.id, body: comment.body })),
  });
}

function connectedContextExcerpts(
  ctx: ProviderContext,
  items: readonly CodeContextPackItem[],
): RawExcerpt[] {
  return items.flatMap((item, index) => {
    const prepared = prepareExcerpt(ctx, {
      sourceKind: "connected-context",
      id: `connected-context-${String(index)}`,
      score: CONNECTED_CONTEXT_SCORE,
      citationRef: item.label,
      text: connectedContextItemText(item),
      truncated: item.bodyTruncated || item.comments.some((comment) => comment.bodyTruncated),
    });
    return prepared === undefined ? [] : [prepared];
  });
}

function connectedContextOmission(
  result: CodeContextPackResult,
  excerptCount: number,
): CodingContextOmission | undefined {
  if (result.blocked.length > 0) return omission("connected-context", "denied");
  if (excerptCount > 0) return undefined;
  return omission("connected-context", result.items.length > 0 ? "out-of-budget" : "unavailable");
}

async function readConnectedContextPack(
  ctx: ProviderContext,
  intake: ConnectedContextIntake,
  refs: readonly CodeContextRef[],
): Promise<CodeContextPackResult | undefined> {
  try {
    return await buildCodeContextPack(
      {
        runId: CONNECTED_CONTEXT_RUN_ID,
        effectiveMode: intake.effectiveMode,
        connectorScopes: intake.connectorScopes,
        refs,
        maxBodyBytes: ctx.maxBytesPerExcerpt,
      },
      {
        connectors: intake.connectors,
        connectorConfig: intake.connectorConfig,
        nowIso: () => new Date(ctx.currentTimeMs()).toISOString(),
      },
    );
  } catch {
    return undefined;
  }
}

export async function runConnectedContextProvider(
  ctx: ProviderContext,
  input: { readonly queryText: string | undefined },
): Promise<ProviderOutcome> {
  const refs = connectedContextRefs(input.queryText);
  const intake = connectedContextIntake(
    ctx.deps,
    ctx.realRoot,
    ctx.correlationId,
    await githubRemoteOwnerAndRepoFor(
      ctx.realRoot,
      ctx.deps.env,
      ctx.deps.codingContextGitHubRemoteResolver,
    ),
  );
  if (isAborted(ctx.signal) || refs.length === 0 || intake === undefined) {
    return { excerpts: [], omission: omission("connected-context", "unavailable") };
  }
  const result = await readConnectedContextPack(ctx, intake, refs);
  if (result === undefined || isAborted(ctx.signal)) {
    return { excerpts: [], omission: omission("connected-context", "unavailable") };
  }
  const excerpts = connectedContextExcerpts(ctx, result.items);
  return { excerpts, omission: connectedContextOmission(result, excerpts.length) };
}
