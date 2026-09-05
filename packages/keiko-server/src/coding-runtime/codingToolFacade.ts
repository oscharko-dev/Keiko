import { isCodingRuntimeDeliveryResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-delivery";
import { isCodingRuntimeCiResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-ci";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import { isCodingRuntimeGitResult } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { isVerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { isCodingRepositoryResult } from "./codingRepositorySearchHandler.js";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";

import type { AuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { validateAuxiliaryCapabilityOutcomeV1 } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";

import {
  CODING_TOOL_MAX_BODY_BYTES,
  CODING_TOOL_MAX_IN_FLIGHT,
  CODING_TOOL_MAX_READ_BYTES,
  isPermissionObservation,
  parseCodingToolRequest,
  type CodingToolActionRequest,
  type CodingToolEgressReadResult,
  type CodingToolReadResult,
  type CodingToolResult,
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
const EDIT_PORT_REFUSAL_REASON_CODES = ["EDIT_PREPARE_FAILED", "WORKSPACE_ACCESS_LOST"] as const;
const EDIT_FAILURE_REASON_CODES: ReadonlySet<string> = new Set<string>([
  ...EDITOR_AGENT_CONFLICT_CODES,
  ...EDITOR_AGENT_FAILURE_CODES,
  ...EDIT_TRANSPORT_REASON_CODES,
  ...EDIT_PORT_REFUSAL_REASON_CODES,
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
  "capability-backend-unavailable",
  "command-backend-unavailable",
  "command-authority-revoked",
  "command-execution-failed",
  "git-authority-revoked",
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
import {
  CatalogFacadeDeniedError,
  type CatalogFacadeBridge,
} from "../tool-catalog/catalogToolFacadeBridge.js";

// F8 (#3413): an optional, additive extension of CodingToolFacadeOptions. `codingToolFacadePorts.ts`
// stays the single owner of the base shape; this widens only the LOCAL parameter type accepted by
// this file's own composition function, so every existing caller that passes a plain
// CodingToolFacadeOptions (no `catalogBridge`) keeps its exact prior behaviour unchanged.
export interface CodingToolFacadeCreateOptions extends CodingToolFacadeOptions {
  /** Resolves a catalog binding per covered tool call and settles it around the existing handler
   * execution (descriptor, disposition, budget, tool-catalog.* lifecycle log lines). Actions the
   * catalog does not cover dispatch exactly as before -- no behaviour change, no log line. */
  readonly catalogBridge?: CatalogFacadeBridge | undefined;
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
  readonly catalogBridge: CatalogFacadeBridge | undefined;
  readonly inFlight: { count: number };
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
    return await executeAdmitted(
      context.ports,
      input,
      request,
      context.invocationRegistry,
      context.requireInvocationRegistryForEdits,
      context.catalogBridge,
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
  catalogBridge: CatalogFacadeBridge | undefined,
): Promise<CodingToolResult> {
  const admission = ports.authority.admit(input.capability, request);
  if (!admission.ok) return empty("denied");
  if (input.signal?.aborted === true) return empty("cancelled");
  if (!admission.mutationGuard.check()) return empty("denied");
  if (request.action === "edit" && invocationRegistry !== undefined) {
    return executeStagedEdit(ports, input, request, admission, invocationRegistry);
  }
  if (request.action === "edit" && requireInvocationRegistryForEdits) return empty("denied");
  const runDelegate = (): Promise<unknown> =>
    ports.delegate.execute(request, input.signal, admission.mutationGuard);
  try {
    const outcome =
      catalogBridge === undefined
        ? await runDelegate()
        : await catalogBridge.dispatch(request, runDelegate);
    return project(request, outcome);
  } catch (error) {
    if (error instanceof CatalogFacadeDeniedError) return empty("denied");
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
  try {
    const result = await ports.delegate.execute(request, signal, admission.mutationGuard);
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
  if (value.outcome === "failed") return projectGovernedFailure(value);
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
    projectSearch(request, value)
  );
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
        }
      : projected("failed");
  return undefined;
}

function projectVerifiedCommit(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (isDraftToolRequest(request))
    return isCodingRuntimeDeliveryResult(value.draftDelivery)
      ? {
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: "completed" }],
          draftDelivery: value.draftDelivery,
        }
      : projected("failed");
  if (request.action === "delivery" && request.intent === "commit") {
    return isVerifiedCommitResult(value.verifiedCommit)
      ? {
          status: "completed",
          evidence: [{ kind: "governed-delegate", code: value.verifiedCommit.status }],
          verifiedCommit: value.verifiedCommit,
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

function projectGovernedFailure(value: Record<string, unknown>): CodingToolResult {
  const reasonCode = value.reasonCode;
  return typeof reasonCode === "string" && GOVERNED_FAILURE_REASON_CODES.has(reasonCode)
    ? projected("failed", reasonCode, true)
    : projected("failed");
}

function projectEditFailure(
  request: CodingToolActionRequest,
  value: Record<string, unknown>,
): CodingToolResult | undefined {
  if (request.action !== "edit" || value.outcome !== "failed") return undefined;
  const reasonCode = value.reasonCode;
  return projected(
    "failed",
    typeof reasonCode === "string" && EDIT_FAILURE_REASON_CODES.has(reasonCode)
      ? reasonCode
      : undefined,
  );
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
