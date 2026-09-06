// Governed GitHub pull request "mark ready" (draft->ready) execution (#3389, epic #3384, ADR-0086).
//
//   * POST /api/git-delivery/pr/mark-ready/approve — Mints the one-use approval claim the draft->ready
//       transition requires. The claim binds the canonical repository (remoteDigest), the exact PR
//       identity, the base/head SHAs the caller currently observes, a digest over the readiness
//       snapshot that justified the proposal, and a digest over the transition payload itself — never
//       a title/body/base PATCH, which this intent never carries.
//   * POST /api/git-delivery/pr/mark-ready/execute — Governed. Immediately before the mutation,
//       re-reads the live PR identity (refuses, no spawn, on any head/base/draft mismatch against the
//       claim) AND independently re-derives the live requirements/conflict facts (the SAME
//       `assessGitCiFacts` requirements digest the journey read's `ReadinessSnapshot` carries) and
//       refuses on a digest mismatch, an incomplete read, or a live merge conflict — a readinessDigest
//       is never merely trusted from the client, mint or otherwise (#3389 repair, correction 2). It
//       then runs ONLY the existing `buildPrMarkReadyGraphqlArgv` GraphQL mutation (git-pr-node.ts) —
//       no PATCH; then re-reads the PR identity again and reports success only when the read-back
//       confirms `isDraft === false` on the same head. Any mismatch at any read revokes the claim's
//       effect and performs nothing further. The transition is reachable ONLY through this route
//       (correction 1): the generic `pr-update` command rejects `convertFromDraft` unconditionally
//       (prRoutes.ts).
//
// The coding runtime exposes neither merge, auto-merge scheduling, nor issue-close mutations: every
// spawn this execute path can ever produce is a PR-identity read, a bounded read-only CI-facts read
// (`createNodeGitCiReader` — the same read-only port the CI observation service and the journey read
// already use), or the fixed `markPullRequestReadyForReview` GraphQL mutation (git-pr-node.test.ts
// pins the mutation's own adapter structurally; none of these reads reference a merge or issue-close
// endpoint).
//
// Content-free in evidence: only ids, digests, states and counts leave this module on the activity
// log — never a title, body, or raw provider payload.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { GitDeliveryApprovalClaim } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  GitPrMarkReadyExecResult,
  GitPullRequestMarkReadyAdapter,
} from "@oscharko-dev/keiko-tools";
import {
  assessGitCiFacts,
  createNodeGitCiReader,
  createNodeGitPullRequestAdapter,
  type GitCiFactsResult,
  type GitCiProviderReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import { produceCiReadinessSnapshot } from "./ciReadinessSnapshot.js";
import { gitDeliveryTerminationHandler, logGitDeliveryNoSpawnRefusal } from "./execution.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalBinding,
  type GitDeliveryApprovalStore,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isOwnerAndRepo,
  isPlainObject,
  isPrNumberString,
  isSafeGitRef,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";
import {
  gitDeliveryAuthorityContinuityGuard,
  gitDeliveryAuthorityGate,
  prepareGitDeliveryRequest,
  type GitDeliveryAuthorityContinuityDenialCapture,
  type GitDeliveryAuthorityIdentity,
  type GitDeliveryRequestErrors,
} from "./requestPreparation.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

type GitDeliveryPrMarkReadyErrorCode =
  | "GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST"
  | "GIT_DELIVERY_PR_MARK_READY_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_PR_MARK_READY_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_PR_MARK_READY_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_PR_MARK_READY_EXECUTION_FAILED"
  | "GIT_DELIVERY_PR_MARK_READY_WORKTREE_UNAVAILABLE"
  | "GIT_DELIVERY_PR_MARK_READY_REPOSITORY_MISMATCH";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryPrMarkReadyErrorCode, string>> = {
  GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST: "The request body is not a valid mark-ready proposal.",
  GIT_DELIVERY_PR_MARK_READY_PAYLOAD_TOO_LARGE: "The mark-ready request exceeds the maximum size.",
  GIT_DELIVERY_PR_MARK_READY_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials or auth headers.",
  GIT_DELIVERY_PR_MARK_READY_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_PR_MARK_READY_EXECUTION_FAILED:
    "The mark-ready operation could not be completed. Refresh the pull request and try again.",
  GIT_DELIVERY_PR_MARK_READY_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
  // #3384 B5-8: the workspace's own `origin` remote does not resolve to the requested repository.
  GIT_DELIVERY_PR_MARK_READY_REPOSITORY_MISMATCH:
    "The requested repository does not match this project's own Git remote.",
};

const errResult = (status: number, code: GitDeliveryPrMarkReadyErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const MARK_READY_REQUEST_ERRORS: GitDeliveryRequestErrors = {
  tooLarge: errResult(413, "GIT_DELIVERY_PR_MARK_READY_PAYLOAD_TOO_LARGE"),
  badRequest: errResult(400, "GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST"),
  unknownProject: errResult(404, "GIT_DELIVERY_PR_MARK_READY_UNKNOWN_PROJECT"),
  repositoryMismatch: errResult(403, "GIT_DELIVERY_PR_MARK_READY_REPOSITORY_MISMATCH"),
};

// #3384 B5-8: the ONE place this route group names its request's GitHub mutation target for
// `prepareGitDeliveryRequest`'s repository-binding check.
function markReadyOwnerAndRepoOf(value: ValidatedMarkReadyRequest): string {
  return value.command.ownerAndRepo;
}

// ─── Request parsing ────────────────────────────────────────────────────────────────────────────

const READINESS_DIGEST_RE = /^[a-f0-9]{64}$/u;

function isReadinessDigest(value: unknown): value is string {
  return typeof value === "string" && READINESS_DIGEST_RE.test(value);
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "ownerAndRepo",
  "prExternalId",
  "headSha",
  "baseSha",
  "baseRef",
  "readinessDigest",
  "approval",
]);

/** The proposal facts the mint binds and the execute re-verifies. Never carries title/body/base. */
export interface PrMarkReadyCommand {
  readonly kind: "pr-mark-ready";
  readonly ownerAndRepo: string;
  readonly remoteDigest: string;
  readonly prExternalId: string;
  readonly headSha: string;
  readonly baseSha: string;
  // The PR's base branch NAME (not a SHA) — carried alongside baseSha purely so the live
  // requirements/conflict re-read (#3389 repair, correction 2) can address the branch-protection and
  // required-checks endpoints, which GitHub keys by branch name. Bound like every other field: a
  // mismatch against the live PR fails the same way a headSha/baseSha mismatch already does.
  readonly baseRef: string;
  readonly readinessDigest: string;
  readonly currentDraftState: true;
  readonly transitionPayloadDigest: string;
}

interface ValidatedMarkReadyRequest {
  readonly projectId: string;
  readonly command: PrMarkReadyCommand;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedMarkReadyRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

// The transition performs no title/body/base mutation of its own, so its "payload" is the fixed
// GraphQL mutation identity (git-pr-node.ts's buildPrMarkReadyGraphqlArgv) scoped to this exact PR —
// a digest, not a client input, so a claim can never be minted against a different transition shape.
function transitionPayloadDigest(ownerAndRepo: string, prExternalId: string): string {
  return sha256Hex(
    canonicalise({ domain: "keiko-pr-mark-ready-transition-v1", ownerAndRepo, prExternalId }),
  );
}

// A base branch NAME operand (not a SHA): the shared ref guard plus the same "no refs/ prefix"
// requirement `GitCiReadTarget`'s own builder enforces (git-ci-read-argv.ts), so a malformed value
// fails this parse with a clean 400 rather than surfacing as a live-read internal error later.
function isBaseBranchName(value: unknown): value is string {
  return isSafeGitRef(value) && !value.startsWith("refs/");
}

function buildMarkReadyCommand(parsed: Record<string, unknown>): PrMarkReadyCommand | undefined {
  if (
    !isOwnerAndRepo(parsed.ownerAndRepo) ||
    !isPrNumberString(parsed.prExternalId) ||
    !isGitObjectId(parsed.headSha) ||
    !isGitObjectId(parsed.baseSha) ||
    !isBaseBranchName(parsed.baseRef) ||
    !isReadinessDigest(parsed.readinessDigest)
  ) {
    return undefined;
  }
  return {
    kind: "pr-mark-ready",
    ownerAndRepo: parsed.ownerAndRepo,
    remoteDigest: codingWorkbenchRemoteDigest(parsed.ownerAndRepo),
    prExternalId: parsed.prExternalId,
    headSha: parsed.headSha,
    baseSha: parsed.baseSha,
    baseRef: parsed.baseRef,
    readinessDigest: parsed.readinessDigest,
    currentDraftState: true,
    transitionPayloadDigest: transitionPayloadDigest(parsed.ownerAndRepo, parsed.prExternalId),
  };
}

function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_MARK_READY_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST");
  }
  return undefined;
}

