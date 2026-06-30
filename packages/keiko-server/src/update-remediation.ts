import type {
  UpdateRemediationAction,
  UpdateRemediationActionRequest,
  UpdateRemediationAffectedFeature,
  UpdateRemediationOverallStatus,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
  UpdateRemediationStatus as RuntimeRemediationStatus,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_REMEDIATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { LocalKnowledgeRemediationPort } from "./local-knowledge-remediation.js";
import {
  FEATURE_LABELS,
  draftsForImpact,
  restartDraft,
  type ActionDraft,
} from "./update-remediation-drafts.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";

export interface UpdateRemediationManager {
  readonly getStatus: (request?: UpdateRemediationStatusRequest) => UpdateRemediationStatusReport;
  readonly runAction: (
    request: UpdateRemediationActionRequest,
  ) => Promise<UpdateRemediationStatusReport>;
  readonly completeRestart: (targetVersion?: string) => UpdateRemediationStatusReport;
  readonly updateCanComplete: (targetVersion?: string) => boolean;
}

export interface UpdateRemediationManagerOptions {
  readonly localState: UpdateLocalStateManager;
  readonly localKnowledge?: LocalKnowledgeRemediationPort | undefined;
  readonly now?: (() => number) | undefined;
}

export class UpdateRemediationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UpdateRemediationError";
  }
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function statusRank(status: UpdateRemediationOverallStatus): number {
  return {
    "not-required": 0,
    completed: 1,
    pending: 2,
    running: 3,
    "manual-review-required": 4,
    failed: 5,
  }[status];
}

function persistedStatus(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): RuntimeRemediationStatus | undefined {
  return manager
    .readRuntimeState()
    .remediations.find(
      (item) => item.store === draft.store && item.remediation === draft.remediation,
    )?.status;
}

function actionStatus(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): UpdateRemediationAction["status"] {
  if (!draft.required) return "not-needed";
  if (draft.kind === "manual-review") return "manual-review-required";
  const status = persistedStatus(manager, draft);
  if (status === "running") return "pending";
  if (status !== undefined) return status;
  return "pending";
}

function materializeAction(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): UpdateRemediationAction {
  const state = manager.readRuntimeState();
  const persisted = state.remediations.find(
    (item) => item.store === draft.store && item.remediation === draft.remediation,
  );
  return {
    ...draft,
    status: actionStatus(manager, draft),
    ...(persisted?.updatedAt === undefined ? {} : { updatedAt: persisted.updatedAt }),
    ...(persisted?.warningCode === undefined ? {} : { failure: persisted.warningCode }),
  };
}

function overallStatus(
  actions: readonly UpdateRemediationAction[],
): UpdateRemediationOverallStatus {
  if (actions.length === 0 || actions.every((item) => item.status === "not-needed")) {
    return "not-required";
  }
  const mapped = actions.map<UpdateRemediationOverallStatus>((action) => {
    if (action.status === "failed") return "failed";
    if (action.status === "manual-review-required") return "manual-review-required";
    if (action.status === "running") return "running";
    if (action.status === "pending") return "pending";
    return "completed";
  });
  return mapped.reduce((worst, item) => (statusRank(item) > statusRank(worst) ? item : worst));
}

function completeOrDeferred(action: UpdateRemediationAction): boolean {
  return (
    action.status === "completed" || action.status === "deferred" || action.status === "not-needed"
  );
}

function featureStateFor(
  action: UpdateRemediationAction,
): UpdateRemediationAffectedFeature["state"] {
  if (action.status === "completed" || action.status === "not-needed") return "ready";
  if (action.status === "deferred") return "degraded";
  if (action.status === "manual-review-required") return "manual-review-required";
  return "unavailable";
}

