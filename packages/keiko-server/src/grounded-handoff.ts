import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  GroundedWorkflowHandoffRequest as GroundedWorkflowHandoffWire,
  GroundedWorkflowHandoffResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  DEFAULT_PATCH_SCOPE_LIMITS,
  EXPECTED_CHECKS,
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  WORKFLOW_KINDS,
  type ExpectedCheck,
  type WorkflowKind,
  type WorkflowHandoffRequest,
  validateWorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import { createAuditRedactor } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { WorkspaceError } from "@oscharko-dev/keiko-workspace";
import { currentRedactionSecrets, type UiHandlerDeps } from "./deps.js";
import {
  approvalTokenInputFor,
  contextPackStableIdForPacks,
  createApprovalToken,
  evidenceAtomIdsForPacks,
  readOnlyPathsForPacks,
} from "./governed-workflow.js";
import { lookupGroundedTurn } from "./grounded-turn-registry.js";
import { startRun, type EngineContext } from "./run-engine.js";
import { parseRunRequest, type RunRequest } from "./run-request.js";
import { ActiveRunLimitError } from "./runs.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { ChatMessage, NewChatMessage } from "./store/types.js";

const MAX_BODY_BYTES = 256 * 1024;

const VERIFY_NOOP_MODEL: ModelPort = {
  call: () => Promise.reject(new Error("verify runs must not call the model")),
};

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpectedCheck(value: unknown): value is ExpectedCheck {
  return typeof value === "string" && (EXPECTED_CHECKS as readonly string[]).includes(value);
}

function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

function parseJsonRecord(raw: string): Record<string, unknown> | RouteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function badField(field: string, message: string): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", `Field "${field}" ${message}.`),
  };
}

function requireString(
  body: Record<string, unknown>,
  field: keyof GroundedWorkflowHandoffWire,
): string | RouteResult {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    return badField(field, "is required");
  }
  return value;
}

function requireNumber(
  body: Record<string, unknown>,
  field: keyof GroundedWorkflowHandoffWire,
): number | RouteResult {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return badField(field, "must be a finite number");
  }
  return value;
}

function requireRecord(
  body: Record<string, unknown>,
  field: keyof GroundedWorkflowHandoffWire,
): Record<string, unknown> | RouteResult {
  const value = body[field];
  if (!isRecord(value)) {
    return badField(field, "must be an object");
  }
  return value;
}

function stringArrayField(
  body: Record<string, unknown>,
  field: keyof Pick<
    GroundedWorkflowHandoffWire,
    "editablePaths" | "expectedChecks" | "unknowns"
  >,
): readonly string[] | RouteResult {
  const value = body[field];
  if (!Array.isArray(value)) {
    return badField(field, "must be an array");
  }
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return badField(field, "must contain non-empty strings");
    }
    parsed.push(entry);
  }
  return parsed;
}

function defaultExpectedChecks(workflowKind: WorkflowKind): readonly ExpectedCheck[] {
  if (workflowKind === "unit-test-generation") {
    return ["tests"];
  }
  return ["verify"];
}

function parseExpectedChecks(
  body: Record<string, unknown>,
  workflowKind: WorkflowKind,
): readonly ExpectedCheck[] | RouteResult {
  if (body.expectedChecks === undefined) {
    return defaultExpectedChecks(workflowKind);
  }
  const parsed = stringArrayField(body, "expectedChecks");
  if (isRouteResult(parsed)) {
    return parsed;
  }
  if (!parsed.every(isExpectedCheck)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", 'Field "expectedChecks" contains an unknown check.'),
    };
  }
  return parsed;
}

interface ParsedGroundedHandoffBody {
  readonly assistantMessageId: string;
  readonly modelId: string;
  readonly workflowKind: WorkflowKind;
  readonly input: Record<string, unknown>;
  readonly editablePaths: readonly string[];
  readonly expectedChecks: readonly ExpectedCheck[];
  readonly unknowns: readonly string[];
  readonly requestedAtMs: number;
}

function parseWorkflowKindField(
  body: Record<string, unknown>,
): WorkflowKind | RouteResult {
  const workflowKind = requireString(body, "workflowKind");
  if (isRouteResult(workflowKind)) {
    return workflowKind;
  }
  return isWorkflowKind(workflowKind)
    ? workflowKind
    : { status: 400, body: errorBody("BAD_REQUEST", 'Field "workflowKind" is invalid.') };
}

function parseUnknowns(body: Record<string, unknown>): readonly string[] | RouteResult {
  return body.unknowns === undefined ? [] : stringArrayField(body, "unknowns");
}