function validate(parsed: unknown): Validation {
  const bad: Validation = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST"),
  };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_KEYS)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const command = buildMarkReadyCommand(parsed);
  const approval = parseGitDeliveryApprovalRequest(parsed.approval);
  if (command === undefined || approval === undefined) return bad;
  return { kind: "ok", value: { projectId: parsed.projectId, command, approval } };
}

// ─── Approval binding ───────────────────────────────────────────────────────────────────────────

function markReadyApprovalBinding(
  projectId: string,
  command: PrMarkReadyCommand,
  authority: GitDeliveryAuthorityIdentity,
): GitDeliveryApprovalBinding {
  return {
    projectId,
    operation: "pr-mark-ready",
    command,
    runId: authority.runId,
    envelopeDigest: authority.envelopeDigest,
  };
}

// ─── Options (test-only override seam, mirrors GitDeliveryPrRouteOptions) ─────────────────────

export interface GitDeliveryPrMarkReadyRouteOptions {
  readonly adapterFactory?:
    ((workspace: WorkspaceInfo) => GitPullRequestMarkReadyAdapter) | undefined;
  // Test-only override seam for the live requirements/conflict re-read (mirrors adapterFactory);
  // production composition never sets this — it defaults to the real `createNodeGitCiReader`.
  readonly ciReaderFactory?: ((workspace: WorkspaceInfo) => GitCiProviderReader) | undefined;
  readonly approvalStore?: GitDeliveryApprovalStore | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly now?: (() => number) | undefined;
  readonly beforeRemoteDispatch?: (() => boolean) | undefined;
}

