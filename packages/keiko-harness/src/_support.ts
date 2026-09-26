import type {
  CatalogToolDispatchOutcome,
  BoundToolInvocation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
// Shared deterministic test fixtures: stub clock, scripted model port, recording tool
// port, and a RunContext builder. No real timers, network, or fs (ADR-0004 test rules).

import type {
  Clock,
  NormalizedResponse,
  NormalizedToolCall,
  ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createInitialToolCatalog,
  compileToolProjection,
  createToolInvocationNormalizer,
  lookupCatalogTool,
  catalogJsonBytes,
} from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogToolPort,
  GatewayToolCatalogAdvertisement,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  bindHarnessCatalog,
  type HarnessCatalogFactory,
  type HarnessCatalogContext,
} from "./catalog-runtime.js";
import { Emitter } from "./emitter.js";
import { MemoryEventSink } from "./sinks.js";
import { newCounters, type RunContext } from "./context.js";
import type { HarnessCompactionPort } from "./context-compaction-port.js";
import type { ModelPort, ToolCallRequest, ToolCallResult, ToolPort } from "./ports.js";
import type { HarnessShaperPort } from "./shaper-port.js";
import { resolveTaskPlan } from "./tasks/policy.js";
import { DEFAULT_LIMITS, type HarnessLimits, type TaskInput } from "./types.js";

export function stubClock(start = 0): { clock: Clock; set: (ms: number) => void } {
  let current = start;
  const pendingSleeps = new Set<() => void>();
  return {
    set: (ms: number): void => {
      current = ms;
      for (const resolve of pendingSleeps) {
        resolve();
      }
      pendingSleeps.clear();
    },
    clock: {
      now: (): number => current,
      sleep: (_ms: number, signal?: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new Error("aborted"));
            return;
          }
          const finish = (): void => {
            pendingSleeps.delete(finish);
            resolve();
          };
          pendingSleeps.add(finish);
          signal?.addEventListener(
            "abort",
            () => {
              pendingSleeps.delete(finish);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    },
  };
}

export function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    modelId: "m",
    content: "diff content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
    ...overrides,
  };
}

export function toolCall(id: string, name = "read_file"): NormalizedToolCall {
  return {
    id,
    name,
    arguments:
      name === "read_file"
        ? { path: "fixture.txt" }
        : name === "run_command"
          ? { command: "npm" }
          : name === "apply_patch" || name === "propose_patch"
            ? { diff: "fixture-diff" }
            : {},
  };
}

// A model port that returns scripted responses (one per call), or throws scripted errors.
export function scriptedModel(script: readonly (NormalizedResponse | Error)[]): {
  port: ModelPort;
  calls: () => number;
  requests: () => readonly Parameters<ModelPort["call"]>[0][];
} {
  let i = 0;
  const requests: Parameters<ModelPort["call"]>[0][] = [];
  return {
    calls: (): number => i,
    requests: (): readonly Parameters<ModelPort["call"]>[0][] => requests,
    port: {
      call: (request): Promise<NormalizedResponse> => {
        requests.push(request);
        const item = script[Math.min(i, script.length - 1)];
        i += 1;
        if (item instanceof Error) {
          return Promise.reject(item);
        }
        const selected = item ?? response();
        const normalizer =
          request.toolCatalog === undefined
            ? undefined
            : createToolInvocationNormalizer({
                catalog: request.toolCatalog.catalog,
                projection: request.toolCatalog.projection,
                offered: request.toolCatalog.offered,
              });
        return Promise.resolve({
          ...selected,
          toolCalls: selected.toolCalls.map((call) => ({
            ...call,
            ...(normalizer === undefined
              ? {}
              : { invocation: normalizer.bindAlias(call.name, call.arguments, 0) }),
          })),
        });
      },
    },
  };
}

export function recordingTool(tools: readonly ToolDefinition[] = []): {
  port: ToolPort;
  calls: () => readonly ToolCallRequest[];
} {
  const seen: ToolCallRequest[] = [];
  return {
    calls: (): readonly ToolCallRequest[] => seen,
    port: {
      execute: (request: ToolCallRequest): Promise<ToolCallResult> => {
        seen.push(request);
        return Promise.resolve({
          toolCallId: request.toolCallId,
          output: "tool output",
          durationMs: 0,
        });
      },
      listTools: (): readonly ToolDefinition[] => tools,
    },
  };
}

export interface CtxOptions {
  readonly task: TaskInput;
  readonly model: ModelPort;
  readonly tools?: ToolPort | undefined;
  readonly clock?: Clock | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: Partial<HarnessLimits> | undefined;
  readonly sink?: MemoryEventSink | undefined;
  readonly shaperPort?: HarnessShaperPort | undefined;
  readonly compactionPort?: HarnessCompactionPort | undefined;
}

