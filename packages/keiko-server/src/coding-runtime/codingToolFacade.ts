import { isCodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import {
  VERIFIED_COMMIT_BLOCKING_PATHS_MAX,
  type VerifiedCommitBlockingPaths,
} from "../gitDelivery/verifiedCommitTypes.js";
import { isCodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import {
  isCodingRuntimeGitResult,
  type CodingRuntimeGitResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { isVerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { isVerificationKind } from "@oscharko-dev/keiko-contracts/runtime/editor-verification";
import { isCodingRepositoryResult } from "./codingRepositorySearchHandler.js";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  AuxiliaryCapabilityOutcomeV1,
  VerificationFailureLocation,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { validateAuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import {
  isVerificationDependencySummary,
  isVerificationFailureLocation,
  VERIFICATION_DEPENDENCY_FAILURE_STATES,
  VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/verification";

import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  CODING_TOOL_MAX_READ_BYTES,
  CODING_TOOL_VERIFICATION_FAILURE_MAX_LOCATIONS,
  CODING_TOOL_VERIFICATION_SUMMARY_MAX_CHARS,
  dependencyBootstrapFailureSummary,
  isPermissionObservation,
  parseCodingToolRequest,
  type CodingToolActionRequest,
  type CodingToolEgressReadResult,
  type CodingToolReadResult,
  type CodingToolResult,
  type CodingToolVerificationFailure,
  type CodingToolVerificationResult,
  type VerificationNotRunReason,
} from "./codingToolIpc.js";
// KEIKO-0695: hoisted from below EDIT_FAILURE_REASON_CODES to the top-of-file import block.
import type {
  CodingToolAdmission,
  CodingToolFacade,
  CodingToolFacadeInput,
  CodingToolFacadeOptions,
  CodingToolFacadePorts,
} from "./codingToolFacadePorts.js";
import {
  VERIFICATION_RUNNER_ERROR_CODES,
  type VerificationRunnerErrorCode,
} from "../editor/verificationRunnerErrors.js";

const READ_DIGEST = /^[a-f0-9]{64}$/u;
const VERIFICATION_FAILURE_SUMMARY =
  /^(?:test|targeted-test|typecheck|lint|build) failed; (?:0|[2-8]) structured failure locations$|^(?:test|targeted-test|typecheck|lint|build) failed; 1 structured failure location$/u;

// The closed vocabulary an edit failure's `reasonCode` may carry: the two contract-owned closed
// enums (EditorAgentConflictCode + EditorAgentFailureCode) plus this port's own transport /
// no-session / route markers. Sourcing the two contract enums instead of hand-restating them keeps
// this set in lockstep with `keiko-contracts` — every future addition to either canonical list
// reaches the facade without a coordinated edit. Content-free by construction (never raw command
// output, unlike the delegate evidence every other governed action strips), so forwarding one of
// these to the model in place of the bare "failed" status is safe. An unrecognized value (a
// defensive floor, not an expected path) falls back to "failed" rather than forwarding an unvetted
// string.
const EDIT_TRANSPORT_REASON_CODES = [
  "RESPONSE_TOO_LARGE",
  "TRANSPORT_FAILURE",
  "REDIRECT_BLOCKED",
  "EDIT_TRANSPORT_ERROR",
] as const;
// The two refusals the read/edit port raises BEFORE the editor route ever sees the changeset: the
// prepare stage rejected it (malformed changeset, revoked mutation guard, cross-wired producer
// binding), or the workspace access the run is bound to stopped resolving while the port waited for
// a live editor session. Both used to reach the model as a bare "failed", so a governed run whose
// workspace authority had been revoked looked exactly like a retryable editor conflict and the
// agent kept re-issuing the edit (workbench end-to-end run, 2026-09-03).
const EDIT_PORT_REFUSAL_REASON_CODES = [
  "EDIT_PREPARE_FAILED",
  "WORKSPACE_ACCESS_LOST",
  "EDIT_MUTATION_FAILED",
] as const;
const EDIT_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<string>([
  ...EDITOR_AGENT_CONFLICT_CODES,
  ...EDITOR_AGENT_FAILURE_CODES,
  ...EDIT_TRANSPORT_REASON_CODES,
  ...EDIT_PORT_REFUSAL_REASON_CODES,
  "ci-observation-required",
]);
// The verification PORT's own closed markers (productionManagedWorktreeTools.ts), as opposed to the
// runner vocabulary sourced below. The first two are raised BEFORE the runner is called: the run's
// authority or managed-workspace liveness was already gone when the tool call arrived, or the
// sidecar named a verifier this server does not implement (cursor review, PR #3381). The rest
// describe a run the runner actually finished — and only a RED run says VERIFICATION_FAILED: a
// timeout and a resource ceiling name their own cause, and a run that never executed
// (skipped/denied/cancelled) says so, because telling the model its tests failed when they did not
// run sends it back to code that is fine (PR #3381 review). The status→code mapping is exhaustive
// by type at the producer; this list is the vocabulary it may draw from.
const GOVERNED_VERIFICATION_REASON_CODES = [
  "verification-authority-revoked",
  "verification-verifier-unsupported",
  "VERIFICATION_FAILED",
  "VERIFICATION_TIMED_OUT",
  "VERIFICATION_RESOURCE_EXCEEDED",
  "VERIFICATION_NOT_RUN",
] as const;
export type GovernedVerificationReasonCode = (typeof GOVERNED_VERIFICATION_REASON_CODES)[number];
// The three runner codes that can only be minted at the HTTP boundary from the request envelope
// itself (verificationRoutes.ts: a malformed body, an oversized body, a run id naming no in-flight
// run). `runToReport` — the only runner entry point the governed verification port calls — cannot
// answer one, so they stay out of the model-facing set. Everything else in the closed runner
// vocabulary is forwarded, INCLUDING future additions: restating the codes here let a new runner
// refusal collapse back to a bare "failed" with no test failing (PR #3381 review).
const HTTP_ONLY_VERIFICATION_RUNNER_CODES: ReadonlySet<VerificationRunnerErrorCode> = new Set([
  VERIFICATION_RUNNER_ERROR_CODES.BAD_REQUEST,
  VERIFICATION_RUNNER_ERROR_CODES.PAYLOAD_TOO_LARGE,
  VERIFICATION_RUNNER_ERROR_CODES.RUN_NOT_FOUND,
]);
const GOVERNED_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<string>([
  "ci-repair-budget-blocked",
  "ci-observation-required",
  "capability-backend-unavailable",
  "command-backend-unavailable",
  "command-authority-revoked",
  "command-execution-failed",
  "git-authority-revoked",
  "git-proposal-unknown",
  "git-execution-failed",
  "delivery-authority-revoked",
  "connector-authority-revoked",
  "search-authority-revoked",
  ...GOVERNED_VERIFICATION_REASON_CODES,
  // The verification runner's own closed codes (editor/verificationRunnerErrors.ts), sourced rather
  // than restated for the same reason the two contract enums above are. A verification the runner
  // refused used to reach the model as a bare "failed", indistinguishable from a red test run, so
  // the agent re-ran it instead of reporting the blocker (end-to-end run, 2026-09-03).
  ...Object.values(VERIFICATION_RUNNER_ERROR_CODES).filter(
    (code) => !HTTP_ONLY_VERIFICATION_RUNNER_CODES.has(code),
  ),
]);
import type {
  CodingToolInvocationRegistry,
  CodingToolInvocationTakeResult,
} from "./codingToolInvocationRegistry.js";
import type { CanonicalCatalogFacadeBridge } from "../tool-catalog/catalogToolFacadeBridge.js";

// F8 (#3413): an optional, additive extension of CodingToolFacadeOptions. `codingToolFacadePorts.ts`
// stays the single owner of the base shape; this widens only the LOCAL parameter type accepted by
// this file's own composition function, so every existing caller that passes a plain
// CodingToolFacadeOptions (no `catalogBridge`) keeps its exact prior behaviour unchanged.
export interface CodingToolFacadeCreateOptions extends CodingToolFacadeOptions {
  /** Resolves a catalog binding per covered tool call and settles it around the existing handler
   * execution (descriptor, disposition, budget, tool-catalog.* lifecycle log lines). Actions the
   * catalog does not cover dispatch exactly as before -- no behaviour change, no log line. */
  readonly catalogBridge?: CanonicalCatalogFacadeBridge | undefined;
}

export function createCodingToolFacade(
  ports: CodingToolFacadePorts,
  options: CodingToolFacadeCreateOptions = {},
): CodingToolFacade {
  const context: ExecutionContext = {
    ports,
    maxBodyBytes: boundedOption(options.maxBodyBytes, CODING_TOOL_MAX_BODY_BYTES),
    maxInFlight: boundedOption(options.maxInFlight, CODING_TOOL_MAX_IN_FLIGHT),
    invocationRegistry: options.invocationRegistry,
    requireInvocationRegistryForEdits: options.requireInvocationRegistryForEdits === true,
    catalogBridge: options.catalogBridge,
    inFlight: { count: 0 },
  };
  return {
    execute: async (input) => execute(context, input),
  };
}

interface ExecutionContext {
  readonly ports: CodingToolFacadePorts;
  readonly maxBodyBytes: number;
  readonly maxInFlight: number;
  readonly invocationRegistry: CodingToolInvocationRegistry | undefined;
  readonly requireInvocationRegistryForEdits: boolean;
  readonly catalogBridge: CanonicalCatalogFacadeBridge | undefined;
  readonly inFlight: { count: number };
}

async function executeCatalogRequest(
  context: ExecutionContext,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
): Promise<CodingToolResult> {
  const bridge = context.catalogBridge;
  if (bridge === undefined) return empty("denied");
  const delegateState = { threw: false };
  try {
    const result = await bridge.execute(request, input, async (signal, mutationGuard) => {
      try {
        return project(
          request,
          await context.ports.delegate.execute(request, signal, mutationGuard),
        );
      } catch (error) {
        // The canonical settlement owner needs the original stack and cause for ADR-0173.
        // Preserve only the old opaque failure marker here, after that owner has settled.
        delegateState.threw = true;
        throw error;
      }
    });
    return delegateState.threw && result.status === "failed" ? projected("failed") : result;
  } finally {
    if (request.action === "edit" && Buffer.isBuffer(input.body)) input.body.fill(0);
  }
}

async function execute(
  context: ExecutionContext,
  input: CodingToolFacadeInput,
): Promise<CodingToolResult> {
  if (hasOrigin(input.headers)) return empty("denied");
  if (isPermissionObservation(input.body, context.maxBodyBytes)) return empty("observed");
  const request = parseCodingToolRequest(input.body, context.maxBodyBytes);
  if (request === undefined) return empty("invalid");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (context.inFlight.count >= context.maxInFlight) return empty("busy");
  context.inFlight.count += 1;
  try {
    if (context.catalogBridge?.covers(request) === true) {
      return await executeCatalogRequest(context, input, request);
    }
    context.catalogBridge?.recordUnbound(request, input);
    return await executeAdmitted(
      context.ports,
      input,
      request,
      context.invocationRegistry,
      context.requireInvocationRegistryForEdits,
    );
  } finally {
    context.inFlight.count -= 1;
  }
}

async function executeAdmitted(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
  invocationRegistry: CodingToolInvocationRegistry | undefined,
  requireInvocationRegistryForEdits: boolean,
): Promise<CodingToolResult> {
  const admission = ports.authority.admit(input.capability, request);
  if (!admission.ok) return empty("denied");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (!admission.mutationGuard.check()) return empty("denied");
  if (request.action === "edit" && invocationRegistry !== undefined) {
    return executeStagedEdit(ports, input, request, admission, invocationRegistry);
  }
  if (request.action === "edit" && requireInvocationRegistryForEdits) return empty("denied");
  return executePlainAction(ports, input, request, admission);
}

// F8 (#3413): every non-edit action's delegate call, optionally resolved as a catalog binding and
// settled by `catalogBridge` around the exact same call -- split out so `executeAdmitted` stays
// under the file's own complexity ceiling.
async function executePlainAction(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
  admission: Extract<CodingToolAdmission, { readonly ok: true }>,
): Promise<CodingToolResult> {
  const runDelegate = (): Promise<unknown> =>
    ports.delegate.execute(request, input.signal, admission.mutationGuard);
  try {
    const outcome = await runDelegate();
    return project(request, outcome);
  } catch {
    return projected("failed");
  }
}

async function executeStagedEdit(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: Extract<CodingToolActionRequest, { readonly action: "edit" }>,
  admission: Extract<CodingToolAdmission, { readonly ok: true }>,
  registry: CodingToolInvocationRegistry,
): Promise<CodingToolResult> {
  const binding = admission.binding ?? admission.mutationGuard.binding;
  const payload = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  if (binding === undefined) return wipeAndReturn(payload, empty("denied"));
  const identity = {
    runId: binding.runId,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
  };
  const staged = registry.stage({
    ...identity,
    digest: createHash("sha256").update(payload).digest("hex"),
    authorityExpiresAt: binding.expiresAt,
    payload,
  });
  if (staged.kind !== "staged") {
    return wipeAndReturn(payload, empty(staged.kind === "busy" ? "busy" : "denied"));
  }
  const claimed = registry.take(identity);
  if (claimed.kind !== "ready") return wipeAndReturn(payload, empty("denied"));
  try {
    return await executeClaimedEdit(ports, input, request, admission, claimed);
  } finally {
    registry.settle(identity);
  }
}

// F8 (#3413): the ONE production path a governed `edit` actually takes (a real invocation registry
// is always supplied in production, per `createRuntimeCodingToolFacade`'s
// `requireInvocationRegistryForEdits: true`) -- so `keiko.changeset.edit` coverage belongs here,
// not only in the plain-action path `executeStagedEdit`'s caller never reaches for `edit`. Wraps
// the exact same single delegate call `executePlainAction` wraps, with the same denied-fault
// branch; the staging/claim/wipe security path above and the post-delegate cancellation recheck
// below are both untouched.
async function executeClaimedEdit(
  ports: CodingToolFacadePorts,
  input: CodingToolFacadeInput,
  request: Extract<CodingToolActionRequest, { readonly action: "edit" }>,
  admission: Extract<CodingToolAdmission, { readonly ok: true }>,
  claimed: Extract<CodingToolInvocationTakeResult, { readonly kind: "ready" }>,
): Promise<CodingToolResult> {
  const signal =
    input.signal === undefined ? claimed.signal : AbortSignal.any([input.signal, claimed.signal]);
  if (isAborted(signal)) return empty("cancelled");
  const runDelegate = (): Promise<unknown> =>
    ports.delegate.execute(request, signal, admission.mutationGuard);
  try {
    const result = await runDelegate();
    return isAborted(signal) ? empty("cancelled") : project(request, result);
  } catch {
    return projected("failed");
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function wipeAndReturn<T extends CodingToolResult>(payload: Buffer, result: T): T {
  payload.fill(0);
  return result;
}

function outcomeRecord(
  value: unknown,
): (Record<string, unknown> & { readonly outcome: "completed" | "failed" }) | undefined {
  if (!isRecord(value)) return undefined;
  return value.outcome === "completed" || value.outcome === "failed"
    ? (value as Record<string, unknown> & { readonly outcome: "completed" | "failed" })
    : undefined;
}

function project(request: CodingToolActionRequest, input: unknown): CodingToolResult {
  const value = outcomeRecord(input);
  if (value === undefined) return projected("failed");
  const editFailure = projectEditFailure(request, value);
  if (editFailure !== undefined) return editFailure;
  if (value.outcome === "failed") return projectGovernedFailure(request, value);
  const domain = projectDomainResult(request, value);
  if (domain !== undefined) return domain;
  const auxiliary = projectAuxiliary(request, value.auxiliary);
  if (auxiliary !== undefined) {
    return {
      status: "completed",
      evidence: [{ kind: "governed-delegate", code: "completed" }],
      auxiliary,
    };
  }
  if (request.action === "skill" || request.action === "child-agent") return projected("failed");
  const read = projectPayload(request, value.read);
  return read === undefined
    ? projected(value.outcome)
    : { status: "completed", evidence: [{ kind: "governed-delegate", code: "completed" }], read };
}

function isCodingToolVerificationResult(value: unknown): value is CodingToolVerificationResult {
  if (!isRecord(value)) return false;
  if (value.commitProof === "recorded") return Object.keys(value).length === 1;
  if (value.commitProof !== "unavailable") return false;
  if (value.reasonCode === "candidate-drift") {
    return value.nextAction === "verify-again" && Object.keys(value).length === 3;
  }
  return (
    value.reasonCode === "candidate-not-staged" &&
    value.nextAction === "stage-then-verify" &&
    (value.blocking === undefined
      ? Object.keys(value).length === 3
      : Object.keys(value).length === 4 && isVerifiedCommitBlockingPaths(value.blocking))
  );
}

// Bounded, workspace-relative and exact-keyed, like every other payload crossing this boundary. A
// path is held to the repository's one root-relative identifier contract, never a POSIX-only
// approximation of it: drive, rooted, backslash and NUL forms are refused as surely as "..".
function isVerifiedCommitBlockingPaths(value: unknown): value is VerifiedCommitBlockingPaths {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return (
    isBlockingCount(value.unstagedCount) &&
    isBlockingCount(value.untrackedCount) &&
    isBlockingPathList(value.unstaged) &&
    isBlockingPathList(value.untracked)
  );
}

function isBlockingCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBlockingPathList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= VERIFIED_COMMIT_BLOCKING_PATHS_MAX &&
    value.every(
      (path) =>
        typeof path === "string" && path.length <= 512 && isRootRelativeFileIdentifier(path),
    )
  );
}

// The three closed, already-typed domain payloads a governed delegate outcome may carry, tried in
// a fixed order so `project()` itself stays a single flat dispatch instead of inlining every
// action's own branching (each helper already returns `undefined` for an action it does not own).
function projectDomainResult(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  return (
    projectRuntimeGit(request, value) ??
    projectVerifiedCommit(request, value) ??
    projectSearch(request, value) ??
    projectVerification(request, value)
  );
}

function projectVerification(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action !== "verification" || !isCodingToolVerificationResult(value.verification))
    return undefined;
  return {
    status: "completed",
    evidence: [{ kind: "governed-delegate", code: "completed" }],
    verification: value.verification,
  };
}

function projectRuntimeGit(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action === "git" && request.operation === "ci")
    return isCodingRuntimeCiResult(value.ci)
      ? {
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: "completed" }],
          ci: value.ci,
        }
      : projected("failed");
  if (request.action === "git" && request.operation !== "read" && request.operation !== "write")
    return isCodingRuntimeGitResult(value.git)
      ? {
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: "completed" }],
          git: value.git,
          ...stageGuidance(value.git),
        }
      : projected("failed");
  return undefined;
}