function markReadyAdapterFor(
  workspace: WorkspaceInfo,
  options: GitDeliveryPrMarkReadyRouteOptions,
  correlationId: string | undefined,
): GitPullRequestMarkReadyAdapter {
  if (options.adapterFactory !== undefined) return options.adapterFactory(workspace);
  return createNodeGitPullRequestAdapter({
    workspace,
    processEnv: process.env,
    now: options.now ?? Date.now,
    onTerminated: gitDeliveryTerminationHandler(options, correlationId),
  });
}

function ciReaderFor(
  workspace: WorkspaceInfo,
  options: GitDeliveryPrMarkReadyRouteOptions,
  correlationId: string | undefined,
  stillAuthorized: () => boolean,
): GitCiProviderReader {
  if (options.ciReaderFactory !== undefined) return options.ciReaderFactory(workspace);
  return createNodeGitCiReader({
    workspace,
    processEnv: process.env,
    now: options.now ?? Date.now,
    onTerminated: gitDeliveryTerminationHandler(options, correlationId),
    stillAuthorized,
  });
}

// #3389 repair (review finding, correction 2): "re-reading requirements/conflict immediately before
// execution" — a live, independent re-derivation of the SAME requirements digest the claim's
// readinessDigest is bound to (assessGitCiFacts's requirementsDigest — the exact value the journey
// read's ReadinessSnapshot carries), plus the live merge-conflict fact. An incomplete read, a digest
// mismatch (including one that was never real), or a live conflict all revoke the claim the same way
// a head/base mismatch does — the digest is never merely trusted from the client. Reuses the same
// read-only `GitCiProviderReader` port the CI observation service and the journey read already use;
// no second formula, no new provider read shape.
interface LiveReadinessCheck {
  readonly drifted: boolean;
  readonly readFailure?: { readonly error: unknown };
}

