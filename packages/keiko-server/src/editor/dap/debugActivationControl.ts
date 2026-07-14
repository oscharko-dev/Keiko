import {
  DEBUG_ACTIVATION_SCHEMA_VERSION,
  type DebugActivationSummary,
  type DebugDeploymentPolicy,
  type DebugProductSupport,
  type DebugProvisioning,
  type DebugWorkspaceActivation,
} from "@oscharko-dev/keiko-contracts";

import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  debugActivationWorkspaceFingerprint,
  type DebugActivationEvidenceAction,
  type DebugActivationEvidence,
} from "./debugActivationEvidence.js";
import { createDebugCapabilityGate, type DebugCapabilityGate } from "./debugActivationPolicy.js";

const WATCHDOG_INTERVAL_MS = 1_000;

export interface DebugActivationContext {
  readonly realRoot?: string | undefined;
  readonly revision: number;
  readonly workspaceActivation: DebugWorkspaceActivation;
}

export interface DebugActivationSynchronization {
  readonly action: "activate" | "deactivate" | "settingsChange";
  readonly changed: boolean;
  readonly context: DebugActivationContext;
}

export interface DebugActivationControlService {
  readonly resolve: (context: DebugActivationContext) => DebugActivationSummary;
  readonly isCurrent: (realRoot: string, expectedRevision: number) => boolean;
  readonly synchronize: (input: DebugActivationSynchronization) => Promise<DebugActivationSummary>;
  readonly dispose: () => void;
}

export interface DebugActivationSweepFailure {
  readonly schemaVersion: "1";
  readonly code: "ACTIVATION_SWEEP_FAILED";
  readonly source: "watchdog" | "subscription";
}

export interface DebugActivationControlOptions {
  readonly mutex: WorkspaceMutexRegistry;
  readonly productSupport: (realRoot: string | undefined) => DebugProductSupport;
  readonly deploymentPolicy: (realRoot: string | undefined) => DebugDeploymentPolicy;
  readonly provisioning: (realRoot: string) => DebugProvisioning;
  readonly disposeActiveSession: (realRoot: string) => Promise<void>;
  readonly projectEvidence?:
    ((fingerprint: string, evidence: DebugActivationEvidence) => Promise<void> | void) | undefined;
  readonly gate?: DebugCapabilityGate | undefined;
  readonly now?: (() => number) | undefined;
  readonly watchdogIntervalMs?: number | undefined;
  readonly onSweepFailure?: ((failure: DebugActivationSweepFailure) => void) | undefined;
}

interface TrackedActivation {
  readonly context: DebugActivationContext & { readonly realRoot: string };
  readonly summary: DebugActivationSummary;
}

function workspaceFingerprintKey(realRoot: string): string {
  return `debug-activation:${debugActivationWorkspaceFingerprint(realRoot)}`;
}

function unavailableSummary(revision: number): DebugActivationSummary {
  return {
    ok: true,
    schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
    adapterId: "node-typescript",
    revision,
    state: "disabledByPolicy",
    reasonCode: "POLICY_UNAVAILABLE",
    policyResult: "denied",
  };
}

function withoutWorkspaceSummary(revision: number): DebugActivationSummary {
  return {
    ok: true,
    schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
    adapterId: "node-typescript",
    revision,
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "allowed",
  };
}

function contextInput(
  context: DebugActivationContext & { readonly realRoot: string },
  options: DebugActivationControlOptions,
): Parameters<DebugCapabilityGate["resolve"]>[0] {
  return {
    schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
    adapterId: "node-typescript",
    revision: context.revision,
    productSupport: options.productSupport(context.realRoot),
    deploymentPolicy: options.deploymentPolicy(context.realRoot),
    provisioning: options.provisioning(context.realRoot),
    workspaceActivation: context.workspaceActivation,
  };
}

function summaryFor(
  context: DebugActivationContext,
  options: DebugActivationControlOptions,
  gate: DebugCapabilityGate,
): DebugActivationSummary {
  if (context.realRoot === undefined) return withoutWorkspaceSummary(context.revision);
  try {
    const resolution = gate.resolve(
      contextInput({ ...context, realRoot: context.realRoot }, options),
    );
    if (resolution.ok) return resolution;
  } catch {
    // Provider failures are an unavailable decision, never stale allow.
  }
  return unavailableSummary(context.revision);
}

function revocationRequired(
  action: DebugActivationSynchronization["action"],
  changed: boolean,
  prior: DebugActivationSummary | undefined,
  next: DebugActivationSummary,
): boolean {
  if (action === "deactivate" && changed) return true;
  return (
    prior?.state === "available" && (next.state !== "available" || prior.revision !== next.revision)
  );
}

function trackResolution(
  context: DebugActivationContext & { readonly realRoot: string },
  next: DebugActivationSummary,
  tracked: Map<string, TrackedActivation>,
): void {
  const prior = tracked.get(context.realRoot);
  const preservePrior = revocationRequired("settingsChange", false, prior?.summary, next);
  tracked.set(context.realRoot, {
    context,
    summary: preservePrior && prior !== undefined ? prior.summary : next,
  });
}

function evidenceAction(
  action: DebugActivationSynchronization["action"],
  revoke: boolean,
): DebugActivationEvidenceAction {
  if (revoke && action === "settingsChange") return "revoke";
  return action === "settingsChange" ? "deactivate" : action;
}

