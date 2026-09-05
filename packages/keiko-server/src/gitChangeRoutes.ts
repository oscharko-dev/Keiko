// Issue #3400 (epic #3384): connect a Git change to Chat for iterative pull-request description
// refinement. Two mutating routes:
//
//   POST /api/git-change/connect  — resolve an exact server-side base/head comparison, or one
//     existing same-repository open pull request, capture its immutable snapshot, record a
//     `reads-context` relationship (chat -> git-change) through the existing relationship engine,
//     and persist the resulting scope on the chat row.
//   POST /api/git-change/refresh  — re-check a connected scope's snapshot against the live
//     repository. `reads-context` is immutable/non-reconnectable (relationships.ts lifecycle
//     flags), so a changed comparison archives the existing relationship and creates a NEW one
//     (contract correction 4) rather than mutating it; the chat's scope entry is updated to
//     "current" or "stale" accordingly.
//
// V1 selection (issue text, Baseline Delta): an exact server-resolved local base/head comparison,
// or one existing same-repository PR whose commits are available in the trusted checkout. Detached
// or unborn heads, missing refs and ambiguous PR matches block with a closed reason. This route
// neither fetches nor silently adopts a remote-only head — the existing explicit Git refresh flow
// owns that. "Same repository" keys on `remoteDigest` (contract correction 6), never
// `repositoryId`, which is a per-checkout locator only.
//
// The browser sends only a chat id and a ref/mode selection — never a filesystem path, a resolved
// SHA, or a repository identity. The trusted repository root is the CHAT's own already-validated
// `projectPath` (set at project-creation time), matched by the exact same membership check the
// snapshot service itself performs internally, never a fresh browser-authored root.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type {
  Chat,
  ChatGitChangeScope,
  GitChangeBlockedReason,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { isGitChangeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";
import { createNodeGitPullRequestAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import type { UiHandlerDeps } from "./deps.js";
// Final-audit F4 (#3400): mints the Chat-turn description authority under the EXACT scope shape
// chat-handlers.ts's own admission check derives -- the one formula, imported rather than
// restated (AGENTS.md §7's fixture/formula rule applies to a mint key exactly like a fixture).
import { gitChangeDescriptionAuthorityScopeFor } from "./gitChangeChatContext.js";
import type { RouteContext, RouteDefinition, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { observedGitRunner } from "./gitProcessActivity.js";
import { processServerLogSink } from "./process-log-sink.js";
import { parsePorcelainV2Branch } from "./gitPorcelainStatus.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";
import {
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "./coding-context/githubIssueReaderAuthorization.js";
import {
  hasOnlyAllowedKeys,
  isPlainObject,
  isSafeGitRef,
  readParsedGitDeliveryBody,
} from "./gitDelivery/requestGuards.js";
import type {
  CreateRelationshipInput,
  RelationshipMutationResult,
} from "./relationship-handlers.js";
import type { StoredRelationship } from "./store/relationships.js";
import { resolveChatRepository } from "./gitChangeRepository.js";
import { MAX_GIT_CHANGE_SCOPES } from "./store/chats.js";
import { UiStoreError } from "./store/errors.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

type GitChangeErrorCode =
  | "GIT_CHANGE_BAD_REQUEST"
  | "GIT_CHANGE_PAYLOAD_TOO_LARGE"
  | "GIT_CHANGE_CHAT_NOT_FOUND"
  | "GIT_CHANGE_SCOPE_NOT_FOUND"
  | "GIT_CHANGE_SCOPE_LIMIT_REACHED"
  | "GIT_CHANGE_ENGINE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitChangeErrorCode, string>> = {
  GIT_CHANGE_BAD_REQUEST: "The request body is not a valid git-change request.",
  GIT_CHANGE_PAYLOAD_TOO_LARGE: "The git-change request exceeds the maximum size.",
  GIT_CHANGE_CHAT_NOT_FOUND: "The chat does not exist.",
  GIT_CHANGE_SCOPE_NOT_FOUND: "No connected git-change scope matches this relationship.",
  GIT_CHANGE_ENGINE_UNAVAILABLE: "The relationship engine is not available.",
  GIT_CHANGE_SCOPE_LIMIT_REACHED:
    "This chat already has the maximum number of connected git-change scopes.",
};

function errResult(status: number, code: GitChangeErrorCode): RouteResult {
  return { status, body: errorBody(code, SAFE_MESSAGES[code]) };
}

// The closed set of reasons a connect/refresh request may block on (`GitChangeBlockedReason`,
// keiko-contracts/bff-wire.ts) is owned once there and imported here — the browser client
// (packages/keiko-ui/src/lib/api.ts) imports the same constant/type rather than each
// hand-restating the same 11-member set (F30 in the epic #3384 final audit).

type GitChangeConnectResult =
  | { readonly status: "connected"; readonly scope: ChatGitChangeScope }
  | { readonly status: "blocked"; readonly reason: GitChangeBlockedReason };

type GitChangeRefreshResult =
  | { readonly status: "current"; readonly scope: ChatGitChangeScope }
  | { readonly status: "stale"; readonly scope: ChatGitChangeScope }
  | { readonly status: "blocked"; readonly reason: GitChangeBlockedReason };

// ─── Request parsing ────────────────────────────────────────────────────────────────────────────

const CONNECT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "chatId",
  "mode",
  "headRef",
  "baseRef",
]);
const REFRESH_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "chatId", "relationshipId"]);
const CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RELATIONSHIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface ConnectRequest {
  readonly chatId: string;
  readonly mode: "comparison" | "pull-request";
  readonly headRef: string;
  readonly baseRef?: string;
}

