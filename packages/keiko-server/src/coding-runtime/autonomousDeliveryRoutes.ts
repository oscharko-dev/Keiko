import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  parseGitRepositoryAgentOperationRequest,
  parseCommandTaskRunRequest,
  validateCommandTaskRunResult,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchEvidenceRecord,
  type CommandTaskRunRequest,
  type GitRepositoryAgentOperationKind,
  type GitRepositoryAgentOperationRequest,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { handleCreateCommandRun } from "../command-runner-routes.js";
import { handleGitAgentOperation } from "../gitDelivery/agentOperationsRoutes.js";
import {
  GitDeliveryBodyTooLargeError,
  hasOnlyAllowedKeys,
  isPlainObject,
  readGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "../gitDelivery/requestGuards.js";
import {
  autonomousDeliveryDeniedStep,
  decideAutonomousDeliveryOperation,
  type AutonomousDeliveryConfirmation,
  type AutonomousDeliveryConnectorAction,
  type AutonomousDeliveryConnectorCommentKind,
  type AutonomousDeliveryConnectorObjectKind,
  type AutonomousDeliveryConnectorOperationRequest,
  type AutonomousDeliveryConnectorProvider,
  type AutonomousDeliveryConnectorStatus,
  type AutonomousDeliveryDenialReason,
  type AutonomousDeliveryStep,
  type AutonomousDeliveryUsage,
} from "./autonomousDeliveryPolicy.js";

type AutonomousDeliveryErrorCode =
  | "AUTONOMOUS_DELIVERY_BAD_REQUEST"
  | "AUTONOMOUS_DELIVERY_PAYLOAD_TOO_LARGE"
  | "AUTONOMOUS_DELIVERY_FORBIDDEN_PAYLOAD";

type AutonomousDeliveryRunStatus = "completed" | "denied" | "halted";

interface AutonomousDeliveryStepResult {
  readonly stepId: string;
  readonly operation: GitRepositoryAgentOperationKind | "command-task" | "connector-operation";
  readonly status: "delegated" | "denied";
  readonly outcome?: "passed" | "failed" | undefined;
  readonly routeStatus?: number | undefined;
  readonly denialReason?: AutonomousDeliveryDenialReason | undefined;
  readonly evidence: CodingWorkbenchEvidenceRecord;
}

interface AutonomousDeliveryResponse {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly status: AutonomousDeliveryRunStatus;
  readonly steps: readonly AutonomousDeliveryStepResult[];
}

interface ParsedAutonomousDeliveryRequest {
  readonly authorityEnvelope: CodingWorkbenchAuthorityEnvelope;
  readonly confirmation: AutonomousDeliveryConfirmation;
  readonly operations: readonly AutonomousDeliveryStep[];
  readonly usage: AutonomousDeliveryUsage;
  readonly operatorStopped?: boolean | undefined;
}

const SAFE_MESSAGES: Readonly<Record<AutonomousDeliveryErrorCode, string>> = {
  AUTONOMOUS_DELIVERY_BAD_REQUEST:
    "The request body is not a valid autonomous delivery execution request.",
  AUTONOMOUS_DELIVERY_PAYLOAD_TOO_LARGE:
    "The autonomous delivery request exceeds the maximum permitted size.",
  AUTONOMOUS_DELIVERY_FORBIDDEN_PAYLOAD:
    "The autonomous delivery request contained a forbidden credential, header, URL, or unsafe text shape.",
};

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "authorityEnvelope",
  "confirmation",
  "operations",
  "usage",
  "operatorStopped",
]);

const CONFIRMATION_KEYS: ReadonlySet<string> = new Set([
  "confirmed",
  "approvalProofDigest",
  "confirmedAt",
]);

const USAGE_KEYS: ReadonlySet<string> = new Set([
  "runtimeMs",
  "toolCalls",
  "promptTokens",
  "patchBytes",
]);

const OPERATION_KEYS: ReadonlySet<string> = new Set(["kind", "stepId", "request"]);
const CONNECTOR_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "objectKind",
  "action",
  "targetRef",
  "idempotencyKey",
  "status",
  "commentKind",
  "dryRun",
]);
const MAX_AUTONOMOUS_OPERATIONS = 32;
const CONNECTOR_PROVIDERS = ["github", "jira"] as const;
const CONNECTOR_OBJECT_KINDS = ["issue", "pull-request"] as const;
const CONNECTOR_ACTIONS = ["status-update", "comment"] as const;
const CONNECTOR_STATUSES = ["in-progress", "ready-for-human-review", "blocked", "done"] as const;
const CONNECTOR_COMMENT_KINDS = ["progress", "handoff", "closure"] as const;

