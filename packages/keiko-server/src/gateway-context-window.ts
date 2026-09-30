// Real context windows for models whose gateway declares none (customer report on 1.1.13).
//
// A LiteLLM `hosted_vllm` deployment — and any Azure deployment set up without discovery — reaches
// Keiko without a declared window, so its capability carries the 4,096 setup placeholder flagged
// `contextWindowAssumed`. Conversation budgeting plans such a model with the default geometry;
// this module replaces the assumption with the deployment's exact window from two provider
// statements:
//   1. a context-window probe when a conversation first shows the model (once per deployment);
//   2. every provider overflow answer that names the window (the Gateway's report hook).
// Both persist through gateway-setup's verified-capability path, which advances the configuration
// generation so every surface re-plans the model. Nothing here throws into a caller: an adoption
// or probe failure is recorded as a diagnostic and the assumption stays in place.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  discoverGatewayContextWindow,
  findConfiguredCapability,
  toolCallingConfigurationFingerprint,
  type ContextWindowReport,
  type GatewayConfig,
  type GatewayContextWindowDiscovery,
} from "@oscharko-dev/keiko-model-gateway";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import { currentContextProfileForModel, currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { persistAdoptedContextWindow, type AdoptedContextWindowOutcome } from "./gateway-setup.js";
import { modelIdEvidence } from "./observability/model-id-evidence.js";
import { getServerLogger } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";
import { correlationIdOrUnknown } from "./correlation.js";

type ContextWindowSource = "provider-overflow" | "window-probe";

const CONTEXT_WINDOW_ADOPTION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.context-window.adoption",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-context-window.logAdoption",
  fields: {
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    source: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["provider-overflow", "window-probe"],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["adopted", "unchanged", "not-chat", "unconfigured"],
    },
    contextWindow: { type: "integer", dataClass: "count", required: true },
    previousContextWindow: { type: "integer", dataClass: "count", required: false },
    wasAssumed: { type: "boolean", dataClass: "closed-enum", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-context-window-adoption"],
  proofIds: ["gateway.context-window.adoption.line"],
  releaseImpact: "patch",
});

const CONTEXT_WINDOW_PROBE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.context-window.probe",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-context-window.logProbe",
  fields: {
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["reported", "not-reported", "failed", "skipped-spend-budget"],
    },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    contextWindow: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-context-window-adoption"],
  proofIds: ["gateway.context-window.probe.line"],
  releaseImpact: "patch",
});

const CONTEXT_WINDOW_RETRY = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.context-window.retry",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-context-window.logRetry",
  fields: {
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat-buffered", "chat-stream", "grounded"],
    },
    plannedContextWindow: { type: "integer", dataClass: "count", required: true },
    contextWindow: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-context-window-adoption"],
  proofIds: ["gateway.context-window.retry.line"],
  releaseImpact: "patch",
});

function logAdoption(
  modelId: string,
  contextWindow: number,
  source: ContextWindowSource,
  outcome: AdoptedContextWindowOutcome,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CONTEXT_WINDOW_ADOPTION,
      { correlationId },
      {
        ...modelIdEvidence(modelId),
        source,
        state: outcome.state,
        contextWindow,
        ...(outcome.state === "adopted"
          ? { previousContextWindow: outcome.previousContextWindow, wasAssumed: outcome.wasAssumed }
          : {}),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function logProbe(
  modelId: string,
  outcome: GatewayContextWindowDiscovery | { readonly status: "failed" | "skipped-spend-budget" },
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      CONTEXT_WINDOW_PROBE,
      { correlationId, ...(outcome.status === "failed" ? { errorKind: "unavailable" } : {}) },
      {
        ...modelIdEvidence(modelId),
        state: outcome.status,
        ...(outcome.status === "reported" ? { contextWindow: outcome.contextWindowTokens } : {}),
        ...(outcome.status === "not-reported" ? { httpStatus: outcome.httpStatus } : {}),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

/** Adopts a provider-stated window. Never throws: a persistence failure becomes a diagnostic. */
export function adoptReportedContextWindow(
  deps: UiHandlerDeps,
  report: ContextWindowReport,
  source: ContextWindowSource,
): void {
  try {
    const outcome = persistAdoptedContextWindow(
      deps,
      report.modelId,
      report.contextWindowTokens,
      report.correlationId,
    );
    logAdoption(report.modelId, report.contextWindowTokens, source, outcome, report.correlationId);
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: report.correlationId,
        operation: "gateway.context-window",
        source: "gateway-context-window.adopt",
        error,
        summary: "The provider-reported gateway context window could not be adopted.",
        redact: (message): string => String(deps.redactor(message)),
      }),
    );
  }
}

// One attempt per deployment identity per runtime configuration holder: a provider that states no
// window is asked again only after a restart or a changed deployment, never on every generation.
// Disposal aborts the in-flight probe and drains the queue before shutdown sealing.
interface ProbeState {
  readonly probed: Set<string>;
  readonly controller: AbortController;
  queue: Promise<void>;
  disposed: boolean;
}

const probeStates = new WeakMap<object, ProbeState>();

function probeState(deps: UiHandlerDeps): ProbeState | undefined {
  const holder = deps.gatewayConfig;
  if (holder === undefined) return undefined;
  let state = probeStates.get(holder);
  if (state === undefined) {
    state = {
      probed: new Set(),
      controller: new AbortController(),
      queue: Promise.resolve(),
      disposed: false,
    };
    probeStates.set(holder, state);
  }
  return state;
}

/** Resolves once every queued context-window probe of this holder has finished. Test seam. */
export function contextWindowProbesSettledForTests(deps: UiHandlerDeps): Promise<void> {
  return probeState(deps)?.queue ?? Promise.resolve();
}

/** Stops the holder's context-window probes; awaits the one in flight. */
export async function stopAssumedContextWindowDiscovery(deps: UiHandlerDeps): Promise<void> {
  const state = probeState(deps);
  if (state === undefined) return;
  state.disposed = true;
  state.controller.abort();
  await state.queue;
}

function deploymentKey(config: GatewayConfig, modelId: string): string | undefined {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  return provider === undefined ? undefined : toolCallingConfigurationFingerprint(provider);
}

async function probeContextWindow(
  deps: UiHandlerDeps,
  state: ProbeState,
  modelId: string,
  correlationId: string,
): Promise<void> {
  const config = currentGatewayConfig(deps);
  const provider = config?.providers.find((candidate) => candidate.modelId === modelId);
  if (state.disposed || config === undefined || provider === undefined) return;
  try {
    const outcome = await discoverGatewayContextWindow({
      config,
      provider,
      ...(deps.gatewayReadinessFetch === undefined
        ? {}
        : { fetchImpl: deps.gatewayReadinessFetch }),
      log: deps.activityLog ?? processServerLogSink(),
      correlationId,
      signal: state.controller.signal,
    });
    logProbe(modelId, outcome, correlationId);
    if (outcome.status === "reported") {
      const report = { modelId, contextWindowTokens: outcome.contextWindowTokens, correlationId };
      adoptReportedContextWindow(deps, report, "window-probe");
    }
  } catch (error) {
    logProbe(modelId, { status: "failed" }, correlationId);
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "gateway.context-window",
        source: "gateway-context-window.probe",
        error,
        summary: "The gateway context-window probe could not be completed.",
        redact: (message): string => String(deps.redactor(message)),
      }),
    );
  }
}