function parseConnectMode(
  mode: unknown,
  headRef: string,
  baseRef: unknown,
): Pick<ConnectRequest, "mode" | "headRef" | "baseRef"> | undefined {
  if (mode === "comparison") {
    if (!isSafeGitRef(baseRef)) return undefined;
    return { mode, headRef, baseRef };
  }
  if (mode === "pull-request" && baseRef === undefined) {
    return { mode, headRef };
  }
  return undefined;
}

function parseConnectRequest(value: unknown): ConnectRequest | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, CONNECT_KEYS)) return undefined;
  if (value.schemaVersion !== "1") return undefined;
  const { chatId, mode, headRef, baseRef } = value;
  if (typeof chatId !== "string" || !CHAT_ID_PATTERN.test(chatId)) return undefined;
  if (!isSafeGitRef(headRef)) return undefined;
  const rest = parseConnectMode(mode, headRef, baseRef);
  return rest === undefined ? undefined : { chatId, ...rest };
}

interface RefreshRequest {
  readonly chatId: string;
  readonly relationshipId: string;
}

function parseRefreshRequest(value: unknown): RefreshRequest | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, REFRESH_KEYS)) return undefined;
  if (value.schemaVersion !== "1") return undefined;
  const { chatId, relationshipId } = value;
  if (typeof chatId !== "string" || !CHAT_ID_PATTERN.test(chatId)) return undefined;
  if (typeof relationshipId !== "string" || !RELATIONSHIP_ID_PATTERN.test(relationshipId)) {
    return undefined;
  }
  return { chatId, relationshipId };
}

function contentFreeWorkspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

// ─── Head-state precondition (detached / unborn) ───────────────────────────────────────────────
// The issue's Baseline Delta blocks a detached or unborn HEAD before capture ever runs, rather
// than surfacing it as a generic snapshot failure: neither state names a stable branch a later
// refresh or PR match could re-resolve.
async function detectHeadState(
  runner: GitProcessRunner,
  repositoryRoot: string,
  timeoutMs: number,
): Promise<"attached" | "detached" | "unborn"> {
  const verify = await runner(["rev-parse", "-q", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    maxBytes: 4096,
    timeoutMs,
    expectedExitCodes: [1],
  });
  if (verify.exitCode !== 0) return "unborn";
  const status = await runner(["status", "--porcelain=v2", "--branch", "-z"], {
    cwd: repositoryRoot,
    maxBytes: 65536,
    timeoutMs,
  });
  if (status.exitCode !== 0) return "unborn";
  return parsePorcelainV2Branch(status.stdout).detached ? "detached" : "attached";
}

