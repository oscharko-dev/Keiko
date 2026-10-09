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
import {
  WORKSPACE_READ_REFUSAL_CODES,
  WORKSPACE_DISCOVERY_REFUSAL_CODES,
} from "./codingToolReadEditPorts.js";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/connected-context";
import { WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS } from "@oscharko-dev/keiko-contracts/runtime/workspace";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { isDenied } from "@oscharko-dev/keiko-workspace";

import type {
  AuxiliaryCapabilityOutcomeV1,
  VerificationFailureLocation,
  WorkspacePathDiscoveryEntry,
  WorkspacePathDiscoveryTruncationReason,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES,
  isCodingSafeActivityPresentationPath,
  type CodingSafeActivityToolPresentation,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { validateAuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
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
  declaredCodingToolAction,
  codingToolDiscoveryText,
  dependencyBootstrapFailureSummary,
  isPermissionObservation,
  parseCodingToolRequest,
  type CodingToolAction,
  type CodingToolActionRequest,
  type CodingToolEgressReadResult,
  type CodingToolReadResult,
  type CodingToolDiscoveryResult,
  type CodingToolResult,
  type CodingToolVerificationFailure,
  type CodingToolVerificationResult,
  type CodingToolCommitProofResult,
  type VerificationNotRunReason,
  GOVERNED_ASK_DECLINED_REASON_CODE,
} from "./codingToolIpc.js";
// KEIKO-0695: hoisted from below EDIT_FAILURE_REASON_CODES to the top-of-file import block.
import {
  EDIT_PREPARE_CAUSES,
  EDIT_READ_REASONS,
  type CodingToolAdmission,
  type CodingToolEditOutcome,
  type CodingToolFacade,
  type CodingToolFacadeInput,
  type CodingToolFacadeOptions,
  type CodingToolFacadePorts,
  type EditPrepareCause,
  type EditReadReason,
} from "./codingToolFacadePorts.js";
import {
  VERIFICATION_RUNNER_ERROR_CODES,
  type VerificationRunnerErrorCode,
} from "../editor/verificationRunnerErrors.js";

const READ_DIGEST = /^[a-f0-9]{64}$/u;
const VERIFICATION_FAILURE_SUMMARY =
  /^(?:test|targeted-test|typecheck|lint|build) failed; (?:0|[2-8]) structured failure locations$|^(?:test|targeted-test|typecheck|lint|build) failed; 1 structured failure location$/u;

// The contract-owned vocabulary combines the existing editor conflict/failure codes with the
// governed port's refusal and transport markers. Unknown delegate strings are withheld.
// Exported so the run's refusal escalation pins complete classification without a second list.
export const EDIT_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<string>(
  CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES,
);
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
  // A read the port refused for the model's own request (#3615): named, so the model can act on it
  // and the catalog settles the call as a refusal instead of a handler fault.
  ...Object.values(WORKSPACE_READ_REFUSAL_CODES),
  ...Object.values(WORKSPACE_DISCOVERY_REFUSAL_CODES),
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
    onToolSettled: options.onToolSettled,
    observeEditOutcome: options.observeEditOutcome,
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
  readonly onToolSettled: CodingToolFacadeOptions["onToolSettled"];
  readonly observeEditOutcome: ((outcome: CodingToolEditOutcome) => void) | undefined;
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
      input.onDelegateStarted?.();
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
  if (request === undefined) {
    const action = declaredCodingToolAction(input.body, context.maxBodyBytes);
    return answered(context, action, empty("invalid"));
  }
  return answered(context, request.action, await executeParsed(context, input, request));
}

// #3873: the run's effort roll-up counts each call the facade answered by its closed action and the
// status of the answer — never the request or the result.
function answered(
  context: ExecutionContext,
  action: CodingToolAction | undefined,
  result: CodingToolResult,
): CodingToolResult {
  context.onToolSettled?.(action, result.status);
  return result;
}

async function executeParsed(
  context: ExecutionContext,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
): Promise<CodingToolResult> {
  if (input.signal?.aborted === true) return empty("cancelled");
  if (context.inFlight.count >= context.maxInFlight) return empty("busy");
  context.inFlight.count += 1;
  try {
    const result = await routeParsed(context, input, request);
    if (request.action === "edit") observeEditResult(context.observeEditOutcome, result);
    return result;
  } finally {
    context.inFlight.count -= 1;
  }
}