function parseBody(raw: string): ParsedGroundedHandoffBody | RouteResult {
  const body = parseJsonRecord(raw);
  if (isRouteResult(body)) {
    return body;
  }
  const workflowKind = parseWorkflowKindField(body);
  if (isRouteResult(workflowKind)) {
    return workflowKind;
  }
  const assistantMessageId = requireString(body, "assistantMessageId");
  if (isRouteResult(assistantMessageId)) {
    return assistantMessageId;
  }
  const modelId = requireString(body, "modelId");
  if (isRouteResult(modelId)) {
    return modelId;
  }
  const input = requireRecord(body, "input");
  if (isRouteResult(input)) {
    return input;
  }
  const editablePaths = stringArrayField(body, "editablePaths");
  if (isRouteResult(editablePaths)) {
    return editablePaths;
  }
  const unknowns = parseUnknowns(body);
  if (isRouteResult(unknowns)) {
    return unknowns;
  }
  const requestedAtMs = requireNumber(body, "requestedAtMs");
  if (isRouteResult(requestedAtMs)) {
    return requestedAtMs;
  }
  const expectedChecks = parseExpectedChecks(body, workflowKind);
  if (isRouteResult(expectedChecks)) {
    return expectedChecks;
  }
  return {
    assistantMessageId,
    modelId,
    workflowKind,
    input,
    editablePaths,
    expectedChecks,
    unknowns,
    requestedAtMs,
  };
}

function workspaceRootForTurn(record: ReturnType<typeof lookupGroundedTurn>): string | RouteResult {
  const roots = new Set(record?.packs.map((pack) => pack.scope.workspaceRoot) ?? []);
  if (roots.size !== 1) {
    return {
      status: 409,
      body: errorBody(
        "BAD_REQUEST",
        "Grounded handoff requires evidence from a single connected workspace root.",
      ),
    };
  }
  const root = [...roots][0];
  if (typeof root !== "string" || root.length === 0) {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", "Grounded handoff context is no longer available."),
    };
  }
  return root;
}

function runRequestFor(
  workflowKind: WorkflowKind,
  modelId: string,
  workspaceRoot: string,
  input: Record<string, unknown>,
): RunRequest | RouteResult {
  const parsed = parseRunRequest(
    JSON.stringify({
      ...(workflowKind === "verification"
        ? { taskType: "verify" }
        : { workflowId: workflowKind }),
      modelId,
      input: { workspaceRoot, ...input },
    }),
  );
  if ("code" in parsed) {
    return { status: 400, body: errorBody(parsed.code, parsed.message) };
  }
  return parsed;
}

function summaryDiscriminator(
  workflowKind: WorkflowKind,
): Pick<NewChatMessage, "workflowId" | "taskType"> {
  if (workflowKind === "verification") {
    return { workflowId: undefined, taskType: "verify" };
  }
  return { workflowId: workflowKind, taskType: undefined };
}

function workflowLabel(workflowKind: WorkflowKind): string {
  if (workflowKind === "unit-test-generation") {
    return "grounded unit-test generation";
  }
  if (workflowKind === "bug-investigation") {
    return "grounded bug investigation";
  }
  return "grounded verification";
}

function persistGroundedHandoffMessages(
  deps: UiHandlerDeps,
  chatId: string,
  workflowKind: WorkflowKind,
  runId: string,
): readonly [ChatMessage, ChatMessage] {
  const now = Date.now();
  const discriminator = summaryDiscriminator(workflowKind);
  const label = workflowLabel(workflowKind);
  const [user, summary] = deps.store.createMessages([
    {
      chatId,
      role: "user",
      content: `Requested ${label}.`,
      timestamp: now,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    },
    {
      chatId,
      role: "system",
      content: `Launched ${label}.`,
      timestamp: now + 1,
      runId,
      workflowId: discriminator.workflowId,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: discriminator.taskType,
    },
  ]);
  if (user === undefined || summary === undefined) {
    throw new Error("createMessages returned fewer rows than expected");
  }
  return [user, summary];
}

function resolveRunModel(request: RunRequest, deps: UiHandlerDeps): ModelPort | undefined {
  return request.kind === "verify" ? VERIFY_NOOP_MODEL : deps.modelPortFactory(request.modelId);
}

function engineContextFor(
  deps: UiHandlerDeps,
  request: RunRequest,
  model: ModelPort,
): EngineContext {
  return {
    request,
    model,
    registry: deps.registry,
    evidence: {
      store: deps.evidenceStore,
      env: deps.env,
      additionalSecrets: currentRedactionSecrets(deps),
    },
    memoryVault: deps.memoryVault,
    memoryAuditRedactString: createAuditRedactor(
      { additionalSecrets: currentRedactionSecrets(deps) },
      deps.env,
    ),
  };
}