async function liveReadinessDrifted(
  reader: GitCiProviderReader,
  command: PrMarkReadyCommand,
): Promise<LiveReadinessCheck> {
  let facts: GitCiFactsResult;
  try {
    facts = await reader.readFacts({
      ownerAndRepo: command.ownerAndRepo,
      prExternalId: command.prExternalId,
      baseBranchName: command.baseRef,
      headSha: command.headSha,
    });
  } catch (error) {
    return { drifted: true, readFailure: { error } };
  }
  if (facts.status !== "observed") return { drifted: true };
  const assessment = assessGitCiFacts(facts);
  return {
    drifted:
      !assessment.complete ||
      assessment.requirementsDigest !== command.readinessDigest ||
      assessment.pullRequest.conflict === "conflicting",
  };
}

interface PostTransitionObservationInput {
  readonly deps: UiHandlerDeps;
  readonly options: GitDeliveryPrMarkReadyRouteOptions;
  readonly correlationId: string;
  readonly runId: string;
  readonly command: PrMarkReadyCommand;
  readonly reader: GitCiProviderReader;
  readonly stillAuthorized: () => boolean;
}

function logPostTransitionObservation(
  input: PostTransitionObservationInput,
  recorded: boolean,
  reason: string,
): void {
  (input.options.activityLog ?? processServerLogSink()).write({
    category: "security",
    op: "git.delivery.pr-mark-ready.readiness-refreshed",
    correlationId: input.correlationId,
    status: 200,
    extra: { runId: input.runId, recorded, reason },
  });
}

function postTransitionSubject(input: PostTransitionObservationInput):
  | {
      readonly draft: DraftDeliveryRecord;
      readonly store: NonNullable<
        NonNullable<UiHandlerDeps["codingRuntimeSnapshotStore"]>["ciReadiness"]
      >;
    }
  | undefined {
  const snapshots = input.deps.codingRuntimeSnapshotStore;
  const draft = snapshots?.get(input.runId)?.draftDelivery;
  const store = snapshots?.ciReadiness;
  return draft?.pullRequest === undefined || store === undefined ? undefined : { draft, store };
}

async function refreshPostTransitionReadiness(
  input: PostTransitionObservationInput,
): Promise<void> {
  if (!input.stillAuthorized()) {
    logPostTransitionObservation(input, false, "authority-denied");
    return;
  }
  const subject = postTransitionSubject(input);
  if (subject === undefined) {
    logPostTransitionObservation(input, false, "store-unavailable");
    return;
  }
  const facts = await input.reader.readFacts({
    ownerAndRepo: input.command.ownerAndRepo,
    prExternalId: input.command.prExternalId,
    baseBranchName: input.command.baseRef,
    headSha: input.command.headSha,
  });
  if (facts.status !== "observed") {
    logPostTransitionObservation(input, false, facts.failure.reason);
    return;
  }
  const now = input.options.now ?? Date.now;
  const { snapshot } = produceCiReadinessSnapshot(subject.draft, facts, now());
  const recorded = subject.store.recordPostDeliveryObservation(input.runId, snapshot);
  const reason = recorded ? "observed" : "stale-observation";
  logPostTransitionObservation(input, recorded, reason);
}

// ─── Logging ────────────────────────────────────────────────────────────────────────────────────

