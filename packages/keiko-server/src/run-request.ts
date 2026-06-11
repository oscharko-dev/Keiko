// Parsing + validation of the `POST /api/runs` request body (ADR-0011 D5 route 5). The body arrives
// as untyped JSON; this module narrows it (no `any`) into a typed `RunRequest` or a typed validation
// error. It performs SHAPE validation only — exactly one of workflowId/taskType, a present input
// object, a non-empty modelId, and a selected project workspaceRoot. The create route is ALWAYS
// dry-run: `apply` is forced false here regardless of the body, so applying is reachable only via
// the gated apply route (D8). The deeper guards (`isSensitivePath`, patch limits, target validation)
// are enforced by the workflow/harness entry points the engine calls; the BFF never reimplements
// them.

import type { WorkflowHandoffRequest } from "@oscharko-dev/keiko-contracts/workflow-handoff";
import {
  ORCHESTRATION_CHILD_ROLES,
  ORCHESTRATION_EXECUTION_MODES,
  type OrchestrationChildRole,
  type OrchestrationExecutionMode,
  type TaskType,
} from "@oscharko-dev/keiko-contracts";

export type RunKind = "unit-tests" | "bug-investigation" | "explain-plan" | "verify" | "orchestration";

export interface OrchestrationChildRequestBody {
  readonly childId: string;
  readonly title: string;
  readonly role: OrchestrationChildRole;
  readonly taskType: TaskType;
  readonly input: Record<string, unknown>;
  readonly dependsOn: readonly string[];
  readonly resourceClaims?:
    | readonly {
        readonly kind: "file" | "patch" | "tool";
        readonly resourceId: string;
        readonly access: "read" | "write" | "exclusive";
        readonly policy: "serialize" | "block" | "escalate";
      }[]
    | undefined;
}

export interface OrchestrationRequestBody {
  readonly executionMode: OrchestrationExecutionMode;
  readonly children: readonly OrchestrationChildRequestBody[];
  readonly limits?: Record<string, unknown> | undefined;
  readonly childLimits?: Record<string, unknown> | undefined;
  readonly settlementPolicy?: Record<string, unknown> | undefined;
}

interface BaseRunRequest {
  readonly kind: RunKind;
  readonly modelId: string;
  readonly apply: boolean;
  // The workflow/task input object, passed through to the entry point after shape validation.
  readonly input: Record<string, unknown>;
  // Optional per-run limits, passed through to the workflow/harness.
  readonly limits: Record<string, unknown> | undefined;
  // Present only for governed grounded-context workflow launches.
  readonly governedHandoff?: WorkflowHandoffRequest | undefined;
  readonly governedHandoffSourceGroundedRunId?: string | undefined;
}

export type RunRequest =
  | (BaseRunRequest & {
      readonly kind: "unit-tests" | "bug-investigation" | "explain-plan" | "verify";
    })
  | (BaseRunRequest & {
      readonly kind: "orchestration";
      readonly orchestration: OrchestrationRequestBody;
    });

export interface RunRequestError {
  readonly code: "BAD_REQUEST";
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveKind(body: Record<string, unknown>): RunKind | RunRequestError {
  if (isRecord(body.orchestration)) {
    const workflowId = body.workflowId;
    const taskType = body.taskType;
    if (workflowId !== undefined || taskType !== undefined) {
      return {
        code: "BAD_REQUEST",
        message: "Provide orchestration on its own, without workflowId or taskType.",
      };
    }
    return "orchestration";
  }
  const workflowId = body.workflowId;
  const taskType = body.taskType;
  const hasWorkflow = workflowId !== undefined;
  const hasTask = taskType !== undefined;
  if (hasWorkflow === hasTask) {
    return { code: "BAD_REQUEST", message: "Provide exactly one of workflowId or taskType." };
  }
  if (hasWorkflow) {
    if (workflowId === "unit-test-generation") {
      return "unit-tests";
    }
    if (workflowId === "bug-investigation") {
      return "bug-investigation";
    }
    return { code: "BAD_REQUEST", message: "Unknown workflowId." };
  }
  if (taskType === "explain-plan") {
    return "explain-plan";
  }
  if (taskType === "verify") {
    return "verify";
  }
  return { code: "BAD_REQUEST", message: "Unsupported taskType." };
}

function validateWorkspaceRoot(input: Record<string, unknown>): RunRequestError | null {
  const workspaceRoot = input.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    return { code: "BAD_REQUEST", message: "A non-empty workspaceRoot is required." };
  }
  return null;
}