// ─── Same-repository PR-by-head resolution (contract correction 7) ────────────────────────────
// Keyed on `remoteDigest` (correction 6), gated by the existing per-checkout GitHub-reader grant.
// An ambiguous match (more than one open PR for the same head branch) or a missing grant blocks —
// it is never downgraded to a local comparison the user did not select.
interface ResolvedPullRequest {
  readonly identity: GitPullRequestIdentity;
  readonly remoteDigest: string;
}

async function resolvePullRequestByHead(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  headRef: string,
  correlationId: string,
): Promise<ResolvedPullRequest | GitChangeBlockedReason> {
  if (!isGitHubIssueReaderAuthorized(deps, repositoryRoot, { correlationId })) {
    return "reader-unauthorized";
  }
  const ownerAndRepo = await githubRemoteOwnerAndRepoFor(repositoryRoot, deps.env, undefined, {
    correlationId,
  });
  if (ownerAndRepo === undefined) return "remote-unresolved";
  const adapter = createNodeGitPullRequestAdapter({
    workspace: contentFreeWorkspace(repositoryRoot),
    processEnv: deps.env,
  });
  const result = await adapter.findPullRequestsByHead({ ownerAndRepo, headBranchName: headRef });
  if (!result.ok) return "remote-unresolved";
  const open = result.value.filter((pr) => pr.state === "open");
  if (open.length === 0) return "no-pull-request";
  if (open.length > 1) return "ambiguous-pull-request";
  const identity = open[0];
  if (identity === undefined) return "no-pull-request";
  return { identity, remoteDigest: codingWorkbenchRemoteDigest(ownerAndRepo) };
}

// ─── Snapshot capture ───────────────────────────────────────────────────────────────────────────

interface CapturedComparison {
  readonly snapshot: GitChangeSnapshot;
  readonly remoteDigest: string;
}

async function captureComparison(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  baseRef: string,
  headRef: string,
  correlationId: string,
): Promise<CapturedComparison | GitChangeBlockedReason> {
  const service = deps.gitChangeSnapshotService;
  if (service === undefined) return "repository-unavailable";
  const capture = await service.capture({
    workspace: contentFreeWorkspace(repositoryRoot),
    baseRef,
    headRef,
    accessScope: {},
    correlationId,
  });
  if (!isGitChangeSnapshot(capture.snapshot)) {
    return capture.snapshot.outcome === "unavailable" ? "snapshot-unavailable" : "snapshot-failed";
  }
  if (capture.snapshot.remoteDigest === undefined) return "remote-unresolved";
  return { snapshot: capture.snapshot, remoteDigest: capture.snapshot.remoteDigest };
}

// ─── Relationship engine bridge (existing Connect relationship infrastructure) ─────────────────

function gitChangeObjectId(snapshotDigest: string): string {
  return `gc_${snapshotDigest}`;
}

function createdAuditFor(
  stored: StoredRelationship,
  etag: string,
): Parameters<NonNullable<UiHandlerDeps["relationship"]>["store"]["recordAuditEntry"]>[0] {
  return {
    workspaceId: stored.workspaceId,
    kind: "relationship.created",
    relationshipId: stored.id,
    actor: { surface: "chat", redactedActorId: "git-change-connect" },
    summary: "git-change relationship created",
    payload: {
      relationshipType: stored.type,
      sourceKind: stored.source.kind,
      targetKind: stored.target.kind,
      lifecycle: stored.lifecycleState,
      etag,
    },
  };
}

function createGitChangeRelationship(
  deps: UiHandlerDeps,
  workspaceId: string,
  chatId: string,
  snapshotDigest: string,
): RelationshipMutationResult | undefined {
  const relationship = deps.relationship;
  if (relationship === undefined) return undefined;
  const input: CreateRelationshipInput = {
    workspaceId,
    scope: { kind: "workspace", workspaceId },
    type: "reads-context",
    source: { kind: "chat", id: chatId },
    target: { kind: "git-change", id: gitChangeObjectId(snapshotDigest) },
    lifecycleState: "active",
  };
  return relationship.store.createRelationship(input, (result) =>
    createdAuditFor(result.relationship, result.etag),
  );
}

