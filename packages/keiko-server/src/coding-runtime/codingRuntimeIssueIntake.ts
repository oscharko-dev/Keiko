import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { githubIssueReaderRepositoryId } from "../coding-context/githubIssueReaderAuthorization.js";

export interface CodingRuntimeIssueAttachment {
  readonly issueNumber: number;
  readonly itemCount: number;
  /** Same-repository issues the bound issue references and that were attached beside it. */
  readonly linkedIssueCount: number;
  readonly byteCount: number;
  readonly text: string;
}

interface Failure {
  readonly ok: false;
  readonly failure: CodingWorkbenchIssueBindingFailure;
}
export interface CodingRuntimeIssueIntake {
  readonly resolve: (input: {
    readonly repositoryRoot: string;
    readonly issueRef: string;
    readonly correlationId: string;
  }) => Promise<
    | {
        readonly ok: true;
        readonly binding: CodingWorkbenchIssueBinding;
        readonly preview?: unknown;
      }
    | Failure
  >;
  readonly buildContext: (input: {
    readonly runId: string;
    readonly repositoryRoot: string;
    readonly binding: CodingWorkbenchIssueBinding;
    readonly effectiveMode: CodingWorkbenchMode;
    readonly correlationId: string;
  }) => Promise<{ readonly ok: true; readonly attachment: CodingRuntimeIssueAttachment } | Failure>;
}

export type CodingRuntimeIssueAdmission =
  | {
      readonly ok: true;
      readonly binding?: CodingWorkbenchIssueBinding;
      readonly contextBinding?: CodingWorkbenchIssueBinding;
      readonly attachment?: CodingRuntimeIssueAttachment;
    }
  | {
      readonly ok: false;
      readonly failureCode:
        "invalid-intent" | "authority-resolution-failed" | "issue-context-unavailable";
      readonly issueBindingFailure?: CodingWorkbenchIssueBindingFailure;
    };

interface AdmissionInput {
  readonly request: CodingWorkbenchRuntimeStartRequest;
  readonly active: ActiveWorkspaceView;
  readonly runId: string;
  readonly priorBinding?: CodingWorkbenchIssueBinding | undefined;
  readonly priorContextBinding?: CodingWorkbenchIssueBinding | undefined;
  readonly intake?: CodingRuntimeIssueIntake | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly deploymentCeiling?: CodingWorkbenchMode | undefined;
}

const CODING_RUNTIME_ISSUE_STAGES = [
  "admission",
  "resolution",
  "revalidation",
  "base-branch",
  "context",
  "reattach",
] as const;
type Stage = (typeof CODING_RUNTIME_ISSUE_STAGES)[number];

const CODING_RUNTIME_ISSUE_BINDING_FAILURES = [
  "invalid-reference",
  "repository-mismatch",
  "auth-required",
  "issue-unavailable",
  "clone-failed",
  "authority-denied",
  "cancelled",
] as const;

const CODING_RUNTIME_ISSUE_BINDING_FRAMES_FIELD = {
  type: "string-array",
  dataClass: "opaque-id",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const;

const CODING_RUNTIME_ISSUE_BINDING_CAUSE_CHAIN_FIELD = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const;

const CODING_RUNTIME_ISSUE_BINDING_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.issue-binding-refused",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeIssueIntake.refused",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...CODING_RUNTIME_ISSUE_STAGES],
    },
    issueBindingFailure: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...CODING_RUNTIME_ISSUE_BINDING_FAILURES],
    },
    frames: CODING_RUNTIME_ISSUE_BINDING_FRAMES_FIELD,
    causeChain: CODING_RUNTIME_ISSUE_BINDING_CAUSE_CHAIN_FIELD,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-issue-binding"],
  proofIds: ["coding-runtime.run.issue-binding-refused.emitted-line"],
  releaseImpact: "patch",
});

function issueBindingErrorKind(
  stage: Stage,
  failure: CodingWorkbenchIssueBindingFailure | undefined,
  error: unknown,
): ActivityLogErrorKind {
  if (failure === "auth-required" || failure === "authority-denied") return "authority-denied";
  if (failure === "cancelled") return "cancelled";
  if (failure === "issue-unavailable" || failure === "clone-failed" || stage === "reattach") {
    return "unavailable";
  }
  if (error !== undefined) return "internal";
  return failure === "repository-mismatch" || stage === "base-branch"
    ? "conflict"
    : "invalid-request";
}

