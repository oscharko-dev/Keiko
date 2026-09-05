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
      readonly failureCode: "invalid-intent" | "authority-resolution-failed";
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

type Stage = "admission" | "resolution" | "revalidation" | "base-branch" | "context";

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
    failureCode:
      failure === "auth-required" || failure === "authority-denied"
        ? "authority-resolution-failed"
        : "invalid-intent",
    ...(failure === undefined ? {} : { issueBindingFailure: failure }),
  };
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
  if (
    binding.repositoryId !== input.active.instance.repositoryId ||
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

export async function admitCodingRuntimeIssue(
  input: AdmissionInput,
): Promise<CodingRuntimeIssueAdmission> {
  if (input.request.issueRef === undefined)
    return input.priorBinding === undefined ? { ok: true } : refused(input, "revalidation");
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
    const context = await input.intake.buildContext({
      runId: input.runId,
      repositoryRoot: input.active.instance.repositoryRoot,
      binding: resolution.binding,
      effectiveMode: resolveEffectiveCodingWorkbenchMode(
        input.request.requestedMode,
        input.deploymentCeiling ?? input.request.requestedMode,
      ),
      correlationId: input.runId,
    });
    if (!context.ok) return refused(input, stage, context.failure);
    return { ok: true, binding: resolution.binding, attachment: context.attachment };
  } catch (error) {
    return refused(input, stage, "issue-unavailable", error);
  }
}