// Owner audit finding b2-5: a `draftDelivery` payload shaped `{ status: "unavailable", reason }`
// (no lease granted, or the delivery service busy — CodingRuntimeDeliveryResult, contracts) proves
// nothing was recorded. Reporting it as a "completed" delivery tells the model its push or PR
// succeeded when it did not. Only `status: "recorded"` rides out as completed; `"unavailable"`
// collapses to the facade's own closed "failed" reasonCode vocabulary, the same shape
// `projectGovernedFailure` already uses for a governed refusal.
function projectDraftDelivery(value: Record<string, unknown>): CodingToolResult {
  if (!isCodingRuntimeDeliveryResult(value.draftDelivery)) return projected("failed");
  if (value.draftDelivery.status === "unavailable")
    return projected("failed", value.draftDelivery.reason, true);
  const disposition = approvalDisposition(value);
  if (disposition === false) return projected("failed");
  return {
    status: "completed",
    evidence: [{ kind: "governed-delegate", code: "completed" }],
    draftDelivery: value.draftDelivery,
    ...(disposition === undefined ? {} : { approvalDisposition: disposition }),
  };
}

function approvalDisposition(value: Record<string, unknown>): "ready" | false | undefined {
  if (!Object.hasOwn(value, "approvalDisposition")) return undefined;
  return value.approvalDisposition === "ready" ? "ready" : false;
}