function affectedFeatures(
  actions: readonly UpdateRemediationAction[],
): readonly UpdateRemediationAffectedFeature[] {
  const byFeature = new Map<string, UpdateRemediationAction[]>();
  for (const action of actions) {
    for (const featureId of action.featureIds) {
      byFeature.set(featureId, [...(byFeature.get(featureId) ?? []), action]);
    }
  }
  return [...byFeature.entries()].map(([featureId, entries]) => {
    const state = entries
      .map(featureStateFor)
      .reduce<UpdateRemediationAffectedFeature["state"]>((worst, state) => {
        const rank = { ready: 0, degraded: 1, unavailable: 2, "manual-review-required": 3 };
        return rank[state] > rank[worst] ? state : worst;
      }, "ready");
    return {
      featureId,
      label: FEATURE_LABELS[entries[0]?.store ?? "server-runtime"],
      state,
      reason: entries.map((entry) => entry.message).join(" "),
      actionIds: entries.map((entry) => entry.actionId),
    };
  });
}

function warningsFromActions(actions: readonly UpdateRemediationAction[]): readonly string[] {
  return actions
    .map((action): string | undefined => {
      const failure = action.failure;
      return failure === undefined ? undefined : `${action.actionId}: ${failure}`;
    })
    .filter((warning): warning is string => warning !== undefined);
}

function upsertRuntimeAction(input: {
  readonly localState: UpdateLocalStateManager;
  readonly targetVersion?: string | undefined;
  readonly draft: ActionDraft;
  readonly status: RuntimeRemediationStatus;
  readonly warningCode?: "manual-review-required" | undefined;
}): void {
  const current = input.localState.readRuntimeState();
  const next = current.remediations.filter(
    (item) => !(item.store === input.draft.store && item.remediation === input.draft.remediation),
  );
  input.localState.writeRuntimeState({
    ...current,
    ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
    remediations: [
      ...next,
      {
        store: input.draft.store,
        remediation: input.draft.remediation,
        status: input.status,
        updatedAt: new Date().toISOString(),
        ...(input.warningCode === undefined ? {} : { warningCode: input.warningCode }),
      },
    ],
  });
}

function persistPending(
  localState: UpdateLocalStateManager,
  targetVersion: string | undefined,
  drafts: readonly ActionDraft[],
): void {
  for (const draft of drafts) {
    if (persistedStatus(localState, draft) !== undefined || !draft.required) continue;
    if (draft.kind === "manual-review") {
      upsertRuntimeAction({
        localState,
        targetVersion,
        draft,
        status: "failed",
        warningCode: "manual-review-required",
      });
      continue;
    }
    upsertRuntimeAction({ localState, targetVersion, draft, status: "pending" });
  }
}

function statusFor(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationStatusRequest = {},
): UpdateRemediationStatusReport {
  const drafts = draftsForImpact(options.localState, request.impact, options.localKnowledge);
  if (request.persist === true) {
    persistPending(options.localState, request.targetVersion, drafts);
  }
  const actions = drafts.map((draft) => materializeAction(options.localState, draft));
  return {
    schemaVersion: UPDATE_REMEDIATION_SCHEMA_VERSION,
    checkedAt: nowIso(now),
    ...(request.targetVersion === undefined ? {} : { targetVersion: request.targetVersion }),
    overallStatus: overallStatus(actions),
    updateCanComplete: actions.every(completeOrDeferred),
    actions,
    affectedFeatures: affectedFeatures(actions),
    warnings: warningsFromActions(actions),
  };
}

async function executeDraft(
  options: UpdateRemediationManagerOptions,
  draft: ActionDraft,
): Promise<RuntimeRemediationStatus> {
  if (draft.kind === "local-state-repair") {
    return options.localState.repairStores([draft.store]).status === "completed"
      ? "completed"
      : "failed";
  }
  if (draft.kind === "local-knowledge-reindex") {
    const result = await options.localKnowledge?.reindexAll();
    return result?.status === "completed" ? "completed" : "failed";
  }
  return "failed";
}