export function buildContext(options: CtxOptions): { ctx: RunContext; sink: MemoryEventSink } {
  const sink = options.sink ?? new MemoryEventSink();
  const clock = options.clock ?? stubClock().clock;
  const limits: HarnessLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const plan = resolveTaskPlan(options.task);
  const emitter = new Emitter([sink], clock, "run-1", "fp");
  const ctx: RunContext = {
    model: options.model,
    tools: options.tools ?? recordingTool().port,
    emitter,
    clock,
    signal: options.signal ?? new AbortController().signal,
    limits,
    modelId: "m",
    taskType: options.task.taskType,
    plan,
    startedAt: clock.now(),
    counters: newCounters(),
    ...(options.shaperPort === undefined ? {} : { shaperPort: options.shaperPort }),
    ...(options.compactionPort === undefined ? {} : { compactionPort: options.compactionPort }),
    shapedObservations: [],
    compactedToolMessages: new Map(),
    messages: [...plan.messages],
    lastResponse: undefined,
    patchDiff: undefined,
    report: undefined,
    failure: undefined,
    cancelReason: undefined,
    cancelledAtState: undefined,
  };
  ctx.catalog = bindHarnessCatalog(ctx, "run-1", catalogTestFactory(ctx.tools));
  return { ctx, sink };
}

// Unit transport fixture only. Runtime authority/settlement is proved by the server binder suites.
export function catalogTestFactory(tools: ToolPort): HarnessCatalogFactory {
  return (context): CatalogToolPort => {
    const advertisement = unitAdvertisement();
    const { catalog, projection } = advertisement;
    let invocationSequence = 0;
    return {
      kind: "catalog",
      offer: (): GatewayToolCatalogAdvertisement => advertisement,
      execute: async (request): Promise<CatalogToolDispatchOutcome> => {
        const invocation = createToolInvocationNormalizer({
          catalog,
          projection,
          offered: advertisement.offered,
        }).normalize(request.invocation, 0);
        const tool = projection.tools.find(
          (entry) => entry.toolRef.canonicalId === invocation.toolRef.canonicalId,
        );
        const descriptor = lookupCatalogTool(catalog, invocation.toolRef);
        if (tool === undefined || descriptor === undefined)
          throw new TypeError("Unknown unit tool");
        const invocationId = `unit-invocation-${String(++invocationSequence)}`;
        const reservation = context.budgetPort.reserve(descriptor, context, invocationId);
        if (reservation === undefined || !context.budgetPort.check(reservation, context))
          throw new TypeError("Unit budget denied");
        const result = await tools.execute({
          toolCallId: request.toolCallId,
          toolName: tool.alias,
          arguments: invocation.arguments as Record<string, unknown>,
          signal: request.signal,
        });
        context.budgetPort.commit(reservation);
        observeUnitResult(context, descriptor.toolRef, result);
        return unitOutcome(invocation, invocationId, reservation.reservationId, result);
      },
    };
  };
}
function observeUnitResult(
  context: HarnessCatalogContext,
  toolRef: import("@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog").ToolRef,
  result: ToolCallResult,
): void {
  context.observeExecution({
    toolRef,
    toolCallId: result.toolCallId,
    commandExecuted: result.commandExecuted === true,
    durationMs: result.durationMs,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
  });
}

export function prepareToolResponse(ctx: RunContext): void {
  if (ctx.catalog === undefined || ctx.lastResponse === undefined)
    throw new TypeError("Missing unit catalog");
  const { catalog, projection, offered } = ctx.catalog.port.offer();
  const normalizer = createToolInvocationNormalizer({ catalog, projection, offered });
  ctx.catalog.normalizer = normalizer;
  ctx.lastResponse = {
    ...ctx.lastResponse,
    toolCalls: ctx.lastResponse.toolCalls.map((call) => ({
      ...call,
      invocation: normalizer.bindAlias(call.name, call.arguments, ctx.clock.now()),
    })),
  };
}

function unitAdvertisement(): GatewayToolCatalogAdvertisement {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return {
    kind: "bound",
    catalog,
    projection,
    offered: {
      binding: {
        catalogRevision: catalog.catalogRevision,
        profile: projection.profile,
        projectionDigest: projection.projectionDigest,
        handlerSetDigest: projection.projectionDigest,
        readiness: "ready",
      },
      offerId: "unit-offer",
      toolRefs: projection.tools.map((tool) => tool.toolRef),
      expiresAt: "2100-01-01T00:00:00.000Z",
    },
  };
}

function unitOutcome(
  invocation: BoundToolInvocation,
  invocationId: string,
  reservationId: string,
  result: ToolCallResult,
): CatalogToolDispatchOutcome {
  return {
    kind: "settled",
    receipt: {
      invocationId,
      reservationId: reservationId,
      settlementId: invocationId,
      budgetDisposition: "committed",
      effectStarted: true,
      status: "completed",
    },
    result: {
      schemaVersion: 1,
      invocationId,
      toolRef: invocation.toolRef,
      projectionDigest: invocation.projectionDigest,
      status: "completed",
      reason: "none",
      effectStarted: true,
      metrics: {
        inputBytes: catalogJsonBytes(invocation.arguments),
        outputBytes: catalogJsonBytes(result.output),
        resultCount: 1,
        durationMs: result.durationMs,
      },
      page: { truncated: false, reason: "none", cursor: null },
      data: result.output,
    },
  };
}
