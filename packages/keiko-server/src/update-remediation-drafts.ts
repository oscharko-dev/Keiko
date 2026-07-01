import type {
  ReleaseImpactRemediation,
  UpdateReleaseImpactInput,
  UpdateRemediationActionKind,
  UpdateRemediationScopeCounts,
  UpdateStateStore,
  UpdateStoreHealth,
} from "@oscharko-dev/keiko-contracts";
import type { LocalKnowledgeRemediationPort } from "./local-knowledge-remediation.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";

export interface ActionDraft {
  readonly actionId: string;
  readonly kind: UpdateRemediationActionKind;
  readonly store: UpdateStateStore;
  readonly remediation: ReleaseImpactRemediation;
  readonly required: boolean;
  readonly canRun: boolean;
  readonly canDefer: boolean;
  readonly userApprovalRequired: boolean;
  readonly featureIds: readonly string[];
  readonly scopeCounts: UpdateRemediationScopeCounts;
  readonly message: string;
  readonly instructions?: string | undefined;
  readonly cliFallback?: string | undefined;
}

export const FEATURE_LABELS: Readonly<Record<UpdateStateStore, string>> = {
  "ui-layout": "Workspace layout",
  "server-runtime": "Keiko runtime",
  "durable-config": "Configuration and credentials",
  evidence: "Evidence and audit history",
  "memory-vault": "Memory Vault",
  "local-knowledge": "Local Knowledge",
  "workspace-references": "Workspace references",
  "package-install": "Package installation",
};

function actionId(kind: UpdateRemediationActionKind, store: UpdateStateStore): string {
  return `${kind}:${store}`;
}

function actionKind(
  store: UpdateStateStore,
  remediation: ReleaseImpactRemediation,
): UpdateRemediationActionKind {
  if (remediation === "restart-required") return "restart";
  if (remediation === "repair-required") return "local-state-repair";
  if (remediation === "local-knowledge-reindex-required" && store === "local-knowledge") {
    return "local-knowledge-reindex";
  }
  return "manual-review";
}

function featureIdsFor(store: UpdateStateStore): readonly string[] {
  if (store === "local-knowledge") return ["local-knowledge"];
  if (store === "memory-vault") return ["memory-vault"];
  if (store === "server-runtime" || store === "package-install") return ["update-runtime"];
  return [store];
}

function baseCounts(store: UpdateStoreHealth): UpdateRemediationScopeCounts {
  return {
    stores: 1,
    artifacts: store.ownedArtifactCount,
    retainedEntries: store.retainedEntryCount,
  };
}

function mergeLocalKnowledgeCounts(
  base: UpdateRemediationScopeCounts,
  port: LocalKnowledgeRemediationPort | undefined,
): UpdateRemediationScopeCounts {
  if (port === undefined) return base;
  try {
    const scope = port.inspect();
    return {
      ...base,
      capsules: scope.capsules,
      sources: scope.sources,
      documents: scope.documents,
      chunks: scope.chunks,
      vectors: scope.vectors,
    };
  } catch {
    return base;
  }
}

function messageFor(kind: UpdateRemediationActionKind, store: UpdateStateStore): string {
  if (kind === "restart") return "Restart Keiko to load the updated package.";
  if (kind === "local-state-repair") {
    return "Repair Keiko-owned local runtime artifacts before completing the update.";
  }
  if (kind === "local-knowledge-reindex") {
    return "Refresh Local Knowledge vectors before affected grounded workflows are ready.";
  }
  return `${FEATURE_LABELS[store]} requires manual review before the update can complete.`;
}

function instructionsFor(kind: UpdateRemediationActionKind): string | undefined {
  if (kind === "restart") {
    return "Close Keiko, start it again, then verify the restarted version.";
  }
  if (kind === "manual-review") {
    return "Review the release-impact guidance and local state health before continuing.";
  }
  return undefined;
}

function cliFallbackFor(kind: UpdateRemediationActionKind): string | undefined {
  if (kind === "local-state-repair" || kind === "manual-review") return "keiko repair";
  return undefined;
}

function needsManualFilesystemReview(store: UpdateStoreHealth): boolean {
  return store.health === "manual-review-required" && store.retainedEntryCount > 0;
}

function shouldDraftAction(store: UpdateStoreHealth, manualFilesystemReview: boolean): boolean {
  return (
    (store.affected || manualFilesystemReview) &&
    (store.remediation !== "no-action-required" || manualFilesystemReview)
  );
}

function countsForDraft(
  kind: UpdateRemediationActionKind,
  store: UpdateStoreHealth,
  localKnowledge: LocalKnowledgeRemediationPort | undefined,
): UpdateRemediationScopeCounts {
  const counts = baseCounts(store);
  return kind === "local-knowledge-reindex"
    ? mergeLocalKnowledgeCounts(counts, localKnowledge)
    : counts;
}

function draftMessage(
  kind: UpdateRemediationActionKind,
  store: UpdateStateStore,
  noLocalKnowledge: boolean,
): string {
  return noLocalKnowledge ? "No Local Knowledge capsules are present." : messageFor(kind, store);
}

function draftForStore(
  store: UpdateStoreHealth,
  localKnowledge: LocalKnowledgeRemediationPort | undefined,
): ActionDraft | undefined {
  const manualFilesystemReview = needsManualFilesystemReview(store);
  if (!shouldDraftAction(store, manualFilesystemReview)) return undefined;
  const remediation = manualFilesystemReview ? "manual-review-required" : store.remediation;
  const kind = actionKind(store.store, remediation);
  const counts = countsForDraft(kind, store, localKnowledge);
  const noLocalKnowledge = kind === "local-knowledge-reindex" && counts.capsules === 0;
  return {
    actionId: actionId(kind, store.store),
    kind,
    store: store.store,
    remediation,
    required: !noLocalKnowledge,
    canRun: kind === "local-state-repair" || kind === "local-knowledge-reindex",
    canDefer: kind === "local-knowledge-reindex",
    userApprovalRequired: kind !== "restart",
    featureIds: featureIdsFor(store.store),
    scopeCounts: counts,
    message: draftMessage(kind, store.store, noLocalKnowledge),
    ...(instructionsFor(kind) === undefined ? {} : { instructions: instructionsFor(kind) }),
    ...(cliFallbackFor(kind) === undefined ? {} : { cliFallback: cliFallbackFor(kind) }),
  };
}

export function draftsForImpact(
  manager: UpdateLocalStateManager,
  impact: UpdateReleaseImpactInput | undefined,
  localKnowledge: LocalKnowledgeRemediationPort | undefined,
): readonly ActionDraft[] {
  return manager
    .scanCompatibility(impact)
    .stores.map((store) => draftForStore(store, localKnowledge))
    .filter((draft): draft is ActionDraft => draft !== undefined);
}

export function restartDraft(store: UpdateStateStore): ActionDraft {
  return {
    actionId: actionId("restart", store),
    kind: "restart",
    store,
    remediation: "restart-required",
    required: true,
    canRun: false,
    canDefer: false,
    userApprovalRequired: false,
    featureIds: featureIdsFor(store),
    scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
    message: messageFor("restart", store),
  };
}