function projectVerifiedCommit(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (isDraftToolRequest(request)) return projectDraftDelivery(value);
  if (request.action === "delivery" && request.intent === "commit") {
    const disposition = approvalDisposition(value);
    return isVerifiedCommitResult(value.verifiedCommit) && disposition !== false
      ? {
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: value.verifiedCommit.status }],
          verifiedCommit: value.verifiedCommit,
          ...(disposition === undefined ? {} : { approvalDisposition: disposition }),
        }
      : projected("failed");
  }
  return undefined;
}

// A search's OWN outcome (`ok: false`, e.g. scope-denied/file-too-large/cancelled/timeout) is
// content-free by construction (CodingRepositoryFailureReason) and rides out on a "completed"
// governed-delegate outcome, exactly like a search hit — only a pre-invoke authority/backend
// refusal (no live workspace, revoked mid-request) produces the outer "failed" status above.
function projectSearch(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action !== "search") return undefined;
  return isCodingRepositoryResult(value.search)
    ? {
        status: "completed",
        evidence: [
          { kind: "governed-delegate", code: value.search.ok ? "completed" : value.search.reason },
        ],
        search: value.search,
      }
    : projected("failed");
}

function projectGovernedFailure(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult {
  const reasonCode = value.reasonCode;
  if (typeof reasonCode !== "string" || !GOVERNED_FAILURE_REASON_CODES.has(reasonCode)) {
    return projected("failed");
  }
  const result = {
    ...projected("failed", reasonCode, true),
    ...governedFailureCoaching(request, reasonCode),
    ...verificationNotRunDetail(request, reasonCode, value.notRun),
  };
  const verificationFailure =
    request.action === "verification" && reasonCode === "VERIFICATION_FAILED"
      ? codingToolVerificationFailure(value.verificationFailure)
      : undefined;
  return verificationFailure === undefined
    ? result
    : {
        status: "failed",
        reasonCode,
        evidence: [{ kind: "governed-delegate", code: reasonCode }],
        verificationFailure,
      };
}

// What the model is told about a governed refusal it can act on, by action and closed reasonCode.
// Verification: the runner refused for want of package-script trust (ADR-0147 D3) — only the
// operator can change that state, in the Coding Workbench header; the bare code left the model to
// retry the verifier or route around it (Coding Workbench run 8, 2026-09-10). Git: the two runtime
// Git service refusals that are the model's to repair (runtimeGitService.ts) — a stale proposal id
// and a thrown Git failure — which used to reach it as a revoked authority (run 13, 2026-09-10).
const GOVERNED_FAILURE_GUIDANCE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  verification: {
    WORKSPACE_TRUST_REQUIRED:
      "Package scripts in this workspace may not run yet: either the repository's scripts were never allowed, or this run changed package.json and the operator has to allow the rewritten scripts. Only the operator can allow them, in the Coding Workbench header. Report this blocker, do not retry verification until it has been allowed, and never run the scripts another way.",
    // F74 (Coding Workbench run 24): a verifier with nothing to run answered a bare code, and the
    // model picked another verifier at once without knowing why. A run cancelled after a passing
    // step still checked something, so the guidance claims no more than the named steps (PR #3452).
    VERIFICATION_NOT_RUN:
      "Not every verification step ran; where the detail names a step, it says why. A missing script means package.json defines no script for that verifier: choose a verifier the repository defines, or add the script as part of your change. Dependencies that did not install, a policy denial or a cancellation are blockers to report. Do not retry the same verifier unchanged.",
  },
  git: {
    "git-proposal-unknown":
      "This proposal id cannot be redeemed: it was never proposed in this run, was already redeemed, or has expired. Propose the change again with the proposing tool and redeem the new id promptly.",
    "git-execution-failed":
      "Git could not complete this operation. Read keiko_git_status, then retry once against the current state; if it fails again, report the blocker instead of working around it.",
  },
};

