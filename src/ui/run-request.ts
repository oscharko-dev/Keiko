// Parsing + validation of the `POST /api/runs` request body (ADR-0011 D5 route 5). The body arrives
// as untyped JSON; this module narrows it (no `any`) into a typed `RunRequest` or a typed validation
// error. It performs SHAPE validation only — exactly one of workflowId/taskType, a present input
// object, a non-empty modelId. The create route is ALWAYS dry-run: `apply` is forced false here
// regardless of the body, so applying is reachable only via the gated apply route (D8). The deeper guards
// (`isSensitivePath`, patch limits, target validation) are enforced by the workflow/harness entry
// points the engine calls; the BFF never reimplements them.

export type RunKind = "unit-tests" | "bug-investigation" | "explain-plan";

export interface RunRequest {
  readonly kind: RunKind;
  readonly modelId: string;
  readonly apply: boolean;
  // The workflow/task input object, passed through to the entry point after shape validation.
  readonly input: Record<string, unknown>;
  // Optional per-run limits, passed through to the workflow/harness.
  readonly limits: Record<string, unknown> | undefined;
}

export interface RunRequestError {
  readonly code: "BAD_REQUEST";
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveKind(body: Record<string, unknown>): RunKind | RunRequestError {
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
  return { code: "BAD_REQUEST", message: "Unsupported taskType." };
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
  const limits = parsed.limits;
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