function archiveGitChangeRelationship(deps: UiHandlerDeps, workspaceId: string, id: string): void {
  const relationship = deps.relationship;
  if (relationship === undefined) return;
  const etag = relationship.store.getEtag(workspaceId, id);
  if (etag === undefined) return;
  relationship.store.updateLifecycle(
    { workspaceId, id, currentEtag: etag, to: "archived" },
    (result) => ({
      workspaceId,
      kind: "relationship.updated",
      relationshipId: result.relationship.id,
      actor: { surface: "chat", redactedActorId: "git-change-refresh" },
      summary: "git-change relationship archived on refresh",
      payload: { lifecycle: result.relationship.lifecycleState },
    }),
  );
}

// ─── Scope assembly ─────────────────────────────────────────────────────────────────────────────

function comparisonLabel(baseRef: string, headRef: string, prNumber: number | undefined): string {
  return prNumber === undefined ? `${baseRef}...${headRef}` : `PR #${String(prNumber)}`;
}

function buildScope(
  relationshipId: string,
  snapshot: GitChangeSnapshot,
  remoteDigest: string,
  prNumber: number | undefined,
  now: number,
): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId,
    remoteDigest,
    comparisonLabel: comparisonLabel(snapshot.baseRef, snapshot.headRef, prNumber),
    baseRef: snapshot.baseRef,
    headRef: snapshot.headRef,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    snapshotDigest: snapshot.snapshotDigest,
    ...(prNumber === undefined ? {} : { pullRequestNumber: prNumber }),
    fileCount: snapshot.completeness.files,
    totalFiles: snapshot.completeness.totalFiles,
    omittedFiles: snapshot.completeness.omittedFiles,
    truncatedFiles: snapshot.completeness.truncatedFiles,
    descriptionStatus: "current",
    connectedAtMs: now,
  };
}

// ─── Activity log (AGENTS.md §8 Rule 1 — body-free) ────────────────────────────────────────────

function logGitChangeEvent(
  deps: UiHandlerDeps,
  op:
    | "git-change.chat.connected"
    | "git-change.chat.refreshed"
    | "git-change.chat.stale"
    | "git-change.chat.blocked",
  correlationId: string,
  extra: Readonly<Record<string, unknown>>,
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op,
    correlationId,
    extra,
  });
}

// Final-audit F4 (#3400): a Chat-connected git-change scope is only ever admitted for a real turn
// (chat-handlers.ts's `admitGitChangeScopedTurn`) when a live description authority record exists
// for its EXACT (remoteDigest, base/head, snapshotDigest) key. Before this fix nothing ever minted
// one for a Chat-originated scope, so every turn on a connected chat denied closed in production
// regardless of mode or approval. Mints on every fresh connect and on a refreshed (stale) scope --
// never on an unchanged "current" refresh, whose snapshot digest (and therefore scope key) has not
// moved. `deps.mintDescriptionAuthority` absent (an unqualified runtime host) is a no-op exactly
// like the read port being absent: the resulting turn denies closed, never open.
function mintGitChangeDescriptionAuthority(
  deps: UiHandlerDeps,
  scope: ChatGitChangeScope,
  nowMs: number,
): boolean {
  if (deps.mintDescriptionAuthority === undefined) return false;
  deps.mintDescriptionAuthority(
    gitChangeDescriptionAuthorityScopeFor(scope),
    new Date(nowMs).toISOString(),
  );
  return true;
}

// ─── Connect handler ────────────────────────────────────────────────────────────────────────────

async function resolveConnectComparison(
  deps: UiHandlerDeps,
  repositoryRoot: string,
  request: ConnectRequest,
  correlationId: string,
): Promise<
  | { readonly baseRef: string; readonly headRef: string; readonly prNumber: number | undefined }
  | GitChangeBlockedReason