function governedFailureCoaching(
  request: CodingToolActionRequest,
  reasonCode: string,
): { readonly guidance?: string } {
  const guidance = GOVERNED_FAILURE_GUIDANCE[request.action]?.[reasonCode];
  return guidance === undefined ? {} : { guidance };
}

// The steps of a verification that never executed, in closed words (F74). The port builds them from
// its own report; they are still checked here, like every value the facade forwards to the model.
const NOT_RUN_WORDS: Readonly<Record<VerificationNotRunReason, string>> = {
  "script-missing": "no such script in package.json",
  "dependencies-unavailable": "dependencies did not install",
  denied: "denied by policy",
  cancelled: "cancelled",
  skipped: "skipped",
};

function isNotRunStep(value: unknown): value is { kind: string; reason: VerificationNotRunReason } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "reason" in value &&
    isVerificationKind(value.kind) &&
    typeof value.reason === "string" &&
    Object.hasOwn(NOT_RUN_WORDS, value.reason)
  );
}

function verificationNotRunDetail(
  request: CodingToolActionRequest,
  reasonCode: string,
  notRun: unknown,
): { readonly detail?: string } {
  if (request.action !== "verification" || reasonCode !== "VERIFICATION_NOT_RUN") return {};
  const steps = Array.isArray(notRun) ? notRun.filter(isNotRunStep).slice(0, 5) : [];
  if (steps.length === 0) return {};
  const named = steps.map((step) => `${step.kind} (${NOT_RUN_WORDS[step.reason]})`);
  return { detail: `These verification steps did not run: ${named.join(", ")}.` };
}

