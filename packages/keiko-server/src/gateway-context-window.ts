// Real context windows for models whose gateway declares none (customer report on 1.1.13).
//
// A LiteLLM `hosted_vllm` deployment — and any Azure deployment set up without discovery — reaches
// Keiko without a declared window, so its capability carries the 4,096 setup placeholder flagged
// `contextWindowAssumed`. Conversation budgeting plans such a model with the default geometry;
// this module replaces the assumption with the deployment's exact window from two provider
// statements:
//   1. a context-window probe when a conversation first shows the model (once per deployment and
//      configuration generation);
//   2. every provider overflow answer that names the window (the Gateway's report hook).
// Both persist through gateway-setup and apply as a configuration refinement without a generation
// bump, so every surface re-plans the model. A statement is adopted only for the deployment and
// generation that made it. Nothing here throws into a caller: an adoption or probe failure is
// recorded as a diagnostic and the assumption stays in place; a window that could not be written to
// the configuration file still applies in memory.

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
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import { persistAdoptedContextWindow, type AdoptedContextWindowOutcome } from "./gateway-setup.js";
import { modelIdEvidence } from "./observability/model-id-evidence.js";
import { getServerLogger, reportServerLogFailure } from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";
import { correlationIdOrUnknown, newCorrelationId } from "./correlation.js";

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
      values: ["adopted", "unchanged", "not-chat", "unconfigured", "stale-deployment"],
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
  // A probe is a background job spawned by the conversation read that first showed the model.
  causal: "parent-correlation",
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

// The correlation of one background probe: its own id, joined to the read that spawned it.
interface ProbeCorrelation {
  readonly correlationId: string;
  readonly parentCorrelationId: string;
}

function logAdoption(
  modelId: string,
  contextWindow: number,
  source: ContextWindowSource,
  outcome: AdoptedContextWindowOutcome | { readonly state: "stale-deployment" },
  correlation: { readonly correlationId: string; readonly parentCorrelationId?: string },
): void {
  getServerLogger().info(
    activityLogEvent(CONTEXT_WINDOW_ADOPTION, correlation, {
      ...modelIdEvidence(modelId),
      source,
      state: outcome.state,
      contextWindow,
      ...(outcome.state === "adopted"
        ? { previousContextWindow: outcome.previousContextWindow, wasAssumed: outcome.wasAssumed }
        : {}),
      completeness: "complete",
      loss: "none",
    }),
  );
}

function logProbe(
  modelId: string,
  outcome: GatewayContextWindowDiscovery | { readonly status: "failed" | "skipped-spend-budget" },
  probe: ProbeCorrelation,
): void {
  getServerLogger().info(
    activityLogEvent(
      CONTEXT_WINDOW_PROBE,
      { ...probe, ...(outcome.status === "failed" ? { errorKind: "unavailable" } : {}) },
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

// Evidence is never control flow: a failure to write a line is reported on the independent channel
// and the work it describes carries on — an adoption, a retry, the probe queue.
function recordSafely(op: string, correlationId: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    reportServerLogFailure(error, { op, correlationId, loss: "event-dropped" });
  }
}

// One failure of this module's work, recorded body-free on the diagnostic port.
function emitContextWindowDiagnostic(
  deps: UiHandlerDeps,
  correlation: { readonly correlationId: string; readonly parentCorrelationId?: string },
  failure: {
    readonly source: string;
    readonly error: unknown;
    readonly summary: ServerDiagnosticSummary;
  },
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      ...correlation,
      operation: "gateway.context-window",
      ...failure,
      redact: (message): string => String(deps.redactor(message)),
    }),
  );
}

/**
 * Adopts a provider-stated window. Never throws: a failure becomes a diagnostic. A window that was
 * applied but could not be written to the configuration file is still logged as adopted; the write
 * failure is reported by the adoption itself.
 */
export function adoptReportedContextWindow(
  deps: UiHandlerDeps,
  report: ContextWindowReport,
  source: ContextWindowSource,
  parentCorrelationId?: string,
): void {
  const correlation = {
    correlationId: report.correlationId,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
  };
  try {
    const outcome = reportFromCurrentDeployment(deps, report)
      ? persistAdoptedContextWindow(
          deps,
          report.modelId,
          report.contextWindowTokens,
          report.correlationId,
        )
      : { state: "stale-deployment" as const };
    recordSafely(CONTEXT_WINDOW_ADOPTION.op, report.correlationId, () => {
      logAdoption(report.modelId, report.contextWindowTokens, source, outcome, correlation);
    });
  } catch (error) {
    emitContextWindowDiagnostic(deps, correlation, {
      source: "gateway-context-window.adopt",
      error,
      summary: "The provider-reported gateway context window could not be adopted.",
    });
  }
}

