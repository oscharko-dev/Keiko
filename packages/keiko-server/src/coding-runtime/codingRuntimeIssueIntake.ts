import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeStartRequest,
} from "@oscharko-dev/keiko-contracts";
import { validateCodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { errorKindOf } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { githubIssueReaderRepositoryId } from "../coding-context/githubIssueReaderAuthorization.js";

export interface CodingRuntimeIssueAttachment {
  readonly issueNumber: number;
  readonly itemCount: number;
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
  readonly intake?: CodingRuntimeIssueIntake | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly deploymentCeiling?: CodingWorkbenchMode | undefined;
}

type Stage = "admission" | "resolution" | "revalidation" | "base-branch" | "context" | "reattach";

function refused(
  input: AdmissionInput,
  stage: Stage,
  failure?: CodingWorkbenchIssueBindingFailure,
  error?: unknown,
): CodingRuntimeIssueAdmission {
  input.activityLog?.write({
    category: "process",
    level: "warn",
    op: "coding-runtime.run.issue-binding-refused",
    correlationId: input.runId,
    ...(error === undefined ? {} : { errorKind: errorKindOf(error) }),
    extra: {
      runId: input.runId,
      stage,
      ...(failure === undefined ? {} : { issueBindingFailure: failure }),
      ...(error === undefined
        ? {}
        : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
    },
  });
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
  if (
    (input.priorBinding !== undefined &&
      canonicalise(input.priorBinding) !== canonicalise(binding)) ||
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
    return { ok: true, binding, attachment: context.attachment };
  } catch (error) {
    return refused(input, "reattach", "issue-unavailable", error);
  }
}

export async function admitCodingRuntimeIssue(
  input: AdmissionInput,
): Promise<CodingRuntimeIssueAdmission> {
  if (input.request.issueRef === undefined) {
    if (input.priorBinding === undefined) return { ok: true };
    return reattachDurableIssue(input, input.priorBinding);
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
    return { ok: true, binding: resolution.binding, attachment: context.attachment };
  } catch (error) {
    return refused(input, stage, "issue-unavailable", error);
  }
}