// A stage proposal the runtime Git service blocks at admission is a complete Git result, not a
// failure, and its closed reason alone left the model guessing (run 13, 2026-09-10). Each admission
// reason carries the one recovery the model can perform itself; the policy and preflight blocks
// keep their own findings and need none.
const STAGE_BLOCKED_GUIDANCE: Readonly<Record<string, string>> = {
  "selection-unreviewed":
    "At least one requested path is not a pending change Git lists for this worktree: it is unchanged, absent, a directory, in conflict, or hidden behind a truncated change list. Read keiko_git_status and request exactly the file paths it lists as changed and not conflicted.",
  "buffers-dirty":
    "An editor session holds unsaved changes in this workspace, so the bytes to stage are not settled. Report the blocker; only the operator can save or discard them.",
  "proposal-limit":
    "Too many stage proposals are open. Redeem the ones you need with keiko_git_execute or let them expire before proposing again.",
};

function stageGuidance(result: CodingRuntimeGitResult): { readonly guidance?: string } {
  const guidance =
    result.kind === "stage" && result.status === "blocked"
      ? STAGE_BLOCKED_GUIDANCE[result.reason]
      : undefined;
  return guidance === undefined ? {} : { guidance };
}

const VERIFICATION_FAILURE_KEYS: ReadonlySet<string> = new Set([
  "summary",
  "locations",
  "truncated",
  "excerpt",
  "dependencies",
]);