const errResult = (status: number, code: AutonomousDeliveryErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: RouteResult };

async function readParsed(req: IncomingMessage): Promise<BodyRead> {
  let raw: string;
  try {
    raw = await readGitDeliveryBody(req);
  } catch (error) {
    const code =
      error instanceof GitDeliveryBodyTooLargeError
        ? "AUTONOMOUS_DELIVERY_PAYLOAD_TOO_LARGE"
        : "AUTONOMOUS_DELIVERY_BAD_REQUEST";
    return {
      ok: false,
      result: errResult(code === "AUTONOMOUS_DELIVERY_BAD_REQUEST" ? 400 : 413, code),
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "AUTONOMOUS_DELIVERY_BAD_REQUEST") };
  }
}

function validateRequest(input: unknown): ParsedAutonomousDeliveryRequest | RouteResult {
  if (!isPlainObject(input) || !hasOnlyAllowedKeys(input, TOP_LEVEL_KEYS)) {
    return errResult(400, "AUTONOMOUS_DELIVERY_BAD_REQUEST");
  }
  if (scanForbiddenStrings(input)) return errResult(400, "AUTONOMOUS_DELIVERY_FORBIDDEN_PAYLOAD");
  if (scanUnsafeFormatChars(input) || input.schemaVersion !== "1") {
    return errResult(400, "AUTONOMOUS_DELIVERY_BAD_REQUEST");
  }
  return parseRequest(input);
}

function parseRequest(
  input: Record<string, unknown>,
): ParsedAutonomousDeliveryRequest | RouteResult {
  const confirmation = parseConfirmation(input.confirmation);
  const usage = parseUsage(input.usage);
  const operations = parseOperations(input.operations);
  if (confirmation === undefined || usage === undefined || operations === undefined) {
    return errResult(400, "AUTONOMOUS_DELIVERY_BAD_REQUEST");
  }
  if (!isPlainObject(input.authorityEnvelope)) {
    return errResult(400, "AUTONOMOUS_DELIVERY_BAD_REQUEST");
  }
  return {
    authorityEnvelope: input.authorityEnvelope as unknown as CodingWorkbenchAuthorityEnvelope,
    confirmation,
    operations,
    usage,
    ...(typeof input.operatorStopped === "boolean"
      ? { operatorStopped: input.operatorStopped }
      : {}),
  };
}

function parseConfirmation(value: unknown): AutonomousDeliveryConfirmation | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, CONFIRMATION_KEYS)) return undefined;
  if (typeof value.confirmed !== "boolean") return undefined;
  if (typeof value.approvalProofDigest !== "string") return undefined;
  if (typeof value.confirmedAt !== "string") return undefined;
  return {
    confirmed: value.confirmed,
    approvalProofDigest: value.approvalProofDigest,
    confirmedAt: value.confirmedAt,
  };
}

function parseUsage(value: unknown): AutonomousDeliveryUsage | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, USAGE_KEYS)) return undefined;
  const runtimeMs = nonNegativeInteger(value.runtimeMs);
  const toolCalls = nonNegativeInteger(value.toolCalls);
  const promptTokens = nonNegativeInteger(value.promptTokens);
  const patchBytes = nonNegativeInteger(value.patchBytes);
  if (runtimeMs === undefined || toolCalls === undefined) return undefined;
  if (promptTokens === undefined || patchBytes === undefined) return undefined;
  return { runtimeMs, toolCalls, promptTokens, patchBytes };
}

function parseOperations(value: unknown): readonly AutonomousDeliveryStep[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AUTONOMOUS_OPERATIONS) {
    return undefined;
  }
  const operations = value.map(parseOperationStep);
  return operations.every(
    (operation): operation is AutonomousDeliveryStep => operation !== undefined,
  )
    ? operations
    : undefined;
}

function parseOperationStep(value: unknown): AutonomousDeliveryStep | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, OPERATION_KEYS)) return undefined;
  if (typeof value.stepId !== "string" || value.stepId.length === 0) return undefined;
  if (value.kind === "command-task") return parseCommandStep(value.stepId, value.request);
  if (value.kind === "connector-operation") return parseConnectorStep(value.stepId, value.request);
  if (value.kind !== "repository-operation") return undefined;
  const parsed = parseGitRepositoryAgentOperationRequest(value.request);
  return parsed.ok
    ? { kind: "repository-operation", stepId: value.stepId, request: parsed.value }
    : undefined;
}