/**
 * Queues one background context-window probe for a chat model whose window is still assumed — once
 * per deployment identity per configuration holder, when a conversation first shows the model (the
 * context meter). Models nobody uses are never asked. Probes run one after another, so each reads
 * the configuration the previous adoption left behind. With a spend budget configured the probe is
 * skipped — its output allocation cannot be reserved — and the window is learned from the
 * provider's first overflow instead.
 */
export function discoverAssumedContextWindow(
  deps: UiHandlerDeps,
  modelId: string,
  correlationId: string,
): Promise<void> {
  const config = currentGatewayConfig(deps);
  const state = probeState(deps);
  if (config === undefined || state === undefined || state.disposed) return Promise.resolve();
  if (!windowAssumed(config, modelId)) return Promise.resolve();
  const key = deploymentKey(config, modelId);
  if (key === undefined || state.probed.has(key)) return state.queue;
  state.probed.add(key);
  if (deps.gatewayConfig?.spendBudget !== undefined) {
    logProbe(modelId, { status: "skipped-spend-budget" }, correlationId);
    return Promise.resolve();
  }
  state.queue = state.queue.then(() => probeContextWindow(deps, state, modelId, correlationId));
  return state.queue;
}

function windowAssumed(config: GatewayConfig, modelId: string): boolean {
  const capability = findConfiguredCapability(config, modelId);
  return capability?.kind === "chat" && capability.contextWindowAssumed === true;
}

export interface ContextWindowRetryInput {
  readonly modelId: string;
  readonly surface: "chat-buffered" | "chat-stream" | "grounded";
  readonly correlationId: string | undefined;
  /** False once the failed attempt already showed content, which a retry would repeat. */
  readonly retryable?: (() => boolean) | undefined;
}

function plannedContextWindow(deps: UiHandlerDeps, modelId: string): number | undefined {
  return currentContextProfileForModel(deps, modelId)?.maxInputTokens;
}

// A retry is justified only when the provider refused the attempt as an overflow, stated its
// window, and that window is now what Keiko plans with while the failed attempt was planned with a
// different one — a re-plan then produces a different, fitting request.
function adoptedWindowAfter(
  deps: UiHandlerDeps,
  input: ContextWindowRetryInput,
  planned: number | undefined,
  error: unknown,
): number | undefined {
  if (!(error instanceof ContextOverflowError) || input.retryable?.() === false) return undefined;
  const reported = error.reportedContextWindowTokens;
  if (reported === undefined || planned === reported) return undefined;
  return plannedContextWindow(deps, input.modelId) === reported ? reported : undefined;
}

/**
 * Runs one model attempt and, when the provider's overflow answer taught Keiko the deployment's
 * real window (adopted synchronously by the Gateway's report hook), re-plans and sends it exactly
 * once more. The attempt callback must assemble its prompt from the CURRENT context profile, so the
 * second run fits the adopted window. Any other failure — and a second overflow — propagates.
 */
export async function withAdoptedContextWindowRetry<T>(
  deps: UiHandlerDeps,
  input: ContextWindowRetryInput,
  attempt: () => Promise<T>,
): Promise<T> {
  const planned = plannedContextWindow(deps, input.modelId);
  try {
    return await attempt();
  } catch (error) {
    const adopted = adoptedWindowAfter(deps, input, planned, error);
    if (adopted === undefined || planned === undefined) throw error;
    logRetry(input, planned, adopted);
    return await attempt();
  }
}

function logRetry(input: ContextWindowRetryInput, planned: number, adopted: number): void {
  getServerLogger().info(
    activityLogEvent(
      CONTEXT_WINDOW_RETRY,
      { correlationId: correlationIdOrUnknown(input.correlationId) },
      {
        ...modelIdEvidence(input.modelId),
        surface: input.surface,
        plannedContextWindow: planned,
        contextWindow: adopted,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