function codingToolVerificationFailure(value: unknown): CodingToolVerificationFailure | undefined {
  if (!isRecord(value) || !Object.keys(value).every((key) => VERIFICATION_FAILURE_KEYS.has(key))) {
    return undefined;
  }
  if (
    !validVerificationFailureHeader(value) ||
    !validVerificationFailureLocations(value.locations) ||
    !validVerificationFailureExcerpt(value.excerpt) ||
    (value.dependencies !== undefined && !isVerificationDependencySummary(value.dependencies))
  ) {
    return undefined;
  }
  return {
    summary: value.summary,
    locations: value.locations,
    truncated: value.truncated,
    ...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }),
    ...(value.dependencies === undefined ? {} : { dependencies: value.dependencies }),
  };
}

// The orchestrator's redacted output tail (ADR-0126 D3): bounded by the same cap it was cut to.
function validVerificationFailureExcerpt(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS + 1)
  );
}

function validVerificationFailureHeader(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly summary: string; readonly truncated: boolean } {
  if (typeof value.summary !== "string") return false;
  return (
    value.summary.length > 0 &&
    value.summary.length <= CODING_TOOL_VERIFICATION_SUMMARY_MAX_CHARS &&
    summaryNamesItsSubject(value.summary, value.dependencies) &&
    typeof value.truncated === "boolean"
  );
}