function evidenceOutcome(
  action: DebugActivationSynchronization["action"],
  changed: boolean,
  summary: DebugActivationSummary,
): "accepted" | "noOp" | "denied" {
  if (action === "activate" && summary.state !== "available") return "denied";
  return changed ? "accepted" : "noOp";
}

function writeEvidence(
  options: DebugActivationControlOptions,
  input: DebugActivationSynchronization,
  prior: DebugActivationSummary | undefined,
  next: DebugActivationSummary,
  revoked: boolean,
): Promise<void> {
  const realRoot = input.context.realRoot;
  if (realRoot === undefined) return Promise.resolve();
  const evidence = {
    schemaVersion: "1" as const,
    action: evidenceAction(input.action, revoked),
    outcome: evidenceOutcome(input.action, input.changed, next),
    priorState: prior?.state ?? "disabled",
    effectiveState: next.state,
    reasonCode: next.reasonCode,
    revision: next.revision,
    timestampMs: (options.now ?? Date.now)(),
    policyResult: next.policyResult,
  } satisfies DebugActivationEvidence;
  return Promise.resolve(
    options.projectEvidence?.(debugActivationWorkspaceFingerprint(realRoot), evidence),
  ).then(() => undefined);
}

async function synchronizeTracked(
  input: DebugActivationSynchronization,
  tracked: Map<string, TrackedActivation>,
  options: DebugActivationControlOptions,
  gate: DebugCapabilityGate,
): Promise<DebugActivationSummary> {
  const realRoot = input.context.realRoot;
  const next = summaryFor(input.context, options, gate);
  if (realRoot === undefined) return next;
  const prior = tracked.get(realRoot)?.summary;
  const revoke = revocationRequired(input.action, input.changed, prior, next);
  if (revoke) await options.disposeActiveSession(realRoot);
  await writeEvidence(options, input, prior, next, revoke);
  tracked.set(realRoot, { context: { ...input.context, realRoot }, summary: next });
  return next;
}

function sweepWorkspace(
  source: DebugActivationSweepFailure["source"],
  tracked: Map<string, TrackedActivation>,
  pending: Set<string>,
  options: DebugActivationControlOptions,
  gate: DebugCapabilityGate,
  context: DebugActivationContext & { readonly realRoot: string },
): void {
  if (pending.has(context.realRoot)) return;
  pending.add(context.realRoot);
  void options.mutex
    .runExclusive([workspaceFingerprintKey(context.realRoot)], () =>
      synchronizeTracked(
        { action: "settingsChange", changed: false, context },
        tracked,
        options,
        gate,
      ),
    )
    .catch(() => {
      try {
        options.onSweepFailure?.({
          schemaVersion: "1",
          code: "ACTIVATION_SWEEP_FAILED",
          source,
        });
      } catch {
        // Diagnostics must not turn an isolated sweep failure into another rejection.
      }
    })
    .finally(() => {
      pending.delete(context.realRoot);
    });
}

function scheduleSweep(
  source: DebugActivationSweepFailure["source"],
  tracked: Map<string, TrackedActivation>,
  pending: Set<string>,
  options: DebugActivationControlOptions,
  gate: DebugCapabilityGate,
): void {
  for (const { context } of tracked.values()) {
    sweepWorkspace(source, tracked, pending, options, gate, context);
  }
}

/**
 * Coordinates the derived capability gate. It never owns a second opt-in: settings compose the
 * `workspaceActivation` argument from canonical `debuggingEnabled` and call `synchronize` after
 * a successful mutation. The one-second server watchdog is defence in depth for provisioning
 * narrowing; a future policy provider can publish through the same gate subscription.
 */
export function createDebugActivationControlService(
  options: DebugActivationControlOptions,
): DebugActivationControlService {
  const gate = options.gate ?? createDebugCapabilityGate();
  const tracked = new Map<string, TrackedActivation>();
  const pending = new Set<string>();
  const timer = setInterval(() => {
    scheduleSweep("watchdog", tracked, pending, options, gate);
  }, options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS);
  timer.unref();
  const unsubscribe = gate.subscribe(() => {
    scheduleSweep("subscription", tracked, pending, options, gate);
  });
  return {
    resolve: (context): DebugActivationSummary => {
      const summary = summaryFor(context, options, gate);
      if (context.realRoot !== undefined) {
        trackResolution({ ...context, realRoot: context.realRoot }, summary, tracked);
      }
      return summary;
    },
    isCurrent: (realRoot, expectedRevision): boolean => {
      const current = tracked.get(realRoot)?.context;
      if (current?.revision !== expectedRevision) return false;
      const summary = summaryFor(current, options, gate);
      return summary.state === "available" && summary.revision === expectedRevision;
    },
    synchronize: (input): Promise<DebugActivationSummary> => {
      const realRoot = input.context.realRoot;
      if (realRoot === undefined) return Promise.resolve(summaryFor(input.context, options, gate));
      return options.mutex.runExclusive([workspaceFingerprintKey(realRoot)], () =>
        synchronizeTracked(input, tracked, options, gate),
      );
    },
    dispose: (): void => {
      clearInterval(timer);
      unsubscribe();
    },
  };
}
