import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import type { DraftDeliveryDependencies } from "../gitDelivery/draftDeliveryTypes.js";
import type {
  VerifiedCommitRuntimeBinding,
  VerifiedCommitRuntimeDependencies,
} from "./productionVerifiedCommitRuntime.js";
import { resolveDraftDeliveryContext } from "./productionDraftDeliveryRuntime.js";
import {
  CodingRuntimeCiRepairController,
  type CiRepairExecutionBudget,
  type CiRepairExecutionLease,
} from "./codingRuntimeCiRepairController.js";
import type { CiRepairBudgetContext } from "./codingRuntimeCiRepairBudgetTypes.js";

export function createProductionCiRepairBudget(
  deps: DraftDeliveryDependencies | undefined,
  verified: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
  // #3401 (epic #3384 closeout, description-composition-closeout): forwarded to the controller so
  // a repaired head that reaches `technical-ready` well after the orchestrator's one-time terminal
  // dispatch already fired regenerates the run's automatic description. Absent is a deliberate
  // closed default -- accounting proceeds exactly as before when no caller wires a notifier.
  notifyVerifiedHeadAdvanced?: (runId: string) => void,
): CiRepairExecutionBudget | undefined {
  const readiness = deps?.snapshots.ciReadiness;
  const store = deps?.snapshots.ciRepairBudget;
  if (
    deps === undefined ||
    verified === undefined ||
    readiness === undefined ||
    store === undefined
  )
    return unavailableBudget(deps, verified, binding);
  const controller = new CodingRuntimeCiRepairController({
    store,
    readiness,
    now: deps.execution?.now ?? Date.now,
    context: (): CiRepairBudgetContext | undefined => budgetContext(deps, verified, binding),
    ...(notifyVerifiedHeadAdvanced === undefined ? {} : { notifyVerifiedHeadAdvanced }),
  });
  return gateBudget(
    controller,
    availabilityGuard({
      deps,
      verified,
      binding,
      allowConfirmed: true,
      reason: "invalid-binding",
    }),
  );
}
function budgetContext(
  deps: DraftDeliveryDependencies,
  verified: VerifiedCommitRuntimeDependencies,
  binding: VerifiedCommitRuntimeBinding,
): CiRepairBudgetContext | undefined {
  const draft = deps.snapshots.get(binding.runId)?.draftDelivery;
  if (draft?.pullRequest === undefined) return undefined;
  const budget = binding.context.budget;
  return {
    runId: binding.runId,
    correlationId: binding.runId,
    remoteDigest: draft.binding.remoteDigest,
    prNumber: draft.pullRequest.number,
    limits: {
      maxRuntimeMs: budget.maxRuntimeMs,
      maxToolCalls: budget.maxToolCalls,
      maxPromptTokens: budget.maxPromptTokens,
    },
    stillAuthorized: (): boolean =>
      binding.stillAuthorized() &&
      !binding.signal.aborted &&
      resolveDraftDeliveryContext(verified, binding) !== undefined,
  };
}

const LIVE_STATES: ReadonlySet<CodingRuntimeSnapshot["state"]> = new Set([
  "ready",
  "running",
  "awaiting-approval",
]);
function unavailableBudget(
  deps: DraftDeliveryDependencies | undefined,
  verified: VerifiedCommitRuntimeDependencies | undefined,
  binding: VerifiedCommitRuntimeBinding,
): CiRepairExecutionBudget {
  const allowed = availabilityGuard({
    deps,
    verified,
    binding,
    allowConfirmed: false,
    reason: "storage-unavailable",
  });
  return {
    admitTool: () => (allowed() ? { check: allowed, settle: () => undefined } : undefined),
    chargePrompt: allowed,
    chargeDelegatedRead: allowed,
    observed: () => undefined,
  };
}
interface AvailabilityInput {
  readonly deps: DraftDeliveryDependencies | undefined;
  readonly verified: VerifiedCommitRuntimeDependencies | undefined;
  readonly binding: VerifiedCommitRuntimeBinding;
  readonly allowConfirmed: boolean;
  readonly reason: "invalid-binding" | "storage-unavailable";
}
function availabilityGuard(input: AvailabilityInput): () => boolean {
  const { deps, verified, binding } = input;
  const snapshots = deps?.snapshots ?? verified?.snapshots;
  const log =
    deps?.execution?.activityLog ?? verified?.execution?.activityLog ?? processServerLogSink();
  return (): boolean => {
    let error: unknown;
    try {
      if (
        binding.stillAuthorized() &&
        !binding.signal.aborted &&
        knownScope(snapshots, binding, input.allowConfirmed)
      )
        return true;
    } catch (errorValue) {
      error = errorValue;
    }
    log.write({
      category: "process",
      op: "git.ci-repair.budget",
      correlationId: binding.runId,
      ...(error === undefined ? {} : { level: "warn" as const, errorKind: "internal" as const }),
      extra: {
        phase: "availability",
        state: "blocked",
        reason: input.reason,
        runId: binding.runId,
        ...(error === undefined ? {} : describeError(error)),
      },
    });
    return false;
  };
}
function gateBudget(
  budget: CiRepairExecutionBudget,
  allowed: () => boolean,
): CiRepairExecutionBudget {
  return {
    admitTool: (request): CiRepairExecutionLease | undefined => {
      if (!allowed()) return undefined;
      const lease = budget.admitTool(request);
      return lease === undefined
        ? undefined
        : { ...lease, check: () => allowed() && lease.check() };
    },
    chargePrompt: (tokens) => allowed() && budget.chargePrompt(tokens),
    chargeDelegatedRead: (id, key) => allowed() && budget.chargeDelegatedRead?.(id, key) === true,
    observed: (snapshot): void => {
      if (allowed()) budget.observed(snapshot);
    },
  };
}
function knownScope(
  snapshots: Pick<CodingRuntimeSnapshotStore, "get"> | undefined,
  binding: VerifiedCommitRuntimeBinding,
  allowConfirmed: boolean,
): boolean {
  if (snapshots === undefined) return binding.context.issueBinding === undefined;
  const current = snapshots.get(binding.runId);
  if (!liveScope(current, binding)) return false;
  return (
    (allowConfirmed && current.draftDelivery?.pullRequest !== undefined) ||
    prePrLineage(snapshots, current)
  );
}
function liveScope(
  current: CodingRuntimeSnapshot | undefined,
  binding: VerifiedCommitRuntimeBinding,
): current is CodingRuntimeSnapshot {
  return (
    current?.runId === binding.runId &&
    LIVE_STATES.has(current.state) &&
    current.terminalAt === undefined &&
    current.issueBinding?.bindingDigest === binding.context.issueBinding?.bindingDigest
  );
}
function prePrLineage(
  snapshots: Pick<CodingRuntimeSnapshotStore, "get">,
  initial: CodingRuntimeSnapshot,
): boolean {
  let current: CodingRuntimeSnapshot | undefined = initial;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (current === undefined || visited.has(current.runId)) return false;
    if (!samePrePrIntent(initial, current) || current.draftDelivery?.pullRequest !== undefined)
      return false;
    visited.add(current.runId);
    if (current.predecessorRunId === undefined) return true;
    current = snapshots.get(current.predecessorRunId);
  }
  return false;
}
function samePrePrIntent(initial: CodingRuntimeSnapshot, current: CodingRuntimeSnapshot): boolean {
  return (
    current.taskDigest === initial.taskDigest &&
    current.workspaceDigest === initial.workspaceDigest &&
    current.issueBinding?.bindingDigest === initial.issueBinding?.bindingDigest
  );
}