> {
  if (request.mode === "comparison") {
    return { baseRef: request.baseRef ?? "", headRef: request.headRef, prNumber: undefined };
  }
  const resolved = await resolvePullRequestByHead(
    deps,
    repositoryRoot,
    request.headRef,
    correlationId,
  );
  if (typeof resolved === "string") return resolved;
  return {
    baseRef: resolved.identity.baseRef,
    headRef: resolved.identity.headRef,
    prNumber: resolved.identity.number,
  };
}

async function resolveConnectSnapshot(
  deps: UiHandlerDeps,
  projectPath: string,
  request: ConnectRequest,
  correlationId: string,
): Promise<CapturedComparison & { readonly prNumber: number | undefined }> {
  const runner = observedGitRunner(
    defaultGitProcessRunner,
    deps.activityLog ?? processServerLogSink(),
    correlationId,
  );
  const timeoutMs = 30_000;
  const repository = await resolveChatRepository(projectPath, runner, timeoutMs);
  if (repository === undefined) throw new GitChangeBlocked("chat-project-unavailable");
  const headState = await detectHeadState(runner, repository.repositoryRoot, timeoutMs);
  if (headState !== "attached") {
    throw new GitChangeBlocked(headState === "unborn" ? "unborn-head" : "detached-head");
  }
  const comparison = await resolveConnectComparison(
    deps,
    repository.repositoryRoot,
    request,
    correlationId,
  );
  if (typeof comparison === "string") throw new GitChangeBlocked(comparison);
  const captured = await captureComparison(
    deps,
    repository.repositoryRoot,
    comparison.baseRef,
    comparison.headRef,
    correlationId,
  );
  if (typeof captured === "string") throw new GitChangeBlocked(captured);
  return { ...captured, prNumber: comparison.prNumber };
}

// Blocked outcomes are expected, closed-vocabulary results rather than defects — thrown only to
// unwind the resolve pipeline above in one place instead of threading a discriminated return
// through every intermediate `await`, and caught immediately by each route handler below.
class GitChangeBlocked extends Error {
  public constructor(public readonly reason: GitChangeBlockedReason) {
    super(reason);
  }
}

// Owner audit b3-9 — check the store-owned `MAX_GIT_CHANGE_SCOPES` cap before capture so a chat
// already at the cap is rejected with a closed error BEFORE a relationship is created for a scope
// the store would then refuse to persist, leaving no orphaned relationship behind. The store's own
// `validatePatchGitChangeScopes` stays the authoritative enforcement — the catch around
// `updateChat` below is a fail-closed backstop if the two limits are ever allowed to drift.
function persistConnectedScope(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  chatId: string,
  existingScopes: readonly ChatGitChangeScope[],
  captured: CapturedComparison & { readonly prNumber: number | undefined },
  correlationId: string,
): RouteResult {
  const workspaceId = deps.relationship?.scopeResolver(ctx.req)?.workspaceId;
  if (workspaceId === undefined) return errResult(503, "GIT_CHANGE_ENGINE_UNAVAILABLE");
  const mutation = createGitChangeRelationship(
    deps,
    workspaceId,
    chatId,
    captured.snapshot.snapshotDigest,
  );
  if (mutation === undefined) return errResult(503, "GIT_CHANGE_ENGINE_UNAVAILABLE");
  const now = Date.now();
  const scope = buildScope(
    mutation.relationship.id,
    captured.snapshot,
    captured.remoteDigest,
    captured.prNumber,
    now,
  );
  const minted = mintGitChangeDescriptionAuthority(deps, scope, now);
  try {
    deps.store.updateChat(chatId, { gitChangeScopes: [...existingScopes, scope] });
  } catch (error) {
    if (error instanceof UiStoreError) {
      archiveGitChangeRelationship(deps, workspaceId, scope.relationshipId);
      return errResult(409, "GIT_CHANGE_SCOPE_LIMIT_REACHED");
    }
    throw error;
  }
  logGitChangeEvent(deps, "git-change.chat.connected", correlationId, {
    relationshipId: scope.relationshipId,
    remoteDigestPrefix: scope.remoteDigest.slice(0, 8),
    fileCount: scope.fileCount,
    hasPullRequest: scope.pullRequestNumber !== undefined,
    descriptionAuthorityMinted: minted,
  });
  const result: GitChangeConnectResult = { status: "connected", scope };
  return { status: 200, body: result };
}