// A report is adopted only while the configuration still routes the model to the deployment that
// stated it. A probe or call started before setup replaced the endpoint must never write its late
// answer onto the replacement (PR #3678 review).
function reportFromCurrentDeployment(deps: UiHandlerDeps, report: ContextWindowReport): boolean {
  const { configurationGeneration, deploymentFingerprint } = report;
  // A setup that replaced only the credentials keeps endpoint and alias, and so the fingerprint,
  // but advances the generation.
  if (
    configurationGeneration !== undefined &&
    configurationGeneration !== deps.gatewayConfig?.generation()
  ) {
    return false;
  }
  if (deploymentFingerprint === undefined) return true;
  const config = currentGatewayConfig(deps);
  return config !== undefined && deploymentKey(config, report.modelId) === deploymentFingerprint;
}

// One answered attempt per deployment identity and configuration generation per runtime
// configuration holder: a provider that states no window is asked again only after a restart or a
// setup that replaced its routing (a new generation), never on every reading. Adoption itself is a
// refinement and does not advance the generation. An attempt that got no answer at all — the
// gateway was unreachable — says nothing about the deployment, so it is asked again after a
// cooldown, a bounded number of times.
// Disposal aborts the in-flight probe and drains the queue before shutdown sealing.
const FAILED_PROBE_COOLDOWN_MS = 30_000;
const MAX_PROBE_ATTEMPTS = 3;

interface FailedProbes {
  readonly at: number;
  readonly count: number;
}