// A step failure carries the step's closed summary and no dependency summary; a failed dependency
// bootstrap carries its own closed summary for exactly the state its dependency summary reports.
// Before this, every bootstrap failure failed the step pattern and the facade dropped the whole
// failure (reason, excerpt and dependency summary) before it reached the model (#3452).
function summaryNamesItsSubject(summary: string, dependencies: unknown): boolean {
  if (dependencies === undefined) return VERIFICATION_FAILURE_SUMMARY.test(summary);
  return (
    isVerificationDependencySummary(dependencies) &&
    VERIFICATION_DEPENDENCY_FAILURE_STATES.has(dependencies.state) &&
    summary === dependencyBootstrapFailureSummary(dependencies.state)
  );
}

function validVerificationFailureLocations(
  value: unknown,
): value is readonly VerificationFailureLocation[] {
  if (
    !Array.isArray(value) ||
    value.length > CODING_TOOL_VERIFICATION_FAILURE_MAX_LOCATIONS ||
    Object.keys(value).length !== value.length
  ) {
    return false;
  }
  return value.every(isVerificationFailureLocation);
}

// What the model is told to do next for the refusals it can act on. Fixed sentences keyed by the
// closed reason code -- never derived from content. Before this the model received the bare code
// and, in the probe rehearsal of 2026-09-08, resent the same rejected patch six times and then
// ended its run without delivering (#3390).
const EDIT_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  CONTENT_HASH_MISMATCH:
    "The file changed after the read that produced expectedContentHash; an earlier successful edit of yours changes it too. Re-read the file with keiko_workspace_read and rebuild the patch against its current content and digest. Do not resend the same patch.",
  INVALID_EDITS:
    "The unified diff does not apply to the file as it is now: a hunk's context or line numbers no longer match, the header is malformed, or a listed file is missing from the patch. Re-read the file, copy its exact current lines as context, and submit one fresh patch that declares every file it touches.",
  PRECONDITION_REQUIRED:
    "Read the file with keiko_workspace_read first and bind the edit to the digest that read returns.",
  OUT_OF_SCOPE:
    "The path is outside the workspace or protected by policy. This is a decision, not a transient error; do not retry it.",
};
// The refusals whose route sentence is structural (paths, hunk indexes, line numbers) and therefore
// safe to show; every other code keeps the code alone.
const EDIT_FAILURE_DETAIL_REASON_CODES: ReadonlySet<string> = new Set([
  "CONTENT_HASH_MISMATCH",
  "INVALID_EDITS",
  "PRECONDITION_REQUIRED",
  "OUT_OF_SCOPE",
]);
// One printable ASCII line, bounded: anything else is not a route sentence and is dropped.
const EDIT_FAILURE_DETAIL = /^[\x20-\x7e]{1,240}$/u;

