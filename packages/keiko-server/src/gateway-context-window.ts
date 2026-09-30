// Real context windows for models whose gateway declares none (customer report on 1.1.13).
//
// A LiteLLM `hosted_vllm` deployment — and any Azure deployment set up without discovery — reaches
// Keiko without a declared window, so its capability carries the 4,096 setup placeholder flagged
// `contextWindowAssumed`. Conversation budgeting plans such a model with the default geometry;
// this module replaces the assumption with the deployment's exact window from two provider
// statements:
//   1. the startup context-window probe (once per deployment identity per process, background);
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
  listConfiguredCapabilities,
  toolCallingConfigurationFingerprint,
  type ContextWindowReport,
  type GatewayConfig,
  type GatewayContextWindowDiscovery,
} from "@oscharko-dev/keiko-model-gateway";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { persistAdoptedContextWindow, type AdoptedContextWindowOutcome } from "./gateway-setup.js";
import { modelIdEvidence } from "./observability/model-id-evidence.js";
import { getServerLogger } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

type ContextWindowSource = "provider-overflow" | "startup-probe";

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
      values: ["provider-overflow", "startup-probe"],
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
  failureClasses: ["gateway-context-admission"],
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
  failureClasses: ["gateway-context-admission"],
  proofIds: ["gateway.context-window.probe.line"],
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

// One attempt per deployment identity per process: a provider that states no window is asked
// again only after a restart or a changed deployment, never on every configuration generation.
const probedDeployments = new Set<string>();
let probeQueue: Promise<void> = Promise.resolve();

export function resetContextWindowProbesForTests(): void {
  probedDeployments.clear();
  probeQueue = Promise.resolve();
}

/** Resolves once every queued context-window probe has finished. Test seam. */
export function contextWindowProbesSettledForTests(): Promise<void> {
  return probeQueue;
}

function assumedDeployments(config: GatewayConfig): readonly string[] {
  return listConfiguredCapabilities(config)
    .filter((capability) => capability.kind === "chat" && capability.contextWindowAssumed === true)
    .map((capability) => capability.id);
}

function deploymentKey(config: GatewayConfig, modelId: string): string | undefined {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  return provider === undefined ? undefined : toolCallingConfigurationFingerprint(provider);
}

async function probeContextWindow(
  deps: UiHandlerDeps,
  modelId: string,
  correlationId: string,
): Promise<void> {
  const config = currentGatewayConfig(deps);
  const provider = config?.providers.find((candidate) => candidate.modelId === modelId);
  if (config === undefined || provider === undefined) return;
  try {
    const outcome = await discoverGatewayContextWindow({
      config,
      provider,
      ...(deps.gatewayReadinessFetch === undefined ? {} : { fetchImpl: deps.gatewayReadinessFetch }),
      log: deps.activityLog ?? processServerLogSink(),
      correlationId,
    });
    logProbe(modelId, outcome, correlationId);
    if (outcome.status === "reported") {
      const report = { modelId, contextWindowTokens: outcome.contextWindowTokens, correlationId };
      adoptReportedContextWindow(deps, report, "startup-probe");
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
 * Queues one background context-window probe for every configured chat model whose window is still
 * assumed. Sequential on purpose: each adoption advances the configuration generation, and the next
 * probe must read the configuration the previous one left behind. With a spend budget configured
 * the probe is skipped — its output allocation cannot be reserved — and the window is learned from
 * the provider's first overflow instead.
 */
export function discoverAssumedContextWindows(deps: UiHandlerDeps, correlationId: string): void {
  const config = currentGatewayConfig(deps);
  if (config === undefined) return;
  for (const modelId of assumedDeployments(config)) {
    const key = deploymentKey(config, modelId);
    if (key === undefined || probedDeployments.has(key)) continue;
    probedDeployments.add(key);
    if (deps.gatewayConfig?.spendBudget !== undefined) {
      logProbe(modelId, { status: "skipped-spend-budget" }, correlationId);
      continue;
    }
    probeQueue = probeQueue.then(() => probeContextWindow(deps, modelId, correlationId));
  }
}