export async function handleGitChangeConnect(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await readParsedGitDeliveryBody(
    ctx.req,
    () => errResult(413, "GIT_CHANGE_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_CHANGE_BAD_REQUEST"),
  );
  if (!parsed.ok) return parsed.result;
  const request = parseConnectRequest(parsed.value);
  if (request === undefined) return errResult(400, "GIT_CHANGE_BAD_REQUEST");
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const chatResult = connectChat(deps, request.chatId);
  if (!chatResult.ok) return chatResult.result;
  const { chat } = chatResult;

  let captured: CapturedComparison & { readonly prNumber: number | undefined };
  try {
    captured = await resolveConnectSnapshot(deps, chat.projectPath, request, correlationId);
  } catch (error) {
    if (!(error instanceof GitChangeBlocked)) throw error;
    return blockedConnectResult(deps, correlationId, error.reason);
  }
  return persistConnectedScope(
    ctx,
    deps,
    chat.id,
    chat.gitChangeScopes ?? [],
    captured,
    correlationId,
  );
}

function connectChat(
  deps: UiHandlerDeps,
  chatId: string,
):
  | { readonly ok: true; readonly chat: Chat }
  | { readonly ok: false; readonly result: RouteResult } {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) return { ok: false, result: errResult(404, "GIT_CHANGE_CHAT_NOT_FOUND") };
  return (chat.gitChangeScopes?.length ?? 0) >= MAX_GIT_CHANGE_SCOPES
    ? { ok: false, result: errResult(409, "GIT_CHANGE_SCOPE_LIMIT_REACHED") }
    : { ok: true, chat };
}

function blockedConnectResult(
  deps: UiHandlerDeps,
  correlationId: string,
  reason: GitChangeBlockedReason,
): RouteResult {
  logGitChangeEvent(deps, "git-change.chat.blocked", correlationId, { reason });
  const result: GitChangeConnectResult = { status: "blocked", reason };
  return { status: 200, body: result };
}

// ─── Refresh handler ────────────────────────────────────────────────────────────────────────────

function findGitChangeScope(
  deps: UiHandlerDeps,
  chatId: string,
  relationshipId: string,
):
  | {
      readonly chatProjectPath: string;
      readonly existing: readonly ChatGitChangeScope[];
      readonly scope: ChatGitChangeScope;
    }
  | undefined {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) return undefined;
  const existing = chat.gitChangeScopes ?? [];
  const scope = existing.find((entry) => entry.relationshipId === relationshipId);
  if (scope === undefined) return undefined;
  return { chatProjectPath: chat.projectPath, existing, scope };
}

function blockedRefreshResult(
  deps: UiHandlerDeps,
  correlationId: string,
  reason: GitChangeBlockedReason,
): RouteResult {
  logGitChangeEvent(deps, "git-change.chat.blocked", correlationId, { reason });
  const result: GitChangeRefreshResult = { status: "blocked", reason };
  return { status: 200, body: result };
}

type FoundGitChangeScope = NonNullable<ReturnType<typeof findGitChangeScope>>;

