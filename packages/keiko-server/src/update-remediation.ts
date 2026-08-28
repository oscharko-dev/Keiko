import { randomUUID } from "node:crypto";
import type {
  UpdateRemediationAction,
  UpdateRemediationActionRequest,
  UpdateRemediationAffectedFeature,
  UpdateRemediationOverallStatus,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
  UpdateRemediationStatus as RuntimeRemediationStatus,
  UpdateRuntimeEventType,
  UpdateRuntimeWarningCode,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_REMEDIATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/update-remediation";
import type { LocalKnowledgeRemediationPort } from "./local-knowledge-remediation.js";
import {
  FEATURE_LABELS,
  draftsForImpact,
  restartDraft,
  type ActionDraft,
} from "./update-remediation-drafts.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";

export interface UpdateRemediationManager {
  readonly getStatus: (request?: UpdateRemediationStatusRequest) => UpdateRemediationStatusReport;
  // `correlationId` is optional so an existing caller keeps compiling unchanged; when the HTTP
  // route layer threads its own request-scoped id through (ADR-0173 D5 / g12), every diagnostic
  // this ONE action execution reports stays joined under it. Absent a caller-supplied id, one is
  // minted here, once, so a cascade of failures from a single execution (persist, then audit, then
  // outcome-uncertainty) still shares one id instead of each reporter minting its own.
  readonly runAction: (
    request: UpdateRemediationActionRequest,
    correlationId?: string,
  ) => Promise<UpdateRemediationStatusReport>;
  readonly completeRestart: (targetVersion?: string) => UpdateRemediationStatusReport;
  readonly updateCanComplete: (targetVersion?: string) => boolean;
}

export interface UpdateRemediationManagerOptions {
  readonly localState: UpdateLocalStateManager;
  readonly localKnowledge?: LocalKnowledgeRemediationPort | undefined;
  readonly now?: (() => number) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly redactString?: ((value: string) => string) | undefined;
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

function persistedAction(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): ReturnType<UpdateLocalStateManager["readRuntimeState"]>["remediations"][number] | undefined {
  return manager
    .readRuntimeState()
    .remediations.find(
      (item) => item.store === draft.store && item.remediation === draft.remediation,
    );
}

function persistedStatus(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): RuntimeRemediationStatus | undefined {
  return persistedAction(manager, draft)?.status;
}

function actionStatus(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): UpdateRemediationAction["status"] {
  if (!draft.required) return "not-needed";
  if (draft.kind === "manual-review") return "manual-review-required";
  const persisted = persistedAction(manager, draft);
  if (persisted?.warningCode === "remediation-outcome-uncertain") {
    return "manual-review-required";
  }
  const status = persisted?.status;
  if (status === "running") return "pending";
  if (status !== undefined) return status;
  return "pending";
}

function materializeAction(
  manager: UpdateLocalStateManager,
  draft: ActionDraft,
): UpdateRemediationAction {
  const persisted = persistedAction(manager, draft);
  return {
    ...draft,
    status: actionStatus(manager, draft),
    ...(persisted?.updatedAt === undefined ? {} : { updatedAt: persisted.updatedAt }),
    ...(persisted?.warningCode === undefined ? {} : { failure: persisted.warningCode }),
  };
}

export function overallStatus(
  actions: readonly UpdateRemediationAction[],
): UpdateRemediationOverallStatus {
  if (actions.every((item) => item.status === "not-needed")) {
    return "not-required";
  }
  const mapped = actions.map<UpdateRemediationOverallStatus>((action) => {
    if (action.status === "failed") return "failed";
    if (action.status === "manual-review-required") return "manual-review-required";
    if (action.status === "running") return "running";
    if (action.status === "pending") return "pending";
    return "completed";
  });
  return mapped.reduce(
    (worst, item) => (statusRank(item) > statusRank(worst) ? item : worst),
    "completed",
  );
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
  readonly now: () => number;
  readonly warningCode?: UpdateRuntimeWarningCode | undefined;
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
        updatedAt: nowIso(input.now),
        ...(input.warningCode === undefined ? {} : { warningCode: input.warningCode }),
      },
    ],
  });
}