function log(
  activityLog: ServerLogSink | undefined,
  op: string,
  correlationId: string,
  status: number,
  extra: Record<string, unknown>,
): void {
  (activityLog ?? processServerLogSink()).write({
    category: "security",
    op,
    correlationId,
    status,
    extra,
  });
}

function logMarkReadyFailure(
  activityLog: ServerLogSink | undefined,
  correlationId: string,
  phaseReached: "readiness" | "dispatch" | "post-observation",
  error: unknown,
): void {
  (activityLog ?? processServerLogSink()).write({
    category: "diagnostic",
    op: "git.delivery.mutation.failed",
    correlationId,
    level: "error",
    errorKind: errorKindOf(error),
    extra: {
      actionKind: "pr-mark-ready",
      phaseReached,
      frames: keikoStackFrames(error),
      causeChain: causeChain(error),
    },
  });
}

function reportPostObservationFailure(input: PostTransitionObservationInput, error: unknown): void {
  logMarkReadyFailure(input.options.activityLog, input.correlationId, "post-observation", error);
  emitServerDiagnostic(
    input.deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: input.correlationId,
      operation: "POST /api/git-delivery/pr/mark-ready/execute",
      source: "pr-mark-ready-post-observation",
      error,
      summary: "The bounded status read was unavailable.",
      redact: (value): string => String(input.deps.redactor(value)),
    }),
  );
}

// Shared by approve and execute — both run the identical prologue (read/validate/resolve-workspace
// plus the #3384 B5-8 repository-binding check against `markReadyOwnerAndRepoOf`). Extracted purely
// to keep both call sites under the repo's max-lines-per-function bar — no behavioral seam of its
// own.
function prepareMarkReadyRequest(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): ReturnType<typeof prepareGitDeliveryRequest<ValidatedMarkReadyRequest>> {
  return prepareGitDeliveryRequest(
    ctx,
    deps,
    MARK_READY_REQUEST_ERRORS,
    validate,
    markReadyOwnerAndRepoOf,
  );
}

// ─── Approve handler (mints the server-issued approval claim execute consumes) ────────────────────

export interface GitDeliveryPrMarkReadyApproveResponseBody {
  readonly schemaVersion: "1";
  readonly approval: GitDeliveryApprovalClaim;
  readonly expiresAt: string;
}

export const createHandlePrMarkReadyApprove = (
  options: GitDeliveryPrMarkReadyRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareMarkReadyRequest(ctx, deps);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command } = prepared.value;
    const authority = gitDeliveryAuthorityGate(
      ctx,
      deps,
      projectId,
      workspace,
      "pull-request",
      {},
      {
        logSink: options.activityLog,
        // Final-audit F2/#3390 (ADR-0138 D2, #3389): pr-mark-ready's own execute path already
        // enforces a mandatory, mode-independent consumed approval below, so this coarse admission
        // layer defers to it instead of demanding a second claim.
        deliveryApprovalDeferred: true,
      },
    );
    if (!authority.allowed) return authority.result;
    const store = options.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const issued = store.issue({
      binding: markReadyApprovalBinding(projectId, command, authority),
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: (options.now ?? Date.now)(),
    });
    log(options.activityLog, "git.delivery.pr-mark-ready.approval.minted", correlationId, 200, {
      runId: authority.runId,
      prExternalId: command.prExternalId,
    });
    const body: GitDeliveryPrMarkReadyApproveResponseBody = {
      schemaVersion: "1",
      approval: issued.approval,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Execute handler (governed) ───────────────────────────────────────────────────────────────

export interface GitDeliveryPrMarkReadyExecuteResponseBody {
  readonly schemaVersion: "1";
  readonly actionKind: "pr-mark-ready";
  readonly status: "succeeded" | "failed" | "aborted" | "approval-required";
  readonly executionErrorCode?: string;
  readonly rejectionReason?: string;
}

function markReadyExecuteResponse(
  result: GitPrMarkReadyExecResult,
): GitDeliveryPrMarkReadyExecuteResponseBody {
  const base = { schemaVersion: "1" as const, actionKind: "pr-mark-ready" as const };
  if (result.outcome === "succeeded") return { ...base, status: "succeeded" };
  if (result.outcome === "aborted") return { ...base, status: "aborted" };
  return {
    ...base,
    status: "failed",
    ...(result.errorCode !== undefined ? { executionErrorCode: result.errorCode } : {}),
    ...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
  };
}

function markReadyApprovalRequiredBlock(deps: Pick<UiHandlerDeps, "redactor">): RouteResult {
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "approval-required",
      actionKind: "pr-mark-ready",
    }),
  };
}