// An admitted request's one path: the canonical catalog bridge for a covered action, else the
// governed delegate.
function routeParsed(
  context: ExecutionContext,
  input: CodingToolFacadeInput,
  request: CodingToolActionRequest,
): Promise<CodingToolResult> {
  if (context.catalogBridge?.covers(request) === true) {
    return executeCatalogRequest(context, input, request);
  }
  context.catalogBridge?.recordUnbound(request, input);
  return executeAdmitted(
    context.ports,
    input,
    request,
    context.invocationRegistry,
    context.requireInvocationRegistryForEdits,
  );
}

// F5 (#3873): the run's refusal bound counts the edit as the model received it, whatever path
// answered it — the catalog bridge or the admitted delegate.
function observeEditResult(
  observe: ((outcome: CodingToolEditOutcome) => void) | undefined,
  result: CodingToolResult,
): void {
  if (observe === undefined) return;
  const outcome = codingToolEditOutcome(result);
  if (outcome !== undefined) observe(outcome);
}

/**
 * An answered edit's outcome: applied, or refused under the closed code the model was given — the
 * `reasonCode` the result exposes, else its governed-delegate evidence code, which carries the same
 * closed vocabulary (`projectEditFailure`). A refusal whose code the facade withheld reads as
 * `UNCLASSIFIED`; a human decision, cancellation or busy answer is not an outcome to count. An
 * `EDIT_PREPARE_FAILED` refusal also reports the closed cause the edit port gave it, which the model
 * never sees (`EDIT_REFUSAL_CAUSES`).
 */
function codingToolEditOutcome(result: CodingToolResult): CodingToolEditOutcome | undefined {
  if (result.status === "completed") return { kind: "applied" };
  if (result.status !== "failed") return undefined;
  const code =
    result.reasonCode ?? result.evidence.find((item) => item.kind === "governed-delegate")?.code;
  return {
    kind: "refused",
    reasonCode: code === undefined || code === "failed" ? "UNCLASSIFIED" : code,
    ...bodyFreeEditRefusalCause(EDIT_REFUSAL_CAUSES.get(result)),
  };
}

function bodyFreeEditRefusalCause(
  cause: EditRefusalCause | undefined,
): Omit<EditRefusalCause, "affectedRelativePath"> {
  return {
    ...(cause?.prepareCause === undefined ? {} : { prepareCause: cause.prepareCause }),
    ...(cause?.readReason === undefined ? {} : { readReason: cause.readReason }),
  };
}

/** Server-private live presentation; the affected path never enters the model reply or evidence. */
export function codingToolEditPresentation(
  result: CodingToolResult,
): CodingSafeActivityToolPresentation {
  if (result.status !== "failed") return {};
  const candidate =
    result.reasonCode ?? result.evidence.find((item) => item.kind === "governed-delegate")?.code;
  const refusalReason = CODING_SAFE_ACTIVITY_EDIT_REFUSAL_REASON_CODES.find(
    (code) => code === candidate,
  );
  if (refusalReason === undefined) return {};
  const affectedRelativePath = EDIT_REFUSAL_CAUSES.get(result)?.affectedRelativePath;
  return Object.freeze({
    refusalReason,
    ...(affectedRelativePath === undefined ? {} : { affectedRelativePath }),
  });
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
  input.onDelegateStarted?.();
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
  input.onDelegateStarted?.();
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
  return projectCompletedPayload(request, value.read);
}

function projectCompletedPayload(
  request: CodingToolActionRequest,
  value: unknown,
): CodingToolResult {
  const read = projectPayload(request, value);
  if (read === undefined) return projected(request.action === "discover" ? "failed" : "completed");
  return {
    status: "completed",
    evidence: [{ kind: "governed-delegate", code: "completed" }],
    read,
  };
}

function isCodingToolVerificationResult(value: unknown): value is CodingToolVerificationResult {
  if (!isRecord(value) || value.status !== "passed" || !Array.isArray(value.completed))
    return false;
  if (value.completed.length === 0 || !Array.from(value.completed).every(isVerificationKind))
    return false;
  if (new Set(value.completed).size !== value.completed.length) return false;
  return value.commit === undefined
    ? Object.keys(value).length === 2
    : Object.keys(value).length === 3 && isCodingToolCommitProofResult(value.commit);
}

