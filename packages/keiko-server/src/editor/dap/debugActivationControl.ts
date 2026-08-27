import type {
  DebugActivationSummary,
  DebugDeploymentPolicy,
  DebugProductSupport,
  DebugProvisioning,
  DebugWorkspaceActivation,
} from "@oscharko-dev/keiko-contracts";
import { DEBUG_ACTIVATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/debug-activation";

import type { WorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  debugActivationWorkspaceFingerprint,
  type DebugActivationEvidenceAction,
  type DebugActivationEvidence,
} from "./debugActivationEvidence.js";
import { createDebugCapabilityGate, type DebugCapabilityGate } from "./debugActivationPolicy.js";

const WATCHDOG_INTERVAL_MS = 1_000;
// Bounds how long a resolved-but-idle workspace is kept in `tracked`/watched by the per-second
// sweep. Idle means no external resolve()/synchronize() touch, not sweep activity itself -- the
// sweep must never refresh its own idle clock, or a permanently tracked workspace could never age
// out (issue #2347 audit finding: unbounded per-process watch list).
const DEFAULT_TRACKED_IDLE_TTL_MS = 30 * 60_000;

interface DebugActivationContext {
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

interface DebugActivationSweepFailure {
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
  readonly trackedIdleTtlMs?: number | undefined;
  readonly onSweepFailure?: ((failure: DebugActivationSweepFailure) => void) | undefined;
}

interface TrackedActivation {
  readonly context: DebugActivationContext & { readonly realRoot: string };
  readonly summary: DebugActivationSummary;
  readonly lastTouchedMs: number;
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
  const productSupport = options.productSupport(context.realRoot);
  const deploymentPolicy = options.deploymentPolicy(context.realRoot);
  const provisioningCanAffectDecision =
    productSupport === "supported" &&
    deploymentPolicy === "allowed" &&
    context.workspaceActivation === "enabled";
  return {
    schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
    adapterId: "node-typescript",
    revision: context.revision,
    productSupport,
    deploymentPolicy,
    // Provisioning may inspect a large, operator-pinned runtime closure. Preserve the ordered
    // fail-closed policy result while avoiding that trust-boundary traversal when an earlier gate
    // already makes `available` impossible. Every potentially allowed decision still revalidates it.
    provisioning: provisioningCanAffectDecision
      ? options.provisioning(context.realRoot)
      : "notProvisioned",
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

// Narrowing is a state transition away from "available", never a bare revision-counter mismatch.
// `context.revision` is the caller-supplied M7 snapshot revision, which for a workspace-scoped
// caller is the *combined* per-scope revision (bumped by every workspace-scoped setting, not only
// `debuggingEnabled`); comparing it here would revoke a live session on an unrelated settings edit
// (issue #2347 audit finding). Explicit user deactivation is handled by the caller-asserted action.
function revocationRequired(
  action: DebugActivationSynchronization["action"],
  changed: boolean,
  prior: DebugActivationSummary | undefined,
  next: DebugActivationSummary,
): boolean {
  if (action === "deactivate" && changed) return true;
  return prior?.state === "available" && next.state !== "available";
}

// KEIKO-0642: three different disciplines write the shared `tracked` map -- the mutex-protected
// synchronize/sweep path (async), the unlocked resolve() cache write (this function, sync), and
// the unlocked pruneIdleTracked eviction (also sync). resolve() must stay synchronous because
// addDebuggingProjection in editorSettingsControl.ts calls it from the synchronous portion of
// loadSnapshot; making it async is a breaking ripple across callers.
//
// trackResolution and pruneIdleTracked are fully synchronous, so Node's single-threaded event
// loop makes the read/set/delete sequence inside them atomic against any concurrent
// synchronizeTracked -- which does have `await`s (disposeActiveSession, writeEvidence) between
// reading `prior` and writing `next`. That gap does NOT make the map corrupt (JS map writes are
// always atomic), but it does mean a synchronous resolve() call landing inside the gap can publish
// a newer entry that synchronizeTracked's own final write would otherwise clobber with the stale
// `next` it captured before the gap (KEIKO-0642-r3). synchronizeTracked closes that race itself,
// by re-checking the map entry's identity immediately before its final commit -- see the comment
// there. Do not add a NEW unlocked writer here without the same before/after identity check.
// The debugActivationControl.test.ts's write-discipline pin locks in the synchronous-visibility
// contract this relies on, and its deferred-interleaving regression pins the anti-clobber guard.
function trackResolution(
  context: DebugActivationContext & { readonly realRoot: string },
  next: DebugActivationSummary,
  tracked: Map<string, TrackedActivation>,
  now: () => number,
): void {
  const prior = tracked.get(context.realRoot);
  const preservePrior = revocationRequired("settingsChange", false, prior?.summary, next);
  tracked.set(context.realRoot, {
    context,
    summary: preservePrior && prior !== undefined ? prior.summary : next,
    lastTouchedMs: now(),
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
  // The watchdog/subscription sweep runs every tick as `settingsChange` with `changed: false`
  // purely to re-check narrowing; when it does not revoke, nothing durable happened. Writing
  // evidence anyway collides on the `{fingerprint}-{revision}-{action}` evidence key with a real
  // user-initiated `deactivate` at the same revision and silently overwrites it a second later
  // (issue #2347 audit finding). Only an explicit user action or an actual revocation is evidenced.
  if (input.action === "settingsChange" && !revoked) return Promise.resolve();
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

// A sweep-driven call (`action: "settingsChange"`, exclusively originated by `sweepWorkspace`)
// must not refresh the idle clock itself -- otherwise a workspace nobody reads or mutates anymore
// would still count as "active" forever purely because the watchdog keeps visiting it, and the
// idle-eviction in `pruneIdleTracked` could never trigger (issue #2347 audit finding).
function nextTouchMs(
  input: DebugActivationSynchronization,
  tracked: Map<string, TrackedActivation>,
  realRoot: string,
  now: () => number,
): number {
  if (input.action === "settingsChange") return tracked.get(realRoot)?.lastTouchedMs ?? now();
  return now();
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
  // KEIKO-0642-r3: capture the exact entry object (not just its `.summary`) so the final commit
  // below can detect whether anyone else wrote -- or deleted -- this key while we were suspended
  // on the awaits. Map values are always fresh object literals on every write (trackResolution,
  // this function, never mutated in place), so reference identity is a reliable "nobody wrote
  // since I looked" check without threading a separate generation counter through every writer.
  const observedEntry = tracked.get(realRoot);
  const prior = observedEntry?.summary;
  const revoke = revocationRequired(input.action, input.changed, prior, next);
  if (revoke) await options.disposeActiveSession(realRoot);
  await writeEvidence(options, input, prior, next, revoke);
  const now = options.now ?? Date.now;
  // A synchronous resolve() (or another synchronizeTracked, or pruneIdleTracked's eviction) may
  // have replaced or removed this entry during the awaits above; `next` was computed from the
  // context this call started with and is stale relative to that later write. Committing here
  // would silently regress the cache to older information (the exact bug this guards against).
  // The caller of THIS synchronize() still gets its own outcome via the return value below --
  // only the shared cache write is skipped.
  if (tracked.get(realRoot) === observedEntry) {
    tracked.set(realRoot, {
      context: { ...input.context, realRoot },
      summary: next,
      lastTouchedMs: nextTouchMs(input, tracked, realRoot, now),
    });
  }
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

// Bounds the watchdog's per-tick and per-process cost to workspaces someone actually reads or
// mutates. A workspace that is never touched again (closed project, stale tab) ages out instead of
// being watched -- and having its evidence/provisioning re-derived every second -- for the
// remaining lifetime of the BFF process (issue #2347 audit finding).
//
// KEIKO-0642: this delete runs unlocked, alongside the mutex-protected synchronize/sweep writers.
// Safe today ONLY because it is fully synchronous (see the write-discipline note on
// trackResolution). Do not add `await` here without upgrading to the mutex-protected discipline.
function pruneIdleTracked(
  tracked: Map<string, TrackedActivation>,
  options: DebugActivationControlOptions,
): void {
  const now = options.now ?? Date.now;
  const idleTtlMs = options.trackedIdleTtlMs ?? DEFAULT_TRACKED_IDLE_TTL_MS;
  const cutoffMs = now() - idleTtlMs;
  for (const [realRoot, entry] of tracked) {
    if (entry.lastTouchedMs < cutoffMs) tracked.delete(realRoot);
  }
}

function scheduleSweep(
  source: DebugActivationSweepFailure["source"],
  tracked: Map<string, TrackedActivation>,
  pending: Set<string>,
  options: DebugActivationControlOptions,
  gate: DebugCapabilityGate,
): void {
  pruneIdleTracked(tracked, options);
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
        trackResolution(
          { ...context, realRoot: context.realRoot },
          summary,
          tracked,
          options.now ?? Date.now,
        );
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