interface GovernedMarkReadyDispatch {
  readonly deps: UiHandlerDeps;
  readonly runId: string;
  readonly command: PrMarkReadyCommand;
  readonly workspace: WorkspaceInfo;
  readonly options: GitDeliveryPrMarkReadyRouteOptions;
  readonly correlationId: string;
  readonly continuityGuard: () => boolean;
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly redact: (value: string) => string;
}

function reportReadinessFailure(input: GovernedMarkReadyDispatch, error: unknown): void {
  logMarkReadyFailure(input.options.activityLog, input.correlationId, "readiness", error);
  emitServerDiagnostic(
    input.diagnostics,
    serverDiagnosticFromError({
      correlationId: input.correlationId,
      operation: "POST /api/git-delivery/pr/mark-ready/execute",
      source: "pr-mark-ready-ci-read",
      error,
      summary: "The bounded status read was unavailable.",
      redact: input.redact,
    }),
  );
}

// #3389 (AC3): the continuity guard runs immediately before the actual `gh` dispatch, mirroring the
// generic PR/push/merge routes — a run whose authority was revoked or replaced between admission and
// this attempt never reaches the adapter (F4: logged, never a real spawn).
async function dispatchGovernedMarkReady(
  input: GovernedMarkReadyDispatch,
): Promise<GitPrMarkReadyExecResult> {
  const { command, workspace, options, correlationId, continuityGuard } = input;
  if (!continuityGuard()) {
    logGitDeliveryNoSpawnRefusal(
      options.activityLog ?? processServerLogSink(),
      "pr-mark-ready",
      correlationId,
    );
    return { schemaVersion: "1", outcome: "aborted", durationMs: 0 };
  }
  const reader = ciReaderFor(workspace, options, correlationId, continuityGuard);
  const readiness = await liveReadinessDrifted(reader, command);
  if (readiness.readFailure !== undefined) {
    reportReadinessFailure(input, readiness.readFailure.error);
  }
  if (readiness.drifted) {
    return {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 0,
      errorCode: "precondition-failed",
    };
  }
  const adapter = markReadyAdapterFor(workspace, options, correlationId);
  const result = await adapter.markPullRequestReady({
    ownerAndRepo: command.ownerAndRepo,
    prExternalId: command.prExternalId,
    expectedHeadSha: command.headSha,
    expectedBaseSha: command.baseSha,
  });
  if (result.outcome === "succeeded") {
    const observation = {
      deps: input.deps,
      options,
      correlationId,
      runId: input.runId,
      command,
      reader,
      stillAuthorized: continuityGuard,
    };
    try {
      await refreshPostTransitionReadiness(observation);
    } catch (error) {
      reportPostObservationFailure(observation, error);
    }
  }
  return result;
}

function logMarkReadyOutcome(
  options: GitDeliveryPrMarkReadyRouteOptions,
  correlationId: string,
  command: PrMarkReadyCommand,
  result: GitPrMarkReadyExecResult,
): void {
  const isDrift = result.outcome === "failed" && result.errorCode === "precondition-failed";
  log(
    options.activityLog,
    isDrift ? "git.delivery.pr-mark-ready.drift" : "git.delivery.pr-mark-ready.executed",
    correlationId,
    200,
    { prExternalId: command.prExternalId, outcome: result.outcome },
  );
}