// The one next action each unavailable-proof reason admits. Unsaved editor buffers are saved, not
// staged: the stage-then-verify answer they got before sent the model into a loop (#3612).
const COMMIT_PROOF_NEXT_ACTIONS: ReadonlyMap<unknown, string> = new Map([
  ["candidate-drift", "verify-again"],
  ["proof-unavailable", "verify-again"],
  ["buffers-dirty", "save-then-verify"],
  ["candidate-not-staged", "stage-then-verify"],
]);

function isCodingToolCommitProofResult(value: unknown): value is CodingToolCommitProofResult {
  if (!isRecord(value)) return false;
  if (value.commitProof === "recorded") return Object.keys(value).length === 1;
  if (value.commitProof !== "unavailable") return false;
  const nextAction = COMMIT_PROOF_NEXT_ACTIONS.get(value.reasonCode);
  if (nextAction === undefined || value.nextAction !== nextAction) return false;
  if (value.reasonCode !== "candidate-not-staged" || value.blocking === undefined) {
    return Object.keys(value).length === 3;
  }
  return Object.keys(value).length === 4 && isVerifiedCommitBlockingPaths(value.blocking);
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
    projectVerification(request, value) ??
    projectSkillDiscovery(request, value)
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

// #3417: a discovery answers with the contract's closed listing or not at all; anything else the
// handler returned collapses to a failure rather than reaching the model.
function projectSkillDiscovery(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action !== "skill-discover") return undefined;
  const validated = validateSkillDiscoveryResultV1(value.skills);
  return validated.ok
    ? {
        status: "completed",
        evidence: [{ kind: "governed-delegate", code: "completed" }],
        skills: validated.value,
      }
    : projected("failed");
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
  // The operator declined a server-raised ask (a Git stage, commit, push or pull-request proposal):
  // the same decision as a declined step, so the model reads why and goes on (ADR-0124 D6).
  if (reasonCode === GOVERNED_ASK_DECLINED_REASON_CODE) return humanDecisionToolResult("denied");
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
// #3873: the model sees one edit form, exact replacements plus deletions and renames, so these
// sentences name that form and never a patch the schema does not offer.
const EDIT_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  CONTENT_HASH_MISMATCH:
    "The file changed after the read that produced expectedContentHash; an earlier successful edit of yours changes it too. Re-read the file with keiko_workspace_read, copy its current text and digest, and submit a fresh edit. Do not resend the same edit.",
  INVALID_EDITS:
    "The edit does not apply to the file as it is now: an oldString is missing or not unique, or a path is named twice, addressed after being renamed away, or missing from files or selectedFiles. Re-read the file, copy its exact current text into oldString, and submit one fresh call that declares every path it touches.",
  PRECONDITION_REQUIRED:
    "Read the file with keiko_workspace_read first and bind the edit to the digest that read returns.",
  LIMIT_EXCEEDED:
    "The edit is larger than the run or one changeset allows. Narrow replaceAll, split the call into smaller changesets, or finish with the changes already applied; do not resend it unchanged.",
  OUT_OF_SCOPE:
    "The path is outside the workspace or protected by policy. This is a decision, not a transient error; do not retry it.",
};
// The refusals whose route sentence is structural (paths, hunk indexes, line numbers, sizes) and
// therefore safe to show; every other code keeps the code alone.
const EDIT_FAILURE_DETAIL_REASON_CODES: ReadonlySet<string> = new Set([
  "CONTENT_HASH_MISMATCH",
  "INVALID_EDITS",
  "PRECONDITION_REQUIRED",
  "LIMIT_EXCEEDED",
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
  // The human rejected the change in its review, the only approval an edit asks for: the same
  // decision as a declined step, so the model reads why and goes on without it (ADR-0124 D6).
  if (reasonCode === "CHANGE_REJECTED") return humanDecisionToolResult("denied");
  const safeReasonCode =
    typeof reasonCode === "string" && EDIT_FAILURE_REASON_CODES.has(reasonCode)
      ? reasonCode
      : undefined;
  const base = projected("failed", safeReasonCode, safeReasonCode === "ci-observation-required");
  if (safeReasonCode === undefined) return base;
  const result = { ...base, ...editFailureCoaching(safeReasonCode, value.message) };
  const cause = safeReasonCode === "EDIT_PREPARE_FAILED" ? editRefusalCause(value) : undefined;
  if (cause !== undefined) EDIT_REFUSAL_CAUSES.set(result, cause);
  return result;
}

// The closed cause the edit port gave an `EDIT_PREPARE_FAILED` refusal (which preparation step
// refused, and why a materialization read failed) rides BESIDE the model-facing result, keyed by the
// result object, never in it: `JSON.stringify(result)` is what the model receives, and the run's
// refusal bound reads only its closed words (`codingToolEditOutcome`); the authenticated live UI
// reads an optional authoritative affected path through `codingToolEditPresentation`. The path
// never enters the model-facing result, the outcome observer or the Activity Log. Every answered edit
// hands back the object `project` built — the admitted delegate and the catalog bridge alike — so
// the key survives both. A word outside the closed vocabularies is dropped, and the refusal then
// reads as the code alone, exactly as before.
const EDIT_REFUSAL_CAUSES = new WeakMap<CodingToolResult, EditRefusalCause>();
const EDIT_PREPARE_CAUSE_SET: ReadonlySet<unknown> = new Set(EDIT_PREPARE_CAUSES);
const EDIT_READ_REASON_SET: ReadonlySet<unknown> = new Set(EDIT_READ_REASONS);

interface EditRefusalCause {
  readonly prepareCause?: EditPrepareCause;
  readonly readReason?: EditReadReason;
  readonly affectedRelativePath?: string;
}

function isEditPrepareCause(value: unknown): value is EditPrepareCause {
  return EDIT_PREPARE_CAUSE_SET.has(value);
}

function isEditReadReason(value: unknown): value is EditReadReason {
  return EDIT_READ_REASON_SET.has(value);
}

function editRefusalCause(value: Record<string, unknown>): EditRefusalCause | undefined {
  const { prepareCause, readReason } = value;
  const affectedRelativePath = authoritativeAffectedPath(value);
  const cause = {
    ...(isEditPrepareCause(prepareCause) ? { prepareCause } : {}),
    ...(isEditReadReason(readReason) ? { readReason } : {}),
    ...(affectedRelativePath === undefined ? {} : { affectedRelativePath }),
  };
  return Object.keys(cause).length === 0 ? undefined : cause;
}

function authoritativeAffectedPath(value: Record<string, unknown>): string | undefined {
  if (
    !isEditReadReason(value.readReason) ||
    (value.prepareCause !== "replacement-read-failed" && value.prepareCause !== "cancelled")
  )
    return undefined;
  const path = value.affectedRelativePath;
  return isCodingSafeActivityPresentationPath(path) && !isDenied(path) ? path : undefined;
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

// Owner decision 2026-09-26 (ADR-0124 D6): a human's "no" rejects one step, not the run. The model
// reads why the step did not happen and goes on without it.
const HUMAN_DECISION_GUIDANCE = {
  denied:
    "The user declined this step, so it was not performed. Do not repeat it; continue with the rest of the task without it, or ask the user how to proceed.",
  expired:
    "Nobody decided this approval in time, so the step was not performed. Continue with the rest of the task without it, or ask the user before trying it again.",
} as const;

/** The feedback a declined or expired step gives the model in place of the call (ADR-0124 D6). */
export function humanDecisionFeedback(outcome: "denied" | "expired"): string {
  return HUMAN_DECISION_GUIDANCE[outcome];
}

/** The result a declined or expired governed ask answers in place of its call (ADR-0124 D6). */
export function humanDecisionToolResult(outcome: "denied" | "expired"): CodingToolResult {
  return {
    status: outcome === "denied" ? "denied" : "cancelled",
    evidence: [],
    guidance: HUMAN_DECISION_GUIDANCE[outcome],
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
  if (request.action === "read" || request.action === "discover")
    return projectRead(value, request.action === "discover" ? request.maxResults : undefined);
  if (request.action === "egress") return projectEgressRead(value);
  return undefined;
}

// The digest is validated and passed through, never recomputed: it covers the WHOLE governed
// file while `text` may be only the requested window (#2473), and recomputing it over the window
// would break the changeset expectedContentHash anchor.
function projectRead(value: unknown, maxPaths?: number): CodingToolReadResult | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  const bytes = Buffer.from(value.text, "utf8");
  if (bytes.length > CODING_TOOL_MAX_READ_BYTES || !isUtf8(bytes)) return undefined;
  if (typeof value.digest !== "string" || !READ_DIGEST.test(value.digest)) return undefined;
  const facts = readWindowFacts(value);
  if (facts === undefined) return undefined;
  const discovery = discoveryCountFacts(value, maxPaths);
  if (discovery === undefined) return undefined;
  const result = {
    text: value.text,
    byteCount: bytes.length,
    digest: value.digest,
    ...facts,
    ...discovery,
  };
  return checkedDiscoveryReadProjection(result);
}

function checkedDiscoveryReadProjection(
  read: CodingToolReadResult,
): CodingToolReadResult | undefined {
  if (read.discovery === undefined) return read;
  return validDiscoveryReadProjection(read) ? read : undefined;
}

function validDiscoveryReadProjection(read: CodingToolReadResult): boolean {
  return (
    read.discovery !== undefined &&
    read.text === codingToolDiscoveryText(read.discovery.entries) &&
    read.totalLines === (read.text.length === 0 ? 0 : read.text.split("\n").length - 1) &&
    Buffer.byteLength(JSON.stringify(read), "utf8") <= CODING_TOOL_MAX_READ_BYTES
  );
}

function discoveryCountFacts(
  value: Record<string, unknown>,
  maxPaths: number | undefined,
):
  | {
      readonly returnedPathCount?: number;
      readonly discovery?: CodingToolDiscoveryResult;
    }
  | undefined {
  const count = value.returnedPathCount;
  const discovery = value.discovery;
  if (maxPaths === undefined || count === undefined)
    return discovery === undefined ? {} : undefined;
  if (!boundedLineCount(count, 0) || count > maxPaths) return undefined;
  if (discovery === undefined) return { returnedPathCount: count };
  return isDiscoveryResult(discovery, count)
    ? { returnedPathCount: count, discovery: capturedDiscoveryResult(discovery) }
    : undefined;
}

function isDiscoveryEntry(value: unknown): value is WorkspacePathDiscoveryEntry {
  return (
    plainDiscoveryRecord(value, ["relativePath", "kind", "sizeBytes"]) &&
    isValidScopePath(value.relativePath, { mustBeRelative: true }) &&
    typeof value.relativePath === "string" &&
    !isDenied(value.relativePath) &&
    (value.kind === "file" || value.kind === "directory") &&
    boundedLineCount(value.sizeBytes, 0)
  );
}

function plainDiscoveryRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry)
  );
}