function persistPending(
  localState: UpdateLocalStateManager,
  targetVersion: string | undefined,
  drafts: readonly ActionDraft[],
  now: () => number,
): void {
  for (const draft of drafts) {
    if (persistedStatus(localState, draft) !== undefined || !draft.required) continue;
    if (draft.kind === "manual-review") {
      upsertRuntimeAction({
        localState,
        targetVersion,
        draft,
        status: "failed",
        now,
        warningCode: "manual-review-required",
      });
      continue;
    }
    upsertRuntimeAction({ localState, targetVersion, draft, status: "pending", now });
  }
}

function statusFor(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationStatusRequest = {},
): UpdateRemediationStatusReport {
  const drafts = draftsForImpact(options.localState, request.impact, options.localKnowledge);
  if (request.persist === true) {
    persistPending(options.localState, request.targetVersion, drafts, now);
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

// `correlationId` is always the ONE id minted (or supplied) at the start of the enclosing
// `runAction` call — never a fresh mint here — so every failure this single action execution
// reports, however many of the call sites below fire, stays joined under it.
function recordDraftFailure(
  options: UpdateRemediationManagerOptions,
  correlationId: string,
  error: unknown,
  source = "update-remediation.executeDraft",
): void {
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "update.remediation.execute",
      source,
      error,
      redact: options.redactString ?? ((message): string => message),
    }),
  );
}

async function executeDraftStatus(
  options: UpdateRemediationManagerOptions,
  draft: ActionDraft,
  correlationId: string,
): Promise<RuntimeRemediationStatus> {
  try {
    return await executeDraft(options, draft);
  } catch (error) {
    recordDraftFailure(options, correlationId, error);
    return "failed";
  }
}

function persistOutcomeUncertainty(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  correlationId: string,
): boolean {
  try {
    upsertRuntimeAction({
      localState: options.localState,
      targetVersion: request.targetVersion,
      draft,
      status: "running",
      now,
      warningCode: "remediation-outcome-uncertain",
    });
    return true;
  } catch (error) {
    recordDraftFailure(
      options,
      correlationId,
      error,
      "update-remediation.persistOutcomeUncertainty",
    );
    return false;
  }
}

function recordDraftAuditSafely(
  options: UpdateRemediationManagerOptions,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  status: RuntimeRemediationStatus,
  correlationId: string,
): void {
  try {
    recordRemediationAudit(options, request, draft, status, correlationId);
  } catch (error) {
    recordDraftFailure(options, correlationId, error, "update-remediation.persistDraftAudit");
  }
}

function persistDraftStatusSafely(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  status: RuntimeRemediationStatus,
  correlationId: string,
): boolean {
  try {
    upsertRuntimeAction({
      localState: options.localState,
      targetVersion: request.targetVersion,
      draft,
      status,
      now,
      ...(status === "failed" ? { warningCode: "remediation-execution-failed" } : {}),
    });
  } catch (error) {
    recordDraftFailure(options, correlationId, error, "update-remediation.persistDraftStatus");
    const interlocked = persistOutcomeUncertainty(options, now, request, draft, correlationId);
    recordDraftAuditSafely(options, request, draft, status, correlationId);
    return interlocked;
  }
  recordDraftAuditSafely(options, request, draft, status, correlationId);
  return true;
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

function remediationAuditEventType(status: RuntimeRemediationStatus): UpdateRuntimeEventType {
  if (status === "deferred") {
    return "remediation-deferred";
  }
  if (status === "completed") {
    return "remediation-completed";
  }
  return "remediation-failed";
}

function recordRemediationAudit(
  options: UpdateRemediationManagerOptions,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  status: RuntimeRemediationStatus,
  correlationId: string,
): void {
  const result = options.localState.recordAuditEvent(remediationAuditEventType(status), {
    targetVersion: request.targetVersion,
    store: draft.store,
    remediation: draft.remediation,
    status,
    ...(status === "failed" ? { warningCode: "remediation-execution-failed" } : {}),
  });
  if (result.warning !== undefined) {
    recordDraftFailure(
      options,
      correlationId,
      new Error(result.warning),
      "update-remediation.persistDraftAudit",
    );
  }
}

function deferDraft(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  correlationId: string,
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
    now,
  });
  recordRemediationAudit(options, request, draft, "deferred", correlationId);
}