function refused(
  input: AdmissionInput,
  stage: Stage,
  failure?: CodingWorkbenchIssueBindingFailure,
  error?: unknown,
): CodingRuntimeIssueAdmission {
  input.activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_ISSUE_BINDING_REFUSED_OPERATION,
      {
        level: "warn",
        correlationId: input.runId,
        errorKind: issueBindingErrorKind(stage, failure, error),
      },
      {
        runId: input.runId,
        stage,
        ...(failure === undefined ? {} : { issueBindingFailure: failure }),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
  return {
    ok: false,
    failureCode: failureCodeFor(stage, failure),
    ...(failure === undefined ? {} : { issueBindingFailure: failure }),
  };
}

// A durable-binding reattach (no fresh pasted reference — a retry/resume whose transient
// attachment was lost, #3390) is its own closed code so the Workbench can tell the operator to
// preview the issue again, instead of the generic rejection a malformed request gets.
function failureCodeFor(
  stage: Stage,
  failure: CodingWorkbenchIssueBindingFailure | undefined,
): "invalid-intent" | "authority-resolution-failed" | "issue-context-unavailable" {
  if (stage === "reattach") return "issue-context-unavailable";
  return failure === "auth-required" || failure === "authority-denied"
    ? "authority-resolution-failed"
    : "invalid-intent";
}

function bindingFailure(
  input: AdmissionInput,
  binding: CodingWorkbenchIssueBinding,
): CodingRuntimeIssueAdmission | undefined {
  const validated = validateCodingWorkbenchRuntimeSnapshot({
    schemaVersion: "1",
    state: "idle",
    revision: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    issueBinding: binding,
  });
  if (!validated.ok) return refused(input, "resolution", "invalid-reference");
  const activeRepositoryId = githubIssueReaderRepositoryId(input.active.instance.repositoryRoot);
  if (
    activeRepositoryId === undefined ||
    binding.repositoryId !== activeRepositoryId ||
    binding.defaultBaseRef !== input.active.instance.baseBranch
  ) {
    return refused(input, "base-branch", "repository-mismatch");
  }
  const priorBinding = input.priorBinding ?? input.priorContextBinding;
  if (
    (priorBinding !== undefined && canonicalise(priorBinding) !== canonicalise(binding)) ||
    (input.request.expectedIssueBindingDigest !== undefined &&
      input.request.expectedIssueBindingDigest !== binding.bindingDigest)
  ) {
    return refused(input, "revalidation", "issue-unavailable");
  }
  return undefined;
}

function effectiveModeOf(input: AdmissionInput): CodingWorkbenchMode {
  return resolveEffectiveCodingWorkbenchMode(
    input.request.requestedMode,
    input.deploymentCeiling ?? input.request.requestedMode,
  );
}

function buildAttachment(
  intake: CodingRuntimeIssueIntake,
  input: AdmissionInput,
  binding: CodingWorkbenchIssueBinding,
): ReturnType<CodingRuntimeIssueIntake["buildContext"]> {
  return intake.buildContext({
    runId: input.runId,
    repositoryRoot: input.active.instance.repositoryRoot,
    binding,
    effectiveMode: effectiveModeOf(input),
    correlationId: input.runId,
  });
}

/**
 * A run starting against a durable issue binding with no freshly pasted reference — a retry or
 * resume whose transient in-memory attachment did not survive (a server restart is the real #3390
 * case) — re-resolves the attachment through the SAME authorized reader/intake path the preview
 * uses (`buildContext` re-reads the issue by its durable number and verifies identity, exactly as
 * it does for a fresh paste), rather than either silently starting context-free or refusing a
 * still-readable issue outright. Only an actual re-resolution failure fails closed, and it does so
 * with its own closed code so the Workbench can tell the operator to preview the issue again.
 */
async function reattachDurableIssue(
  input: AdmissionInput,
  binding: CodingWorkbenchIssueBinding,
): Promise<CodingRuntimeIssueAdmission> {
  if (input.intake === undefined) return refused(input, "reattach");
  const invalid = bindingFailure(input, binding);
  if (invalid !== undefined) return invalid;
  try {
    const context = await buildAttachment(input.intake, input, binding);
    if (!context.ok) return refused(input, "reattach", context.failure);
    return {
      ok: true,
      ...(input.priorContextBinding === undefined ? { binding } : { contextBinding: binding }),
      attachment: context.attachment,
    };
  } catch (error) {
    return refused(input, "reattach", "issue-unavailable", error);
  }
}

export async function admitCodingRuntimeIssue(
  input: AdmissionInput,
): Promise<CodingRuntimeIssueAdmission> {
  if (input.request.issueRef === undefined) {
    const prior = input.priorBinding ?? input.priorContextBinding;
    if (prior === undefined) return { ok: true };
    return reattachDurableIssue(input, prior);
  }
  if (input.intake === undefined) return refused(input, "admission");
  let stage: Stage = "resolution";
  try {
    const resolution = await input.intake.resolve({
      repositoryRoot: input.active.instance.repositoryRoot,
      issueRef: input.request.issueRef,
      correlationId: input.runId,
    });
    if (!resolution.ok) return refused(input, stage, resolution.failure);
    const invalid = bindingFailure(input, resolution.binding);
    if (invalid !== undefined) return invalid;
    stage = "context";
    const context = await buildAttachment(input.intake, input, resolution.binding);
    if (!context.ok) return refused(input, stage, context.failure);
    return {
      ok: true,
      ...(input.request.issuePurpose === "context"
        ? { contextBinding: resolution.binding }
        : { binding: resolution.binding }),
      attachment: context.attachment,
    };
  } catch (error) {
    return refused(input, stage, "issue-unavailable", error);
  }
}