function isDiscoveryReason(value: unknown): value is WorkspacePathDiscoveryTruncationReason {
  const reasons: readonly unknown[] = WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS;
  return reasons.includes(value);
}

function isDiscoveryEntries(
  value: unknown,
  count: number,
): value is readonly WorkspacePathDiscoveryEntry[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !plainDenseArray(value) ||
    !value.every(isDiscoveryEntry)
  )
    return false;
  const entries: readonly WorkspacePathDiscoveryEntry[] = value;
  return new Set(entries.map((entry) => entry.relativePath)).size === count;
}

function plainDenseArray(value: readonly unknown[]): boolean {
  return (
    Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.keys(value).every((key, index) => key === String(index)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => "value" in entry)
  );
}

function isDiscoveryReasons(
  value: unknown,
): value is readonly WorkspacePathDiscoveryTruncationReason[] {
  return (
    Array.isArray(value) &&
    value.length <= WORKSPACE_PATH_DISCOVERY_TRUNCATION_REASONS.length &&
    plainDenseArray(value) &&
    value.every(isDiscoveryReason) &&
    new Set(value).size === value.length
  );
}

function isDiscoveryResult(value: unknown, count: number): value is CodingToolDiscoveryResult {
  if (
    !plainDiscoveryRecord(value, [
      "entries",
      "matchedCount",
      "coverageIncomplete",
      "truncationReasons",
    ])
  )
    return false;
  if (!isDiscoveryEntries(value.entries, count) || !isDiscoveryReasons(value.truncationReasons))
    return false;
  if (
    !boundedLineCount(value.matchedCount, count) ||
    value.coverageIncomplete !== value.truncationReasons.length > 0
  )
    return false;
  return value.matchedCount === count
    ? !value.truncationReasons.includes("result-limit")
    : value.truncationReasons.includes("result-limit") ||
        value.truncationReasons.includes("output-limit");
}

function capturedDiscoveryResult(value: CodingToolDiscoveryResult): CodingToolDiscoveryResult {
  return {
    entries: value.entries.map(({ relativePath, kind, sizeBytes }) => ({
      relativePath,
      kind,
      sizeBytes,
    })),
    matchedCount: value.matchedCount,
    coverageIncomplete: value.coverageIncomplete,
    truncationReasons: [...value.truncationReasons],
  };
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