function validateStringField(
  input: Record<string, unknown>,
  name: string,
  label: string,
): RunRequestError | null {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    return { code: "BAD_REQUEST", message: `${label} must be a non-empty string.` };
  }
  return null;
}

function validateOptionalStringField(
  input: Record<string, unknown>,
  name: string,
  label: string,
): RunRequestError | null {
  const value = input[name];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return { code: "BAD_REQUEST", message: `${label} must be a string.` };
  }
  return null;
}

function validateStringArray(
  value: unknown,
  label: string,
  options: { readonly required: boolean; readonly allowEmpty: boolean } = {
    required: false,
    allowEmpty: true,
  },
): RunRequestError | null {
  if (value === undefined) {
    return options.required
      ? { code: "BAD_REQUEST", message: `${label} must be a string array.` }
      : null;
  }
  if (!Array.isArray(value)) {
    return { code: "BAD_REQUEST", message: `${label} must be a string array.` };
  }
  if (!options.allowEmpty && value.length === 0) {
    return { code: "BAD_REQUEST", message: `${label} must contain at least one entry.` };
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      return { code: "BAD_REQUEST", message: `${label} must contain non-empty strings.` };
    }
  }
  return null;
}

// Verify shape: targetFiles (when present) must be a string[] of non-empty entries. The deeper
// guards (path containment, script detection) run inside the verification orchestrator; the BFF
// only validates shape here.
function validateVerifyInput(input: Record<string, unknown>): RunRequestError | null {
  return validateStringArray(input.targetFiles, "verify targetFiles");
}

function validateHarnessTaskInput(
  taskType: TaskType,
  input: Record<string, unknown>,
  allowWorkspaceRootDefault = false,
): RunRequestError | null {
  if (taskType === "verify") {
    if (!allowWorkspaceRootDefault) {
      const workspaceRootError = validateWorkspaceRoot(input);
      if (workspaceRootError !== null) {
        return workspaceRootError;
      }
    } else if (input.workspaceRoot !== undefined) {
      const workspaceRootError = validateWorkspaceRoot(input);
      if (workspaceRootError !== null) {
        return workspaceRootError;
      }
    }
    return validateVerifyInput(input);
  }
  if (taskType === "explain-plan") {
    return validateExplainPlanInput(input);
  }
  if (taskType === "generate-unit-tests") {
    return (
      validateStringField(input, "filePath", "generate-unit-tests filePath") ??
      validateOptionalStringField(
        input,
        "targetFunction",
        "generate-unit-tests targetFunction",
      ) ??
      validateOptionalStringField(input, "context", "generate-unit-tests context")
    );
  }
  return (
    validateStringField(input, "description", "investigate-bug description") ??
    validateStringArray(input.filePaths, "investigate-bug filePaths") ??
    validateOptionalStringField(input, "context", "investigate-bug context")
  );
}

function validateExplainPlanInput(input: Record<string, unknown>): RunRequestError | null {
  return (
    validateStringField(input, "filePath", "explain-plan filePath") ??
    validateOptionalStringField(input, "question", "explain-plan question")
  );
}

function validateUnitTestTarget(target: Record<string, unknown>): RunRequestError | null {
  const kind = target.kind;
  if (kind === "file") {
    return (
      validateStringField(target, "filePath", "unit-test target.filePath") ??
      validateOptionalStringField(target, "targetFunction", "unit-test target.targetFunction")
    );
  }
  if (kind === "module") {
    return validateStringField(target, "moduleDir", "unit-test target.moduleDir");
  }
  if (kind === "changedFiles") {
    return validateStringArray(target.filePaths, "unit-test target.filePaths", {
      required: true,
      allowEmpty: false,
    });
  }
  return {
    code: "BAD_REQUEST",
    message: "unit-test target.kind must be one of file, module, changedFiles.",
  };
}

function validateUnitTestsInput(input: Record<string, unknown>): RunRequestError | null {
  const target = input.target;
  if (!isRecord(target)) {
    return { code: "BAD_REQUEST", message: "unit-test target must be an object." };
  }
  return validateUnitTestTarget(target);
}