interface ProbeState {
  readonly probed: Set<string>;
  /**
   * Probe identities queued or running, each with its own completion: the meter reads again while
   * its model's is here, and a reading waits for that probe alone, never for the whole queue.
   */
  readonly inFlight: Map<string, Promise<void>>;
  readonly failed: Map<string, FailedProbes>;
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
      inFlight: new Map(),
      failed: new Map(),
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

// The failure of one probe: the diagnostic first (it never throws), then the probe line. A probe the
// shutdown aborted is not a defect of the gateway and leaves no trace.
function recordProbeFailure(
  deps: UiHandlerDeps,
  state: ProbeState,
  key: string,
  modelId: string,
  probe: ProbeCorrelation,
  error: unknown,
): void {
  if (state.disposed) return;
  state.failed.set(key, { at: Date.now(), count: (state.failed.get(key)?.count ?? 0) + 1 });
  emitContextWindowDiagnostic(deps, probe, {
    source: "gateway-context-window.probe",
    error,
    summary: "The gateway context-window probe could not be completed.",
  });
  recordSafely(CONTEXT_WINDOW_PROBE.op, probe.correlationId, () => {
    logProbe(modelId, { status: "failed" }, probe);
  });
}

async function probeContextWindow(
  deps: UiHandlerDeps,
  state: ProbeState,
  key: string,
  modelId: string,
  probe: ProbeCorrelation,
): Promise<void> {
  const config = currentGatewayConfig(deps);
  const configurationGeneration = deps.gatewayConfig?.generation();
  const provider = config?.providers.find((candidate) => candidate.modelId === modelId);
  if (state.disposed || config === undefined || provider === undefined) return;
  let outcome: GatewayContextWindowDiscovery;
  try {
    outcome = await discoverGatewayContextWindow({
      config,
      provider,
      ...(deps.gatewayReadinessFetch === undefined
        ? {}
        : { fetchImpl: deps.gatewayReadinessFetch }),
      log: deps.activityLog ?? processServerLogSink(),
      correlationId: probe.correlationId,
      signal: state.controller.signal,
    });
  } catch (error) {
    recordProbeFailure(deps, state, key, modelId, probe, error);
    return;
  }
  state.failed.delete(key);
  recordSafely(CONTEXT_WINDOW_PROBE.op, probe.correlationId, () => {
    logProbe(modelId, outcome, probe);
  });
  if (outcome.status === "reported") {
    const report = {
      modelId,
      contextWindowTokens: outcome.contextWindowTokens,
      correlationId: probe.correlationId,
      deploymentFingerprint: toolCallingConfigurationFingerprint(provider),
      configurationGeneration,
    };
    adoptReportedContextWindow(deps, report, "window-probe", probe.parentCorrelationId);
  }
}

// One step of the shared queue. It never rejects: a link that rejected would skip every later
// probe for good and surface as an unhandled rejection at each reading that dropped its promise. A
// failure that reaches this catch is a logging failure of the probe's own line, reported on the
// independent channel.
async function runProbeStep(
  deps: UiHandlerDeps,
  state: ProbeState,
  key: string,
  modelId: string,
  probe: ProbeCorrelation,
): Promise<void> {
  try {
    await probeContextWindow(deps, state, key, modelId, probe);
  } catch (error) {
    reportServerLogFailure(error, {
      op: CONTEXT_WINDOW_PROBE.op,
      correlationId: probe.correlationId,
      loss: "event-dropped",
    });
  } finally {
    state.inFlight.delete(key);
  }
}

// A failed identity is asked again once its cooldown has passed, at most MAX_PROBE_ATTEMPTS times.
// A clock that moved backwards fails toward asking.
function failedProbeDue(state: ProbeState, key: string): boolean {
  const failed = state.failed.get(key);
  if (failed === undefined || failed.count >= MAX_PROBE_ATTEMPTS) return false;
  const elapsedMs = Date.now() - failed.at;
  return elapsedMs < 0 || elapsedMs >= FAILED_PROBE_COOLDOWN_MS;
}

/**
 * Queues one background context-window probe for a chat model whose window is still assumed — once
 * per deployment identity per configuration holder, when a conversation first shows the model (the
 * context meter). Models nobody uses are never asked. Probes run one after another, so each reads
 * the configuration the previous adoption left behind. With a spend budget configured the probe is
 * skipped — its output allocation cannot be reserved — and the window is learned from the
 * provider's first overflow instead. The returned promise settles with THIS model's probe (already
 * settled when none is running for it), never with the probes of other models.
 */
export function discoverAssumedContextWindow(
  deps: UiHandlerDeps,
  modelId: string,
  correlationId: string,
): Promise<void> {
  const config = currentGatewayConfig(deps);
  const state = probeState(deps);
  if (config === undefined || state === undefined || state.disposed) return Promise.resolve();
  const key = windowAssumed(config, modelId) ? probeKey(deps, config, modelId) : undefined;
  if (key === undefined) return Promise.resolve();
  const running = state.inFlight.get(key);
  if (running !== undefined) return running;
  if (state.probed.has(key) && !failedProbeDue(state, key)) return Promise.resolve();
  return startProbe(deps, state, key, modelId, correlationId);
}

function startProbe(
  deps: UiHandlerDeps,
  state: ProbeState,
  key: string,
  modelId: string,
  correlationId: string,
): Promise<void> {
  state.probed.add(key);
  // Each probe is its own background operation, joined to the read that spawned it.
  const probe = { correlationId: newCorrelationId(), parentCorrelationId: correlationId };
  if (deps.gatewayConfig?.spendBudget !== undefined) {
    recordSafely(CONTEXT_WINDOW_PROBE.op, probe.correlationId, () => {
      logProbe(modelId, { status: "skipped-spend-budget" }, probe);
    });
    return Promise.resolve();
  }
  const step = state.queue.then(() => runProbeStep(deps, state, key, modelId, probe));
  state.queue = step;
  state.inFlight.set(key, step);
  return step;
}

// The generation is part of the identity: a setup that replaced only the credentials behind the
// same endpoint and alias is a different routing and is asked again.
function probeKey(deps: UiHandlerDeps, config: GatewayConfig, modelId: string): string | undefined {
  const deployment = deploymentKey(config, modelId);
  return deployment === undefined
    ? undefined
    : `${String(deps.gatewayConfig?.generation())}:${deployment}`;
}

/**
 * True while a window probe for the model's current deployment and generation is queued or
 * running. A reading answered meanwhile tells the meter to read again (`contextWindowProbePending`),
 * for an assumed window as for the re-check of a provider-reported one.
 */
export function contextWindowProbeInFlight(deps: UiHandlerDeps, modelId: string): boolean {
  const holder = deps.gatewayConfig;
  const config = currentGatewayConfig(deps);
  const state = holder === undefined ? undefined : probeStates.get(holder);
  if (config === undefined || state === undefined) return false;
  const key = probeKey(deps, config, modelId);
  return key !== undefined && state.inFlight.has(key);
}

// An assumed window is asked for; a provider-reported one is asked again once per process, so a
// deployment redeployed with a larger window is noticed. A declared window is never probed.
function windowAssumed(config: GatewayConfig, modelId: string): boolean {
  const capability = findConfiguredCapability(config, modelId);
  return (
    capability?.kind === "chat" &&
    (capability.contextWindowAssumed === true || capability.contextWindowReported === true)
  );
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
/** What an attempt knows about the retry around it. */
export interface ContextWindowAttempt {
  /** True on the single retry after an adoption. */
  readonly retrying: boolean;
  /**
   * Whether a failure of this attempt will be retried on the adopted window. A failure handler
   * inside the attempt then leaves the admitted turn open for the retry instead of settling it
   * (PR #3678 review: a settled turn cannot take the retried answer).
   */
  readonly retryFollows: (error: unknown) => boolean;
}

export async function withAdoptedContextWindowRetry<T>(
  deps: UiHandlerDeps,
  input: ContextWindowRetryInput,
  attempt: (context: ContextWindowAttempt) => Promise<T>,
): Promise<T> {
  const planned = plannedContextWindow(deps, input.modelId);
  const retryFollows = (error: unknown): boolean =>
    planned !== undefined && adoptedWindowAfter(deps, input, planned, error) !== undefined;
  try {
    return await attempt({ retrying: false, retryFollows });
  } catch (error) {
    const adopted = adoptedWindowAfter(deps, input, planned, error);
    if (adopted === undefined || planned === undefined) throw error;
    recordSafely(CONTEXT_WINDOW_RETRY.op, correlationIdOrUnknown(input.correlationId), () => {
      logRetry(input, planned, adopted);
    });
    return await attempt({ retrying: true, retryFollows: () => false });
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