function parseCommandStep(
  stepId: string,
  request: unknown,
):
  | {
      readonly kind: "command-task";
      readonly stepId: string;
      readonly request: CommandTaskRunRequest;
    }
  | undefined {
  const parsed = parseCommandTaskRunRequest(request);
  return parsed.ok ? { kind: "command-task", stepId, request: parsed.value } : undefined;
}

function parseConnectorStep(
  stepId: string,
  request: unknown,
):
  | {
      readonly kind: "connector-operation";
      readonly stepId: string;
      readonly request: AutonomousDeliveryConnectorOperationRequest;
    }
  | undefined {
  const parsed = parseConnectorRequest(request);
  return parsed === undefined
    ? undefined
    : { kind: "connector-operation", stepId, request: parsed };
}

function parseConnectorRequest(
  value: unknown,
): AutonomousDeliveryConnectorOperationRequest | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, CONNECTOR_REQUEST_KEYS)) return undefined;
  const provider = enumValue(value.provider, CONNECTOR_PROVIDERS);
  const objectKind = enumValue(value.objectKind, CONNECTOR_OBJECT_KINDS);
  const action = enumValue(value.action, CONNECTOR_ACTIONS);
  const targetRef = requiredString(value.targetRef);
  const idempotencyKey = requiredString(value.idempotencyKey);
  if (provider === undefined || objectKind === undefined || action === undefined) return undefined;
  if (targetRef === undefined || idempotencyKey === undefined) return undefined;
  return connectorRequestWithPayload(
    value,
    provider,
    objectKind,
    action,
    targetRef,
    idempotencyKey,
  );
}

function connectorRequestWithPayload(
  value: Record<string, unknown>,
  provider: AutonomousDeliveryConnectorProvider,
  objectKind: AutonomousDeliveryConnectorObjectKind,
  action: AutonomousDeliveryConnectorAction,
  targetRef: string,
  idempotencyKey: string,
): AutonomousDeliveryConnectorOperationRequest | undefined {
  const status = enumValue(value.status, CONNECTOR_STATUSES);
  const commentKind = enumValue(value.commentKind, CONNECTOR_COMMENT_KINDS);
  const dryRun = typeof value.dryRun === "boolean" ? value.dryRun : undefined;
  if (action === "status-update" && status === undefined) return undefined;
  if (action === "comment" && commentKind === undefined) return undefined;
  return {
    provider,
    objectKind,
    action,
    targetRef,
    idempotencyKey,
    ...(status === undefined ? {} : { status }),
    ...(commentKind === undefined ? {} : { commentKind }),
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function delegateContext(
  ctx: RouteContext,
  body: GitRepositoryAgentOperationRequest,
): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { ...ctx.req.headers, "content-type": "application/json" };
  return {
    req,
    res: ctx.res,
    params: {},
    url: new URL("http://127.0.0.1/api/git/agent/operations"),
  };
}

function commandContext(ctx: RouteContext, body: CommandTaskRunRequest): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { ...ctx.req.headers, "content-type": "application/json" };
  return {
    req,
    res: ctx.res,
    params: {},
    url: new URL("http://127.0.0.1/api/commands/runs"),
  };
}