interface MarkReadyDispatchContext {
  readonly projectId: string;
  readonly workspace: WorkspaceInfo;
  readonly command: PrMarkReadyCommand;
  readonly authority: GitDeliveryAuthorityIdentity;
  readonly options: GitDeliveryPrMarkReadyRouteOptions;
  readonly correlationId: string;
}

// Builds the continuity guard, runs the governed dispatch, and projects the outcome to a RouteResult
// — split out of the handler purely to keep it under the repo's max-lines-per-function bar.
async function dispatchOrBlock(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  input: MarkReadyDispatchContext,
): Promise<RouteResult> {
  const { projectId, workspace, command, authority, options, correlationId } = input;
  const denialCapture: GitDeliveryAuthorityContinuityDenialCapture = {};
  const continuityGuard = gitDeliveryAuthorityContinuityGuard({
    ctx,
    deps,
    projectId,
    workspace,
    operation: "pull-request",
    admitted: authority,
    next: options.beforeRemoteDispatch,
    denialCapture,
    audit: { logSink: options.activityLog, deliveryApprovalDeferred: true },
  });
  try {
    const result = await dispatchGovernedMarkReady({
      deps,
      runId: authority.runId,
      command,
      workspace,
      options,
      correlationId,
      continuityGuard,
      diagnostics: deps.diagnostics,
      redact: (value): string => String(deps.redactor(value)),
    });
    if (denialCapture.result !== undefined) return denialCapture.result;
    logMarkReadyOutcome(options, correlationId, command, result);
    return { status: 200, body: deps.redactor(markReadyExecuteResponse(result)) };
  } catch (error) {
    logMarkReadyFailure(options.activityLog, correlationId, "dispatch", error);
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "POST /api/git-delivery/pr/mark-ready/execute",
        source: "pr-mark-ready-dispatch",
        error,
        summary: "server-operation-failed",
        redact: (value): string => String(deps.redactor(value)),
      }),
    );
    return errResult(502, "GIT_DELIVERY_PR_MARK_READY_EXECUTION_FAILED");
  }
}

async function handleMarkReadyExecute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: GitDeliveryPrMarkReadyRouteOptions,
): Promise<RouteResult> {
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const prepared = await prepareMarkReadyRequest(ctx, deps);
  if (!prepared.ok) return prepared.result;
  const { workspace } = prepared;
  const { projectId, command, approval } = prepared.value;
  const authority = gitDeliveryAuthorityGate(
    ctx,
    deps,
    projectId,
    workspace,
    "pull-request",
    {},
    {
      logSink: options.activityLog,
      deliveryApprovalDeferred: true,
    },
  );
  if (!authority.allowed) return authority.result;
  const verifiedApproval = resolveGitDeliveryApprovalRequirement(approval, {
    store: options.approvalStore,
    binding: markReadyApprovalBinding(projectId, command, authority),
    nowMs: (options.now ?? Date.now)(),
  });
  if (verifiedApproval === undefined)
    return errResult(400, "GIT_DELIVERY_PR_MARK_READY_BAD_REQUEST");
  if (!verifiedApproval.required) {
    log(options.activityLog, "git.delivery.pr-mark-ready.approval.required", correlationId, 200, {
      runId: authority.runId,
      prExternalId: command.prExternalId,
    });
    return markReadyApprovalRequiredBlock(deps);
  }
  return dispatchOrBlock(ctx, deps, {
    projectId,
    workspace,
    command,
    authority,
    options,
    correlationId,
  });
}

export const createHandlePrMarkReadyExecute = (
  options: GitDeliveryPrMarkReadyRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  return (ctx, deps) => handleMarkReadyExecute(ctx, deps, options);
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryPrMarkReadyRouteGroup = (
  options: GitDeliveryPrMarkReadyRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/pr/mark-ready/approve",
    handler: createHandlePrMarkReadyApprove(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr/mark-ready/execute",
    handler: createHandlePrMarkReadyExecute(options),
  },
];