function findDraftOrThrow(drafts: readonly ActionDraft[], actionIdValue: string): ActionDraft {
  const draft = drafts.find((item) => item.actionId === actionIdValue);
  if (draft !== undefined) return draft;
  throw new UpdateRemediationError(
    "UPDATE_REMEDIATION_NOT_FOUND",
    "Remediation action was not found.",
    404,
  );
}

function recordRemediationAudit(
  options: UpdateRemediationManagerOptions,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  status: RuntimeRemediationStatus,
): void {
  options.localState.recordAuditEvent(
    status === "deferred"
      ? "remediation-deferred"
      : status === "completed"
        ? "remediation-completed"
        : "remediation-failed",
    {
      targetVersion: request.targetVersion,
      store: draft.store,
      remediation: draft.remediation,
      status,
      ...(status === "failed" ? { warningCode: "manual-review-required" } : {}),
    },
  );
}

function deferDraft(
  options: UpdateRemediationManagerOptions,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
): void {
  if (!draft.canDefer) {
    throw new UpdateRemediationError(
      "UPDATE_REMEDIATION_NOT_DEFERABLE",
      "This remediation cannot be safely deferred.",
      409,
    );
  }
  upsertRuntimeAction({
    localState: options.localState,
    targetVersion: request.targetVersion,
    draft,
    status: "deferred",
  });
  recordRemediationAudit(options, request, draft, "deferred");
}

async function runDraft(
  options: UpdateRemediationManagerOptions,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
): Promise<void> {
  if (!draft.canRun) {
    throw new UpdateRemediationError(
      "UPDATE_REMEDIATION_MANUAL",
      draft.instructions ?? "This remediation requires manual review.",
      409,
    );
  }
  upsertRuntimeAction({
    localState: options.localState,
    targetVersion: request.targetVersion,
    draft,
    status: "running",
  });
  const status = await executeDraft(options, draft);
  upsertRuntimeAction({
    localState: options.localState,
    targetVersion: request.targetVersion,
    draft,
    status,
    ...(status === "failed" ? { warningCode: "manual-review-required" } : {}),
  });
  recordRemediationAudit(options, request, draft, status);
}

async function runRemediationAction(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationActionRequest,
): Promise<UpdateRemediationStatusReport> {
  const drafts = draftsForImpact(options.localState, request.impact, options.localKnowledge);
  const draft = findDraftOrThrow(drafts, request.actionId);
  if (request.decision === "defer") {
    deferDraft(options, request, draft);
  } else {
    await runDraft(options, request, draft);
  }
  return statusFor(options, now, { ...request, persist: false });
}

function completeRestartAction(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  targetVersion?: string,
): UpdateRemediationStatusReport {
  const current = options.localState.readRuntimeState();
  for (const item of current.remediations) {
    if (item.remediation !== "restart-required") continue;
    upsertRuntimeAction({
      localState: options.localState,
      targetVersion,
      draft: restartDraft(item.store),
      status: "completed",
    });
  }
  return statusFor(options, now, { targetVersion });
}

function updateCanComplete(localState: UpdateLocalStateManager, targetVersion?: string): boolean {
  const state = localState.readRuntimeState();
  if (targetVersion !== undefined && state.targetVersion !== targetVersion) return true;
  return state.remediations.every(
    (item) => item.status === "completed" || item.status === "deferred",
  );
}

export function createUpdateRemediationManager(
  options: UpdateRemediationManagerOptions,
): UpdateRemediationManager {
  const now = options.now ?? Date.now;
  return {
    getStatus: (request): UpdateRemediationStatusReport => statusFor(options, now, request),
    runAction: (request): Promise<UpdateRemediationStatusReport> =>
      runRemediationAction(options, now, request),
    completeRestart: (targetVersion): UpdateRemediationStatusReport =>
      completeRestartAction(options, now, targetVersion),
    updateCanComplete: (targetVersion): boolean =>
      updateCanComplete(options.localState, targetVersion),
  };
}