function validateBugReport(report: Record<string, unknown>): RunRequestError | null {
  const descriptionError = validateOptionalStringField(
    report,
    "description",
    "bug report.description",
  );
  if (descriptionError !== null) {
    return descriptionError;
  }
  const failingOutputError = validateOptionalStringField(
    report,
    "failingOutput",
    "bug report.failingOutput",
  );
  if (failingOutputError !== null) {
    return failingOutputError;
  }
  const stackTraceError = validateOptionalStringField(
    report,
    "stackTrace",
    "bug report.stackTrace",
  );
  if (stackTraceError !== null) {
    return stackTraceError;
  }
  const targetFilesError = validateStringArray(report.targetFiles, "bug report.targetFiles");
  if (targetFilesError !== null) {
    return targetFilesError;
  }
  return hasBugEvidence(report)
    ? null
    : {
        code: "BAD_REQUEST",
        message:
          "bug report requires at least one of description, failingOutput, stackTrace, or targetFiles.",
      };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringEntry(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

function hasBugEvidence(report: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(report.description) ||
    hasNonEmptyString(report.failingOutput) ||
    hasNonEmptyString(report.stackTrace) ||
    hasNonEmptyStringEntry(report.targetFiles)
  );
}

function validateBugInvestigationInput(input: Record<string, unknown>): RunRequestError | null {
  const report = input.report;
  if (!isRecord(report)) {
    return { code: "BAD_REQUEST", message: "bug report must be an object." };
  }
  return validateBugReport(report);
}

function validateRunInput(kind: RunKind, input: Record<string, unknown>): RunRequestError | null {
  const workspaceRootError = validateWorkspaceRoot(input);
  if (workspaceRootError !== null) {
    return workspaceRootError;
  }
  if (kind === "orchestration") {
    return null;
  }
  if (kind === "verify") {
    return validateVerifyInput(input);
  }
  if (kind === "explain-plan") {
    return validateExplainPlanInput(input);
  }
  if (kind === "unit-tests") {
    return validateUnitTestsInput(input);
  }
  return validateBugInvestigationInput(input);
}

function isTaskType(value: unknown): value is TaskType {
  return (
    value === "generate-unit-tests" ||
    value === "investigate-bug" ||
    value === "explain-plan" ||
    value === "verify"
  );
}

function validateResourceClaims(value: unknown): RunRequestError | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return { code: "BAD_REQUEST", message: "orchestration child resourceClaims must be an array." };
  }
  for (const claim of value) {
    if (!isRecord(claim)) {
      return { code: "BAD_REQUEST", message: "orchestration child resourceClaims must contain objects." };
    }
    if (!["file", "patch", "tool"].includes(String(claim.kind))) {
      return { code: "BAD_REQUEST", message: "orchestration child resourceClaims kind is invalid." };
    }
    if (typeof claim.resourceId !== "string" || claim.resourceId.length === 0) {
      return { code: "BAD_REQUEST", message: "orchestration child resourceClaims resourceId is required." };
    }
    if (!["read", "write", "exclusive"].includes(String(claim.access))) {
      return { code: "BAD_REQUEST", message: "orchestration child resourceClaims access is invalid." };
    }
    if (!["serialize", "block", "escalate"].includes(String(claim.policy))) {
      return { code: "BAD_REQUEST", message: "orchestration child resourceClaims policy is invalid." };
    }
  }
  return null;
}

