import type { ToolCallResult, ToolCallMetadata } from "@oscharko-dev/keiko-contracts";
import type {
  CatalogToolPort,
  GatewayToolCatalogAdvertisement,
  ToolInvocationBudgetPort,
  ToolHandlerExecutionEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  ToolDescriptor,
  ToolRef,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureToolInvocationReceipt,
  type CatalogToolDispatchOutcome,
  type BoundToolInvocation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { NormalizedToolCall, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  createToolInvocationNormalizer,
  captureCatalogJson,
  lookupCatalogTool,
  validateToolResultEnvelope,
  type ToolInvocationNormalizer,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  createHarnessCatalogBudget,
  descriptorRunsCommand,
  type HarnessBudgetContext,
  type HarnessCatalogBudget,
} from "./catalog-budget.js";
import { captureHarnessToolCall } from "./catalog-call.js";
import { HarnessCatalogError } from "./catalog-errors.js";
import type { RunContext } from "./context.js";
import { HARNESS_CODES } from "./errors.js";
import { emitToolMetadata } from "./tool-audit.js";

export type HarnessToolExecutionEvidence = ToolHandlerExecutionEvidence;
export interface HarnessCatalogContext extends HarnessBudgetContext {
  readonly budgetPort: ToolInvocationBudgetPort<HarnessBudgetContext>;
  readonly observeExecution: (evidence: HarnessToolExecutionEvidence) => void;
}
export type HarnessCatalogFactory = (context: HarnessCatalogContext) => CatalogToolPort;
export interface HarnessCatalogRuntime {
  readonly port: CatalogToolPort;
  readonly budget: HarnessCatalogBudget;
  normalizer: ToolInvocationNormalizer | undefined;
  activeCall?: {
    readonly id: string;
    readonly descriptor: ToolDescriptor;
    evidence?: HarnessToolExecutionEvidence;
    violation?: HarnessCatalogError;
  };
}
export function bindHarnessCatalog(
  ctx: RunContext,
  runId: string,
  factory: HarnessCatalogFactory,
): HarnessCatalogRuntime {
  const budget = createHarnessCatalogBudget({
    runId,
    signal: ctx.signal,
    counters: ctx.counters,
    limits: ctx.limits,
    now: ctx.clock.now,
    deadlineAt: ctx.startedAt + ctx.limits.maxWallTimeMs,
  });
  const port = factory({
    runId,
    signal: ctx.signal,
    budgetPort: budget.port,
    observeExecution: (evidence): void => {
      observeExecution(ctx, evidence);
    },
  });
  return { port, budget, normalizer: undefined };
}
export function catalogAdvertisement(ctx: RunContext): GatewayToolCatalogAdvertisement | undefined {
  if (ctx.catalog === undefined) return undefined;
  const offer = ctx.catalog.port.offer();
  const normalizer = createToolInvocationNormalizer(
    { catalog: offer.catalog, projection: offer.projection, offered: offer.offered },
    offer.kind === "legacy-native" ? offer.legacySession : undefined,
  );
  normalizer.tools(ctx.clock.now());
  ctx.catalog.normalizer = normalizer;
  return { kind: "bound", ...normalizer.binding };
}
function descriptorFor(ctx: RunContext, ref: ToolRef): ToolDescriptor {
  const normalizer = ctx.catalog?.normalizer;
  const descriptor =
    normalizer === undefined ? undefined : lookupCatalogTool(normalizer.binding.catalog, ref);
  if (descriptor === undefined)
    throw new HarnessCatalogError(HARNESS_CODES.INTERNAL, "Unknown catalog tool identity");
  return descriptor;
}
function observeExecution(ctx: RunContext, evidence: HarnessToolExecutionEvidence): void {
  const active = ctx.catalog?.activeCall;
  const descriptor = descriptorFor(ctx, evidence.toolRef);
  if (
    active?.id !== evidence.toolCallId ||
    active.evidence !== undefined ||
    active.descriptor.descriptorDigest !== descriptor.descriptorDigest
  )
    throw new HarnessCatalogError(
      HARNESS_CODES.INTERNAL,
      "Tool execution evidence identity mismatch",
    );
  active.evidence = evidence;
  if (evidence.commandExecuted && !descriptorRunsCommand(descriptor)) {
    // Issue2638: account for the unexpected actual command and stop the run. No alias has authority.
    ctx.counters.commandExecutions += 1;
    active.violation = new HarnessCatalogError(
      HARNESS_CODES.INTERNAL,
      "Tool executed a command outside its declared effects",
    );
    throw active.violation;
  }
  emitToolMetadata(ctx, evidence.metadata, evidence.durationMs);
}
function requireToolBudget(ctx: RunContext, descriptor: ToolDescriptor): void {
  if (ctx.counters.toolCalls >= ctx.limits.maxToolCalls)
    throw new HarnessCatalogError(
      HARNESS_CODES.LIMIT_TOOL_CALLS,
      "Tool invocation budget exhausted",
    );
  if (
    descriptorRunsCommand(descriptor) &&
    ctx.counters.commandExecutions >= ctx.limits.maxCommandExecutions
  )
    throw new HarnessCatalogError(
      HARNESS_CODES.LIMIT_COMMAND_EXEC,
      "Command execution budget exhausted",
    );
}
export async function executeCatalogCall(
  ctx: RunContext,
  call: NormalizedToolCall,
): Promise<ToolCallResult> {
  const runtime = ctx.catalog;
  if (runtime?.normalizer === undefined || call.invocation === undefined)
    throw new HarnessCatalogError(
      HARNESS_CODES.TOOL_ERROR,
      "Catalog handler unavailable or invocation unbound",
    );
  const captured = captureHarnessToolCall(runtime.normalizer, call, ctx.clock.now());
  const invocation = captured.invocation;
  const descriptor = descriptorFor(ctx, invocation.toolRef);
  requireToolBudget(ctx, descriptor);
  runtime.activeCall = { id: call.id, descriptor };
  try {
    const outcome = await runtime.port.execute({
      toolCallId: call.id,
      invocation,
      signal: ctx.signal,
    });
    return settledResult(runtime, descriptor, invocation, outcome, captured.id);
  } finally {
    delete runtime.activeCall;
  }
}

function settledResult(
  runtime: HarnessCatalogRuntime,
  descriptor: ToolDescriptor,
  invocation: BoundToolInvocation,
  outcome: CatalogToolDispatchOutcome,
  toolCallId: string,
): ToolCallResult {
  if (outcome.kind === "replayed") {
    captureToolInvocationReceipt(outcome.receipt);
    throw new HarnessCatalogError(
      HARNESS_CODES.TOOL_ERROR,
      "Previous invocation settled; replay output unavailable",
    );
  }
  const receipt = captureToolInvocationReceipt(outcome.receipt);
  const result = validateToolResultEnvelope(outcome.result, {
    descriptor,
    projectionDigest: invocation.projectionDigest,
  });
  runtime.budget.acceptReceipt(receipt, descriptor);
  if (runtime.activeCall?.violation !== undefined) throw runtime.activeCall.violation;
  if (
    result.invocationId !== receipt.invocationId ||
    result.status !== receipt.status ||
    result.effectStarted !== receipt.effectStarted
  )
    throw new HarnessCatalogError(HARNESS_CODES.INTERNAL, "Tool settlement identity mismatch");
  if (result.status !== "completed")
    throw new HarnessCatalogError(
      HARNESS_CODES.TOOL_ERROR,
      `Tool invocation ${result.status}: ${result.reason}`,
    );
  return renderToolResult(result, toolCallId, runtime.activeCall?.evidence?.metadata);
}

export function captureModelToolCalls(
  ctx: RunContext,
  response: NormalizedResponse,
): NormalizedResponse {
  if (!ctx.plan.allowsTools || response.toolCalls.length === 0) return response;
  const normalizer = ctx.catalog?.normalizer;
  if (normalizer === undefined)
    throw new HarnessCatalogError(HARNESS_CODES.TOOL_ERROR, "Catalog handler unavailable");
  const calls = captureCatalogJson(response.toolCalls) as unknown as readonly NormalizedToolCall[];
  const captured = calls.map((call) => captureHarnessToolCall(normalizer, call, ctx.clock.now()));
  if (new Set(captured.map((call) => call.id)).size !== captured.length)
    throw new HarnessCatalogError(HARNESS_CODES.INTERNAL, "Duplicate provider tool call identity");
  return { ...response, toolCalls: Object.freeze(captured) };
}

function renderToolResult(
  result: Extract<ToolResultEnvelope, { status: "completed" }>,
  toolCallId: string,
  metadata: ToolCallMetadata | undefined,
): ToolCallResult {
  return {
    toolCallId,
    output: typeof result.data === "string" ? result.data : JSON.stringify(result.data),
    durationMs: result.metrics.durationMs,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