function assertDraftOutcomeKnown(
  options: UpdateRemediationManagerOptions,
  draft: ActionDraft,
): void {
  if (persistedAction(options.localState, draft)?.warningCode !== "remediation-outcome-uncertain") {
    return;
  }
  throw new UpdateRemediationError(
    "UPDATE_REMEDIATION_OUTCOME_UNCERTAIN",
    "The prior remediation outcome must be reconciled before this action can run again.",
    409,
  );
}

async function runDraft(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  runningActions: Set<string>,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
  correlationId: string,
): Promise<void> {
  if (!draft.canRun) {
    throw new UpdateRemediationError(
      "UPDATE_REMEDIATION_MANUAL",
      draft.instructions ?? "This remediation requires manual review.",
      409,
    );
  }
  if (runningActions.has(draft.actionId)) {
    throw new UpdateRemediationError(
      "UPDATE_REMEDIATION_RUNNING",
      "This remediation action is already running.",
      409,
    );
  }
  runningActions.add(draft.actionId);
  let releaseLease: (() => void) | undefined;
  let releaseAllowed = true;
  try {
    releaseLease = acquireRunningDraftLease(options, now, request, draft);
    releaseAllowed = persistDraftStatusSafely(
      options,
      now,
      request,
      draft,
      await executeDraftStatus(options, draft, correlationId),
      correlationId,
    );
  } finally {
    if (releaseAllowed) {
      runningActions.delete(draft.actionId);
      releaseLease?.();
    }
  }
}

function acquireRunningDraftLease(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  request: UpdateRemediationActionRequest,
  draft: ActionDraft,
): () => void {
  const releaseLease = options.localState.acquireRemediationLease(draft.actionId);
  if (releaseLease === undefined) {
    throw new UpdateRemediationError(
      "UPDATE_REMEDIATION_RUNNING",
      "This remediation action is already running.",
      409,
    );
  }
  try {
    upsertRuntimeAction({
      localState: options.localState,
      targetVersion: request.targetVersion,
      draft,
      status: "running",
      now,
    });
    return releaseLease;
  } catch (error) {
    releaseLease();
    throw error;
  }
}

async function runRemediationAction(
  options: UpdateRemediationManagerOptions,
  now: () => number,
  runningActions: Set<string>,
  request: UpdateRemediationActionRequest,
  correlationId: string,
): Promise<UpdateRemediationStatusReport> {
  const drafts = draftsForImpact(options.localState, request.impact, options.localKnowledge);
  const draft = findDraftOrThrow(drafts, request.actionId);
  assertDraftOutcomeKnown(options, draft);
  if (request.decision === "defer") {
    deferDraft(options, now, request, draft, correlationId);
  } else {
    await runDraft(options, now, runningActions, request, draft, correlationId);
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
      now,
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
  const runningActions = new Set<string>();
  return {
    getStatus: (request): UpdateRemediationStatusReport => statusFor(options, now, request),
    runAction: (request, correlationId = randomUUID()): Promise<UpdateRemediationStatusReport> =>
      runRemediationAction(options, now, runningActions, request, correlationId),
    completeRestart: (targetVersion): UpdateRemediationStatusReport =>
      completeRestartAction(options, now, targetVersion),
    updateCanComplete: (targetVersion): boolean =>
      updateCanComplete(options.localState, targetVersion),
  };
}