async function runAutonomousDelivery(
  parsed: ParsedAutonomousDeliveryRequest,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<AutonomousDeliveryResponse> {
  const steps: AutonomousDeliveryStepResult[] = [];
  for (const [index, step] of parsed.operations.entries()) {
    const result = await runStep(parsed, step, parsed.operations.length - index, ctx, deps);
    steps.push(result);
    if (result.status === "denied") return response(parsed, "denied", steps);
    if (result.outcome === "failed") return response(parsed, "halted", steps);
    if (result.routeStatus !== undefined && result.routeStatus >= 400) {
      return response(parsed, "halted", steps);
    }
  }
  return response(parsed, "completed", steps);
}

async function runStep(
  parsed: ParsedAutonomousDeliveryRequest,
  step: AutonomousDeliveryStep,
  remainingStepCount: number,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<AutonomousDeliveryStepResult> {
  const decision = decideAutonomousDeliveryOperation({
    authorityEnvelope: parsed.authorityEnvelope,
    confirmation: parsed.confirmation,
    step,
    usage: parsed.usage,
    nowIso: new Date().toISOString(),
    remainingStepCount,
    operatorStopped: parsed.operatorStopped,
  });
  if (decision.status === "denied") {
    return deniedStep(step, decision.denialReason, decision.evidence);
  }
  if (step.kind === "command-task") return runCommandStep(step, decision.evidence, ctx, deps);
  if (step.kind === "connector-operation") {
    return runConnectorStep(parsed, step, decision.evidence, deps);
  }
  const delegated = await handleGitAgentOperation(delegateContext(ctx, step.request), deps);
  return {
    stepId: step.stepId,
    operation: step.request.operation,
    status: "delegated",
    routeStatus: delegated.status,
    evidence: decision.evidence,
  };
}

async function runConnectorStep(
  parsed: ParsedAutonomousDeliveryRequest,
  step: Extract<AutonomousDeliveryStep, { readonly kind: "connector-operation" }>,
  evidence: CodingWorkbenchEvidenceRecord,
  deps: UiHandlerDeps,
): Promise<AutonomousDeliveryStepResult> {
  const connector = deps.autonomousDeliveryConnector;
  if (connector === undefined) {
    const decision = autonomousDeliveryDeniedStep(
      connectorPolicyRequest(parsed, step),
      "delivery-policy-denied",
    );
    return deniedStep(step, decision.denialReason, decision.evidence);
  }
  const result = await connector.execute(step.request);
  return {
    stepId: step.stepId,
    operation: "connector-operation",
    status: "delegated",
    outcome: result.routeStatus >= 400 ? "failed" : undefined,
    routeStatus: result.routeStatus,
    evidence,
  };
}

function connectorPolicyRequest(
  parsed: ParsedAutonomousDeliveryRequest,
  step: Extract<AutonomousDeliveryStep, { readonly kind: "connector-operation" }>,
): Parameters<typeof decideAutonomousDeliveryOperation>[0] {
  return {
    authorityEnvelope: parsed.authorityEnvelope,
    confirmation: parsed.confirmation,
    step,
    usage: parsed.usage,
    nowIso: new Date().toISOString(),
    remainingStepCount: 1,
    operatorStopped: parsed.operatorStopped,
  };
}

async function runCommandStep(
  step: Extract<AutonomousDeliveryStep, { readonly kind: "command-task" }>,
  evidence: CodingWorkbenchEvidenceRecord,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<AutonomousDeliveryStepResult> {
  const delegated = await handleCreateCommandRun(commandContext(ctx, step.request), deps);
  return {
    stepId: step.stepId,
    operation: "command-task",
    status: "delegated",
    outcome: commandOutcome(delegated),
    routeStatus: delegated.status,
    evidence,
  };
}

function commandOutcome(result: RouteResult): "passed" | "failed" {
  if (result.status >= 400) return "failed";
  const parsed = validateCommandTaskRunResult(result.body);
  if (!parsed.ok) return "failed";
  return parsed.value.failureReason === "none" ? "passed" : "failed";
}

function deniedStep(
  step: AutonomousDeliveryStep,
  denialReason: AutonomousDeliveryDenialReason,
  evidence: CodingWorkbenchEvidenceRecord,
): AutonomousDeliveryStepResult {
  return {
    stepId: step.stepId,
    operation:
      step.kind === "repository-operation"
        ? step.request.operation
        : step.kind === "command-task"
          ? "command-task"
          : "connector-operation",
    status: "denied",
    denialReason,
    evidence,
  };
}

function response(
  parsed: ParsedAutonomousDeliveryRequest,
  status: AutonomousDeliveryRunStatus,
  steps: readonly AutonomousDeliveryStepResult[],
): AutonomousDeliveryResponse {
  return {
    schemaVersion: "1",
    runId: parsed.authorityEnvelope.runId,
    status,
    steps,
  };
}

export async function handleAutonomousDeliveryExecute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const read = await readParsed(ctx.req);
  if (!read.ok) return read.result;
  const parsed = validateRequest(read.value);
  if ("status" in parsed && "body" in parsed) return parsed;
  const body = await runAutonomousDelivery(parsed, ctx, deps);
  return { status: 200, body };
}

export const AUTONOMOUS_DELIVERY_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/coding-workbench/autonomous-delivery/execute",
    handler: handleAutonomousDeliveryExecute,
  },
];