function projectEditFailure(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action !== "edit" || value.outcome !== "failed") return undefined;
  const reasonCode = value.reasonCode;
  const safeReasonCode =
    typeof reasonCode === "string" && EDIT_FAILURE_REASON_CODES.has(reasonCode)
      ? reasonCode
      : undefined;
  const base = projected("failed", safeReasonCode, safeReasonCode === "ci-observation-required");
  return safeReasonCode === undefined
    ? base
    : { ...base, ...editFailureCoaching(safeReasonCode, value.message) };
}

function editFailureCoaching(
  reasonCode: string,
  message: unknown,
): { readonly detail?: string; readonly guidance?: string } {
  const guidance = EDIT_FAILURE_GUIDANCE[reasonCode];
  const detail =
    EDIT_FAILURE_DETAIL_REASON_CODES.has(reasonCode) &&
    typeof message === "string" &&
    EDIT_FAILURE_DETAIL.test(message)
      ? message
      : undefined;
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(guidance === undefined ? {} : { guidance }),
  };
}

function projectAuxiliary(
  request: CodingToolActionRequest,
  value: unknown,
): AuxiliaryCapabilityOutcomeV1 | undefined {
  if (request.action !== "skill" && request.action !== "child-agent") return undefined;
  const validated = validateAuxiliaryCapabilityOutcomeV1(value);
  return validated.ok ? validated.value : undefined;
}

function projectPayload(
  request: CodingToolActionRequest,
  value: unknown,
): CodingToolReadResult | CodingToolEgressReadResult | undefined {
  if (request.action === "read" || request.action === "discover") return projectRead(value);
  if (request.action === "egress") return projectEgressRead(value);
  return undefined;
}

// The digest is validated and passed through, never recomputed: it covers the WHOLE governed
// file while `text` may be only the requested window (#2473), and recomputing it over the window
// would break the changeset expectedContentHash anchor.
function projectRead(value: unknown): CodingToolReadResult | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const bytes = Buffer.from(value.text, "utf8");
  if (bytes.length > CODING_TOOL_MAX_READ_BYTES || !isUtf8(bytes)) return undefined;
  if (typeof value.digest !== "string" || !READ_DIGEST.test(value.digest)) return undefined;
  const facts = readWindowFacts(value);
  if (facts === undefined) return undefined;
  return { text: value.text, byteCount: bytes.length, digest: value.digest, ...facts };
}

function readWindowFacts(
  value: Record<string, unknown>,
): { readonly totalLines: number; readonly nextStartLine?: number } | undefined {
  if (!boundedLineCount(value.totalLines, 0)) return undefined;
  const nextStartLine = value.nextStartLine;
  if (nextStartLine === undefined) return { totalLines: value.totalLines };
  return boundedLineCount(nextStartLine, 2)
    ? { totalLines: value.totalLines, nextStartLine }
    : undefined;
}

function boundedLineCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

// A research page (#2387) may exceed the IPC read ceiling; unlike a repository read it is
// truncated at the last complete UTF-8 boundary instead of dropped, so the model always receives
// the bounded head of the page it was granted. Digest and byte count cover the returned bytes.
function projectEgressRead(value: unknown): CodingToolEgressReadResult | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  let bytes: Buffer = Buffer.from(value.text, "utf8");
  if (bytes.length > CODING_TOOL_MAX_READ_BYTES) {
    bytes = bytes.subarray(0, CODING_TOOL_MAX_READ_BYTES);
    while (bytes.length > 0 && !isUtf8(bytes)) bytes = bytes.subarray(0, -1);
  }
  if (!isUtf8(bytes)) return undefined;
  return {
    text: bytes.toString("utf8"),
    byteCount: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function projected(
  status: "completed" | "failed",
  code: string = status,
  exposeReasonCode = false,
): CodingToolResult {
  const evidence = [{ kind: "governed-delegate", code }] as const;
  if (status === "failed") {
    return exposeReasonCode && code !== status
      ? { status, evidence, reasonCode: code }
      : { status, evidence };
  }
  return { status, evidence };
}
function hasOrigin(headers: CodingToolFacadeInput["headers"]): boolean {
  return (
    headers !== undefined &&
    (headers instanceof Headers
      ? headers.has("origin")
      : Object.keys(headers).some((key) => key.toLowerCase() === "origin"))
  );
}
function empty(
  status: Exclude<CodingToolResult["status"], "completed" | "failed">,
): CodingToolResult {
  return { status, evidence: [] };
}
function boundedOption(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 || value > fallback
    ? fallback
    : value;
}