function validateOrchestration(body: Record<string, unknown>): OrchestrationRequestBody | RunRequestError {
  const orchestration = body.orchestration;
  if (!isRecord(orchestration)) {
    return { code: "BAD_REQUEST", message: "orchestration must be an object." };
  }
  if (!ORCHESTRATION_EXECUTION_MODES.includes(orchestration.executionMode as OrchestrationExecutionMode)) {
    return { code: "BAD_REQUEST", message: "orchestration executionMode is invalid." };
  }
  if (!Array.isArray(orchestration.children) || orchestration.children.length === 0) {
    return { code: "BAD_REQUEST", message: "orchestration children must be a non-empty array." };
  }
  const seen = new Set<string>();
  const children: OrchestrationChildRequestBody[] = [];
  for (const child of orchestration.children) {
    if (!isRecord(child)) {
      return { code: "BAD_REQUEST", message: "orchestration children must contain objects." };
    }
    if (typeof child.childId !== "string" || child.childId.length === 0) {
      return { code: "BAD_REQUEST", message: "orchestration childId is required." };
    }
    if (seen.has(child.childId)) {
      return { code: "BAD_REQUEST", message: `duplicate orchestration childId: ${child.childId}` };
    }
    seen.add(child.childId);
    if (typeof child.title !== "string" || child.title.length === 0) {
      return { code: "BAD_REQUEST", message: `orchestration child ${child.childId} title is required.` };
    }
    if (!ORCHESTRATION_CHILD_ROLES.includes(child.role as OrchestrationChildRole)) {
      return { code: "BAD_REQUEST", message: `orchestration child ${child.childId} role is invalid.` };
    }
    if (!isTaskType(child.taskType)) {
      return { code: "BAD_REQUEST", message: `orchestration child ${child.childId} taskType is invalid.` };
    }
    if (!isRecord(child.input)) {
      return { code: "BAD_REQUEST", message: `orchestration child ${child.childId} input must be an object.` };
    }
    const inputError = validateHarnessTaskInput(child.taskType, child.input, true);
    if (inputError !== null) {
      return inputError;
    }
    const dependsOnError = validateStringArray(child.dependsOn, `orchestration child ${child.childId} dependsOn`);
    if (dependsOnError !== null) {
      return dependsOnError;
    }
    const claimsError = validateResourceClaims(child.resourceClaims);
    if (claimsError !== null) {
      return claimsError;
    }
    children.push({
      childId: child.childId,
      title: child.title,
      role: child.role as OrchestrationChildRole,
      taskType: child.taskType,
      input: child.input,
      dependsOn: (child.dependsOn as readonly string[] | undefined) ?? [],
      ...(Array.isArray(child.resourceClaims) ? { resourceClaims: child.resourceClaims as OrchestrationChildRequestBody["resourceClaims"] } : {}),
    });
  }
  for (const child of children) {
    for (const dependency of child.dependsOn) {
      if (!seen.has(dependency)) {
        return {
          code: "BAD_REQUEST",
          message: `orchestration child ${child.childId} depends on unknown child ${dependency}.`,
        };
      }
    }
  }
  return {
    executionMode: orchestration.executionMode as OrchestrationExecutionMode,
    children,
    ...(isRecord(orchestration.limits) ? { limits: orchestration.limits } : {}),
    ...(isRecord(orchestration.childLimits) ? { childLimits: orchestration.childLimits } : {}),
    ...(isRecord(orchestration.settlementPolicy)
      ? { settlementPolicy: orchestration.settlementPolicy }
      : {}),
  };
}

// Parses the raw JSON text into a validated RunRequest, or a typed BAD_REQUEST error.
export function parseRunRequest(raw: string): RunRequest | RunRequestError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: "BAD_REQUEST", message: "Request body is not valid JSON." };
  }
  if (!isRecord(parsed)) {
    return { code: "BAD_REQUEST", message: "Request body must be a JSON object." };
  }
  const kind = resolveKind(parsed);
  if (typeof kind !== "string") {
    return kind;
  }
  const modelId = parsed.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { code: "BAD_REQUEST", message: "A non-empty modelId is required." };
  }
  const input = parsed.input;
  if (!isRecord(input)) {
    return { code: "BAD_REQUEST", message: "An input object is required." };
  }
  const inputError = validateRunInput(kind, input);
  if (inputError !== null) {
    return inputError;
  }
  const limits = parsed.limits;
  if (kind === "orchestration") {
    const orchestration = validateOrchestration(parsed);
    if ("code" in orchestration) {
      return orchestration;
    }
    return {
      kind,
      modelId,
      apply: false,
      input,
      ...(isRecord(limits) ? { limits } : { limits: undefined }),
      orchestration,
    };
  }
  return {
    kind,
    modelId,
    // Dry-run-first (ADR-0011 D8 / security M1): the create route NEVER applies, even if the client
    // body carries `apply:true`. Applying is the sole responsibility of POST /api/runs/:runId/apply
    // (route 9), which re-invokes the workflow through the gated path. A one-shot create-with-apply
    // would bypass the explicit review→apply step, so the body flag is deliberately ignored here.
    apply: false,
    input,
    ...(isRecord(limits) ? { limits } : { limits: undefined }),
  };
}