function markSummaryFailed(deps: UiHandlerDeps, message: ChatMessage, shortResult: string): void {
  try {
    deps.store.updateMessage(message.id, { workflowStatus: "failed", shortResult });
  } catch {
    // best-effort compensation only
  }
}

function mapRunStartError(error: unknown): RouteResult {
  if (error instanceof ActiveRunLimitError) {
    return { status: 429, body: errorBody("TOO_MANY_RUNS", "The active run limit is reached.") };
  }
  if (error instanceof WorkspaceError) {
    return {
      status: 400,
      body: errorBody(
        "WORKSPACE_UNAVAILABLE",
        "The selected workspace could not be prepared: no recognized project workspace marker was found, or the target file could not be read.",
      ),
    };
  }
  throw error;
}

function buildGovernedHandoffRequest(
  body: ParsedGroundedHandoffBody,
  record: NonNullable<ReturnType<typeof lookupGroundedTurn>>,
): WorkflowHandoffRequest | RouteResult {
  const patchScope = {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    editablePaths: body.editablePaths,
    readOnlyPaths: readOnlyPathsForPacks(record.packs, body.editablePaths),
    evidenceAtomIds: evidenceAtomIdsForPacks(record.packs),
    limits: DEFAULT_PATCH_SCOPE_LIMITS,
    expectedChecks: body.expectedChecks,
    unknowns: body.unknowns,
  } as const;
  const draft: WorkflowHandoffRequest = {
    schemaVersion: WORKFLOW_HANDOFF_SCHEMA_VERSION,
    contextPackStableId: contextPackStableIdForPacks(record.packs),
    workflowKind: body.workflowKind,
    patchScope,
    requestedAtMs: body.requestedAtMs,
    userApprovalToken: "0".repeat(64),
  };
  const request: WorkflowHandoffRequest = {
    ...draft,
    userApprovalToken: createApprovalToken(approvalTokenInputFor(draft)),
  };
  const validation = validateWorkflowHandoffRequest(request);
  if (!validation.ok) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", validation.reasons.join("; ")),
    };
  }
  return request;
}

async function parseGroundedHandoffBody(
  req: IncomingMessage,
): Promise<ParsedGroundedHandoffBody | RouteResult> {
  try {
    return parseBody(await readBody(req));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
}

interface ResolvedGroundedHandoffLaunch {
  readonly chatId: string;
  readonly workflowKind: WorkflowKind;
  readonly request: RunRequest;
  readonly model: ModelPort;
}

function resolveGroundedHandoffLaunch(
  body: ParsedGroundedHandoffBody,
  deps: UiHandlerDeps,
): ResolvedGroundedHandoffLaunch | RouteResult {
  const record = lookupGroundedTurn(body.assistantMessageId);
  if (record === undefined) {
    return {
      status: 404,
      body: errorBody("NOT_FOUND", "Grounded handoff context is no longer available."),
    };
  }
  const workspaceRoot = workspaceRootForTurn(record);
  if (isRouteResult(workspaceRoot)) {
    return workspaceRoot;
  }
  const governedHandoff = buildGovernedHandoffRequest(body, record);
  if (isRouteResult(governedHandoff)) {
    return governedHandoff;
  }
  const baseRequest = runRequestFor(body.workflowKind, body.modelId, workspaceRoot, body.input);
  if (isRouteResult(baseRequest)) {
    return baseRequest;
  }
  const request: RunRequest = {
    ...baseRequest,
    governedHandoff,
    governedHandoffSourceGroundedRunId: record.evidenceRunId,
  };
  const model = resolveRunModel(request, deps);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return { chatId: record.chatId, workflowKind: body.workflowKind, request, model };
}

function startGroundedWorkflowRun(
  deps: UiHandlerDeps,
  launch: ResolvedGroundedHandoffLaunch,
): RouteResult {
  const runId = randomUUID();
  const messages = persistGroundedHandoffMessages(deps, launch.chatId, launch.workflowKind, runId);
  try {
    const run = startRun(engineContextFor(deps, launch.request, launch.model), deps.redactor, {
      runId,
    });
    return {
      status: 202,
      body: { run, messages } satisfies GroundedWorkflowHandoffResponse,
    };
  } catch (error) {
    markSummaryFailed(deps, messages[1], "Run could not be started.");
    return mapRunStartError(error);
  }
}

export async function handleGroundedWorkflowHandoff(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await parseGroundedHandoffBody(ctx.req);
  if (isRouteResult(body)) {
    return body;
  }
  const launch = resolveGroundedHandoffLaunch(body, deps);
  return isRouteResult(launch) ? launch : startGroundedWorkflowRun(deps, launch);
}