// Correction 4: `reads-context` is immutable/non-reconnectable. A drifted comparison archives the
// stale edge and creates a fresh one bound to the new snapshot rather than mutating the existing
// record; the chat's scope entry is replaced with a "stale" projection of the new facts.
function persistStaleScope(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  chatId: string,
  found: FoundGitChangeScope,
  captured: CapturedComparison,
  correlationId: string,
): RouteResult {
  const workspaceId = deps.relationship?.scopeResolver(ctx.req)?.workspaceId;
  if (workspaceId === undefined) return errResult(503, "GIT_CHANGE_ENGINE_UNAVAILABLE");
  // Owner audit b3-8 — create the replacement relationship BEFORE archiving the one it replaces.
  // `reads-context` is immutable/non-reconnectable (correction 4 above), so a drifted comparison
  // still needs two edges (archive old, create new); creating first means a failing create (e.g. a
  // store-level conflict) leaves the chat pointing at the still-active OLD relationship instead of
  // one that was just archived out from under it.
  const mutation = createGitChangeRelationship(
    deps,
    workspaceId,
    chatId,
    captured.snapshot.snapshotDigest,
  );
  if (mutation === undefined) return errResult(503, "GIT_CHANGE_ENGINE_UNAVAILABLE");
  const staleScope: ChatGitChangeScope = {
    ...buildScope(
      mutation.relationship.id,
      captured.snapshot,
      captured.remoteDigest,
      found.scope.pullRequestNumber,
      found.scope.connectedAtMs,
    ),
    descriptionStatus: "stale",
  };
  const remaining = found.existing.filter(
    (entry) => entry.relationshipId !== found.scope.relationshipId,
  );
  try {
    deps.store.updateChat(chatId, { gitChangeScopes: [...remaining, staleScope] });
  } catch (error) {
    archiveGitChangeRelationship(deps, workspaceId, staleScope.relationshipId);
    throw error;
  }
  // Final-audit F4: re-mints under the NEW snapshot digest only after the replacement scope is
  // durable. A failed Chat write therefore leaves neither an active replacement edge nor grant.
  const minted = mintGitChangeDescriptionAuthority(deps, staleScope, Date.now());
  archiveGitChangeRelationship(deps, workspaceId, found.scope.relationshipId);
  logGitChangeEvent(deps, "git-change.chat.stale", correlationId, {
    relationshipId: staleScope.relationshipId,
    remoteDigestPrefix: staleScope.remoteDigest.slice(0, 8),
    descriptionAuthorityMinted: minted,
  });
  const result: GitChangeRefreshResult = { status: "stale", scope: staleScope };
  return { status: 200, body: result };
}

function isCurrentComparison(captured: CapturedComparison, found: FoundGitChangeScope): boolean {
  return (
    captured.snapshot.snapshotDigest === found.scope.snapshotDigest &&
    captured.remoteDigest === found.scope.remoteDigest
  );
}

export async function handleGitChangeRefresh(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await readParsedGitDeliveryBody(
    ctx.req,
    () => errResult(413, "GIT_CHANGE_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_CHANGE_BAD_REQUEST"),
  );
  if (!parsed.ok) return parsed.result;
  const request = parseRefreshRequest(parsed.value);
  if (request === undefined) return errResult(400, "GIT_CHANGE_BAD_REQUEST");
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const found = findGitChangeScope(deps, request.chatId, request.relationshipId);
  if (found === undefined) return errResult(404, "GIT_CHANGE_SCOPE_NOT_FOUND");

  const runner = observedGitRunner(
    defaultGitProcessRunner,
    deps.activityLog ?? processServerLogSink(),
    correlationId,
  );
  const repository = await resolveChatRepository(found.chatProjectPath, runner, 30_000);
  if (repository === undefined) {
    return blockedRefreshResult(deps, correlationId, "chat-project-unavailable");
  }
  const captured = await captureComparison(
    deps,
    repository.repositoryRoot,
    found.scope.baseRef,
    found.scope.headRef,
    correlationId,
  );
  if (typeof captured === "string") return blockedRefreshResult(deps, correlationId, captured);

  if (isCurrentComparison(captured, found)) {
    logGitChangeEvent(deps, "git-change.chat.refreshed", correlationId, {
      relationshipId: found.scope.relationshipId,
    });
    const result: GitChangeRefreshResult = { status: "current", scope: found.scope };
    return { status: 200, body: result };
  }
  return persistStaleScope(ctx, deps, request.chatId, found, captured, correlationId);
}

// ─── Route group ────────────────────────────────────────────────────────────────────────────────

export const GIT_CHANGE_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/git-change/connect", handler: handleGitChangeConnect },
  { method: "POST", pattern: "/api/git-change/refresh", handler: handleGitChangeRefresh },
];
