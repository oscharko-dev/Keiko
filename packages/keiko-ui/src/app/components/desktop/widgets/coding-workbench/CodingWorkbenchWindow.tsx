"use client";

import {
  CodingWorkbenchDeliveryReview,
  approvalHelpKey,
  isDeliveryPermission,
} from "./CodingWorkbenchDeliveryReview";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { fetchCodingWorkbenchJourneyRefresh } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { correlationIdOf } from "@/lib/client-error-summary";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchApprovalRisk,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchSupervisedActionKind,
  CodingWorkbenchSupervisedPolicyReason,
  CodingWorkbenchMode,
  CodingWorkbenchPermissionRequestKind,
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_MODES,
  isCodingWorkbenchMode,
  isCodingWorkbenchModeWidening,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { isCodingWorkbenchModel } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { useTranslate } from "@/lib/i18n";
import { CodingWorkbenchCiReadiness } from "./CodingWorkbenchCiReadiness";
import {
  CodingWorkbenchDraftDelivery,
  type WorkbenchDescriptionReviewTarget,
} from "./CodingWorkbenchDraftDelivery";
import {
  CodingWorkbenchJourneyOutcome,
  createPrMarkReadyProposeHandler,
  type CodingWorkbenchJourneyChangedFilesSummary,
} from "./CodingWorkbenchJourneyOutcome";
import { CodingWorkbenchCommitResult } from "./CodingWorkbenchCommitResult";
import {
  CodingWorkbenchCommitReview,
  reviewForPermission,
  approvalReviewRequestId,
  StageReviewDiagnostic,
} from "./CodingWorkbenchCommitReview";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import {
  useCodingWorkbenchRuntime,
  type CodingWorkbenchRuntimeActions,
  type UseCodingWorkbenchRuntimeInput,
} from "@/lib/useCodingWorkbenchRuntime";
import { useAutonomyModePolicy } from "../../hooks/useAutonomyModePolicy";
import type {
  CodingWorkbenchMutationKind,
  CodingWorkbenchMutationState,
  CodingWorkbenchRuntimeState,
  CodingWorkbenchWorkspaceProjection,
} from "@/lib/coding-workbench-live-state";
import { useCodingWorkbenchQuestions } from "@/lib/useCodingWorkbenchQuestions";
import { useCodingWorkbenchSafeActivity } from "@/lib/useCodingWorkbenchSafeActivity";
import { useFollowNewest } from "@/lib/useFollowNewest";
import {
  useCodingWorkbenchResearch,
  type CodingWorkbenchResearchStatus,
  type UseCodingWorkbenchResearchResult,
} from "@/lib/useCodingWorkbenchResearch";
import {
  useCodingWorkbenchApprovalReview,
  type CodingWorkbenchApprovalReviewStatus,
  type UseCodingWorkbenchApprovalReviewResult,
} from "@/lib/useCodingWorkbenchApprovalReview";
import {
  useCodingWorkbenchEditorBridge,
  type CodingWorkbenchChangesetReview,
} from "@/lib/useCodingWorkbenchEditorBridge";
import { useOptionalActiveWorkspace } from "../../context/ActiveWorkspaceContext";
import { useOptionalChatSessionCatalog } from "../../context/ChatSessionContext";
import { DiffFileSection } from "../cards/shared/diffView";
import {
  PanelTitle,
  TaskStartSection,
  Timeline,
  WorkbenchWelcome,
} from "./CodingWorkbenchSections";
import {
  CodingWorkbenchSetup,
  type CodingWorkbenchSetupRuntimePosture,
} from "./CodingWorkbenchSetup";
import {
  CodingWorkbenchChanges,
  diffLabels,
  RetryMessage,
  type RetryMessageProps,
} from "./CodingWorkbenchChanges";
import { useCodingWorkbenchChanges } from "@/lib/useCodingWorkbenchChanges";
import { CodexSubscriptionAuthCard } from "./CodingWorkbenchModelCards";
import {
  useCodingWorkbenchRunWorkspace,
  type CodingWorkbenchRunWorkspace,
  type CodingWorkbenchRunWorkspaceBinding,
} from "./useCodingWorkbenchRunWorkspace";
import { ResearchGrantChip } from "./CodingWorkbenchResearchGrant";
import { CodingWorkbenchTrustAffordance } from "./CodingWorkbenchTrustAffordance";
import { requestGatewayModelCatalogRefresh } from "../shared/gatewaySetupBus";
import {
  activeRunState,
  changesetDeliveryAlert,
  cx,
  lifecycleAnnouncement,
  modeLabel,
  modelSourceLabel,
  visibleAlert,
} from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";
import {
  codingWorkbenchIssueTaskId,
  type AcceptedWorkbenchIssue,
} from "./useCodingWorkbenchIssueIntake";
import { CodingWorkbenchIssueChip } from "./CodingWorkbenchIssueChip";

const EMPTY_WORKSPACE = {
  activeBinding: null,
  activeInstance: null,
  loading: false,
  switching: false,
  error: null,
  refresh: (): Promise<boolean> => Promise.resolve(true),
} as const;

/**
 * The coding runtime's resolved posture, or `null` while the readiness read is still in flight: a
 * read that failed or answered "unavailable" is "unavailable" (never silently reassuring), a
 * resolved-but-unverified runtime is "evaluation" (ADR-0163 D9), and only a resolved, verified
 * runtime is "verified".
 */
function resolvedRuntimePosture(
  runtime: CodingWorkbenchRuntimeState["runtime"],
): CodingWorkbenchSetupRuntimePosture | null {
  if (runtime.status === "idle" || runtime.status === "loading") return null;
  if (runtime.status !== "ready" || runtime.value?.runtimeAvailable === false) return "unavailable";
  return runtime.value?.runtimeEvidenceClass === "functional-not-platform-qualified"
    ? "evaluation"
    : "verified";
}

/**
 * The posture shared by the bootstrap setup section and the header's "Coding runtime" chip
 * (workbench audit, 2026-09-03) so the two can never disagree. While a RE-read is in flight the
 * last RESOLVED posture stands — every mode switch re-reads readiness, and a known-unavailable
 * runtime must not flash "verified" for the duration of that read.
 *
 * Before anything has resolved the posture is "pending", never "verified": seeding the last-resolved
 * reference with "verified" made the chip render "Platform-verified — signed and notarized runtime"
 * on first open and on every remount, and stand there indefinitely on a slow or hanging readiness
 * read — the strongest trust claim in the window, shown for the wrong reason, on an evaluation
 * install included (#3381 review).
 */
function useRuntimeAssurancePosture(
  state: CodingWorkbenchRuntimeState,
): CodingWorkbenchSetupRuntimePosture {
  const lastResolvedRef = useRef<CodingWorkbenchSetupRuntimePosture | null>(null);
  const resolved = resolvedRuntimePosture(state.runtime);
  useEffect(() => {
    if (resolved !== null) lastResolvedRef.current = resolved;
  }, [resolved]);
  return resolved ?? lastResolvedRef.current ?? "pending";
}

const RUNTIME_ASSURANCE_MESSAGE_KEYS: Record<
  CodingWorkbenchSetupRuntimePosture,
  CodingWorkbenchMessageKey
> = {
  pending: "codingWorkbench.readiness.runtime.pending",
  verified: "codingWorkbench.readiness.runtime.verified",
  evaluation: "codingWorkbench.readiness.runtime.evaluation",
  unavailable: "codingWorkbench.readiness.runtime.unavailable",
};

// The chip's warning tone marks a posture the operator has to act on. "pending" is neutral — it
// states that the check is still running, which is neither an assurance nor a problem — and
// "verified" is neutral because it is the good outcome.
const NEUTRAL_RUNTIME_ASSURANCE_POSTURES: ReadonlySet<CodingWorkbenchSetupRuntimePosture> = new Set(
  ["pending", "verified"],
);

function latestChangesSignal(events: readonly CodingWorkbenchRuntimeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "status" || event?.eventKind === "diff-summarized") return event.cursor;
  }
  return null;
}

/** Joins `CodingWorkbenchChanges`' own live file list to a bounded count + truncation flag (AC2) —
 * never a path, a diff or the underlying provider error detail. */
function changedFilesSummary(
  changes: ReturnType<typeof useCodingWorkbenchChanges>,
): CodingWorkbenchJourneyChangedFilesSummary {
  if (changes.status === "ready") {
    return { status: "ready", fileCount: changes.files.length, truncated: changes.truncated };
  }
  if (changes.status === "loading") return { status: "loading", fileCount: 0, truncated: false };
  return { status: "unavailable", fileCount: 0, truncated: false };
}

interface CodingWorkbenchJourneyState {
  readonly outcome: JourneyOutcome | undefined;
  readonly onRefresh: () => Promise<void>;
}

/**
 * Read-only journey observation/reconciliation (#3389 AC1/AC5/AC6). Admitted server-side by the
 * per-checkout GitHub-reader grant, never the run-bound mutation gate, so a manual refresh keeps
 * working after the run has terminated. Never mints, requests or implies merge/issue-close
 * authority — this only reads what the server already observed.
 */
function useCodingWorkbenchJourney(runId: string | undefined): CodingWorkbenchJourneyState {
  const [outcome, setOutcome] = useState<JourneyOutcome | undefined>(undefined);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    if (runId === undefined) return;
    const requestId = (generation.current += 1);
    const result = await fetchCodingWorkbenchJourneyRefresh({ runId });
    if (generation.current !== requestId) return;
    setOutcome(result.status === "observed" ? result.outcome : undefined);
  }, [runId]);
  useEffect(() => {
    setOutcome(undefined);
    if (runId === undefined) return;
    refresh().catch((error: unknown) => {
      // Owner audit b1-14 — mirror _useJourneyActions.ts's own failure report: prefer the failed
      // request's own ApiError.correlationId so this diagnostic joins server.log, falling back to
      // runId only when the error carries none.
      reportClientDiagnostic("[keiko] journey initial refresh failed", {
        correlationId: correlationIdOf(error) ?? runId,
      });
    });
    // The manual "Refresh observed status" control surfaces a failed retry through the card's own
    // action feedback; this initial load only needs a body-free diagnostic, not a second UI path.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable per runId already
  }, [runId]);
  return { outcome, onRefresh: refresh };
}

/**
 * Builds the Coding Workbench's `onProposeReady` from the journey outcome's own exported mark-ready
 * helper (#3389 AC3), bound to the workspace root the window already names `projectId` everywhere
 * else in this file's family (`GovernedPullRequestCard`, `GitClientWindow`: "the active project root
 * acts as the projectId" — AGENTS.md §5 reuse, not a second identity). Undefined whenever either the
 * outcome or a real root is missing, so `markReadyAvailable` downstream stays exactly that same
 * `undefined` check — the control is never offered as clickable without a handler genuinely backed
 * by a real mint/execute request.
 */
function useMarkReadyPropose(
  outcome: JourneyOutcome | undefined,
  projectId: string | null,
): (() => Promise<void>) | undefined {
  return useMemo(() => {
    if (outcome === undefined || projectId === null || projectId === "") return undefined;
    return createPrMarkReadyProposeHandler(outcome, projectId);
  }, [outcome, projectId]);
}

function optionalMarkReadyHandler(handler: (() => Promise<void>) | undefined): {
  readonly onProposeReady?: () => Promise<void>;
} {
  if (handler === undefined) return {};
  return { onProposeReady: handler };
}

interface ResumeModeSelection {
  readonly runId: string;
  readonly currentMode: CodingWorkbenchMode;
  readonly value: CodingWorkbenchMode;
}

interface WorkbenchAuthoritySelection {
  readonly pending: boolean;
  readonly errorMessage: string | null;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}

function useWorkbenchAuthoritySelection(
  state: CodingWorkbenchRuntimeState,
  actions: CodingWorkbenchRuntimeActions,
  t: CodingWorkbenchTranslate,
): WorkbenchAuthoritySelection {
  const policy = useAutonomyModePolicy();
  const runState = state.run.value?.state;
  useEffect(() => {
    if (
      activeRunState(runState) ||
      state.mutation.status === "pending" ||
      policy.pending ||
      state.requestedMode === policy.requestedMode
    ) {
      return;
    }
    actions.setRequestedMode(policy.requestedMode);
  }, [
    actions,
    policy.pending,
    policy.requestedMode,
    runState,
    state.mutation.status,
    state.requestedMode,
  ]);
  return {
    pending: policy.pending,
    errorMessage:
      policy.error === null ? null : t(`codingWorkbench.composer.authority.error.${policy.error}`),
    onChange: (mode): void => {
      actions.setRequestedMode(mode);
      policy.change(mode);
    },
  };
}

// `actions.start`/`actions.submitFollowUp`/`actions.retry` never reject — the mutation queue
// (coding-workbench-runtime-hooks.ts's `useRuntimeMutationQueue`) catches every failure into
// `state.mutation` and always resolves the returned promise — so success and failure can only be
// told apart by watching the reducer's own settlement, never by awaiting the action call itself
// (workbench audit, 2026-09-03). These are the three mutation kinds that consume the composer draft.
const TASK_INTENT_MUTATIONS: ReadonlySet<CodingWorkbenchMutationKind> = new Set([
  "start",
  "follow-up",
  "retry",
]);

function consumesTaskIntent(mutation: CodingWorkbenchMutationState): boolean {
  return (
    mutation.status === "pending" &&
    mutation.kind !== null &&
    TASK_INTENT_MUTATIONS.has(mutation.kind)
  );
}

/**
 * Clears the composer's draft once the draft-consuming mutation that WAS pending settles as a
 * success (`mutation-complete` → status "idle"), and only when the draft is still the text that
 * mutation consumed: a failure (`mutation-failed` → status "error") keeps it so the operator can
 * fix and resend, and text added while the mutation was in flight (dictation) is never wiped.
 * Without this, the draft stayed put after every completed Start, Retry or paused-run Send —
 * indistinguishable from an unsent draft, and re-submittable as a brand-new follow-up by mistake.
 */
function useClearTaskIntentOnMutationSuccess(
  mutation: CodingWorkbenchMutationState,
  taskIntent: string,
  setTaskIntent: (value: string) => void,
): void {
  const previousRef = useRef(mutation);
  const submittedRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = mutation;
    if (!consumesTaskIntent(previous) && consumesTaskIntent(mutation)) {
      submittedRef.current = taskIntent;
      return;
    }
    if (consumesTaskIntent(previous) && mutation.status === "idle") {
      if (submittedRef.current === taskIntent) setTaskIntent("");
      submittedRef.current = null;
    }
  }, [mutation, setTaskIntent, taskIntent]);
}

function resumableModes(currentMode: CodingWorkbenchMode): readonly CodingWorkbenchMode[] {
  return CODING_WORKBENCH_MODES.filter((mode) => !isCodingWorkbenchModeWidening(currentMode, mode));
}

function selectedResumeMode(
  selection: ResumeModeSelection | null,
  runId: string | undefined,
  currentMode: CodingWorkbenchMode | undefined,
): CodingWorkbenchMode | null {
  if (runId === undefined || currentMode === undefined) return null;
  return selection?.runId === runId && selection.currentMode === currentMode
    ? selection.value
    : currentMode;
}

export interface CodingWorkbenchGitTarget {
  readonly root: string | null;
  readonly binding: "repository" | "task-workspace";
  readonly repositoryDialog?: "clone" | "open" | undefined;
  readonly descriptionReview?: WorkbenchDescriptionReviewTarget | undefined;
}

function noopOpenGit(_target: CodingWorkbenchGitTarget): void {}

function workbenchRepositoryRoot(
  runIsActive: boolean,
  runBoundRoot: string | null,
  activeWorkspace: WorkbenchWorkspaceApi,
  selectedRoot: string | undefined,
): string | null {
  if (!runIsActive) return activeWorkspace.activeInstance?.repositoryRoot ?? selectedRoot ?? null;
  return runBoundRoot ?? activeWorkspace.activeBinding?.activeRoot ?? selectedRoot ?? null;
}

type WorkbenchWorkspaceApi = UseCodingWorkbenchRuntimeInput["workspace"];

/** The live active root, or null when the read failed — one definition, so the surfaces that
 * consume it (the editor bridge, the changes panel, the run-workspace lock) cannot disagree. */
function liveWorkspaceRootOf(workspace: WorkbenchWorkspaceApi): string | null {
  return workspace.error === null ? (workspace.activeBinding?.activeRoot ?? null) : null;
}

/** True while the live binding is unsettled and therefore proves nothing about where it points. */
function workspaceBindingPendingOf(workspace: WorkbenchWorkspaceApi): boolean {
  return workspace.loading || workspace.switching;
}

function liveWorkspaceIdentity(
  workspace: WorkbenchWorkspaceApi,
  state: CodingWorkbenchRuntimeState,
): CodingWorkbenchRunWorkspace {
  return {
    root: liveWorkspaceRootOf(workspace),
    taskBranch: workspace.activeInstance?.taskBranch ?? null,
    workspace: state.workspace.value,
  };
}

/** The run-scoped workspace lock, wired from the live binding (#3381 review). */
function useRunWorkspaceBinding(
  state: CodingWorkbenchRuntimeState,
  activeWorkspace: WorkbenchWorkspaceApi,
): CodingWorkbenchRunWorkspaceBinding {
  return useCodingWorkbenchRunWorkspace({
    runId: state.run.value?.runId,
    live: liveWorkspaceIdentity(activeWorkspace, state),
    // An unreadable binding is as unsettled as a switching one: it proves nothing about where the
    // pointer now points, so it must not be read as a divergence from the run's workspace.
    bindingPending: workspaceBindingPendingOf(activeWorkspace) || activeWorkspace.error !== null,
  });
}

/**
 * The workspace the context bar names while a run is live: the run's own. The LIVE projection is
 * preferred while it still names that workspace, so mutable facts (health) stay current; once the
 * pointer names a different workspace the frozen submission-time projection stands, because
 * captioning workspace B's identity with the run in A is exactly the confusion this repairs.
 */
function sessionWorkspaceProjection(
  state: CodingWorkbenchRuntimeState,
  runWorkspace: CodingWorkbenchRunWorkspaceBinding,
): CodingWorkbenchWorkspaceProjection | null {
  const bound = runWorkspace.bound?.workspace ?? null;
  if (bound === null || !activeRunState(state.run.value?.state)) return state.workspace.value;
  const live = state.workspace.value;
  return live !== null && live.workspaceId === bound.workspaceId ? live : bound;
}

export function CodingWorkbenchWindow({
  selectedRoot,
  onOpenGit = noopOpenGit,
}: {
  readonly selectedRoot?: string | undefined;
  readonly onOpenGit?: ((target: CodingWorkbenchGitTarget) => void) | undefined;
}): ReactNode {
  const activeWorkspace = useOptionalActiveWorkspace() ?? EMPTY_WORKSPACE;
  const chatCatalog = useOptionalChatSessionCatalog();
  const { state, actions } = useCodingWorkbenchRuntime({ workspace: activeWorkspace });
  const codingModels = useMemo(
    () => chatCatalog?.models.filter(isCodingWorkbenchModel) ?? [],
    [chatCatalog?.models],
  );
  useEffect(() => requestGatewayModelCatalogRefresh(), []);
  useCodingModelSelection(state, actions, codingModels);
  const research = useCodingWorkbenchResearch({
    runId: state.run.value?.runId,
    revision: state.run.value?.revision,
    permissionRequestId: state.run.value?.pendingPermission?.requestId,
  });
  // Run attribution is answered from the run's OWN workspace for its whole life, never from the
  // live pointer (#3381 review) — see `useCodingWorkbenchRunWorkspace`.
  const runWorkspace = useRunWorkspaceBinding(state, activeWorkspace);
  const [taskIntent, setTaskIntent] = useState("");
  useClearTaskIntentOnMutationSuccess(state.mutation, taskIntent, setTaskIntent);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const approvalAction = useRef(false);
  const t = useCodingWorkbenchTranslate();
  const authority = useWorkbenchAuthoritySelection(state, actions, t);
  const workbenchLabel = useTranslate()("rail.coding");
  const pendingPermission = state.run.value?.pendingPermission;
  const alert = visibleAlert(
    state,
    t,
    bootstrapSetupVisible(state, activeWorkspace),
    authority.errorMessage,
  );

  useEffect(() => {
    if (!approvalAction.current || pendingPermission !== undefined) return;
    approvalAction.current = false;
    focusRef.current?.focus();
  }, [pendingPermission]);

  const decideApproval = (decision: "approved" | "denied"): void => {
    approvalAction.current = true;
    void actions.decideApproval(decision);
  };
  return (
    <WorkbenchContent
      state={state}
      actions={actions}
      activeWorkspace={activeWorkspace}
      selectedRoot={selectedRoot}
      taskIntent={taskIntent}
      onTaskIntentChange={setTaskIntent}
      focusRef={focusRef}
      alert={alert}
      t={t}
      workbenchLabel={workbenchLabel}
      onDecision={decideApproval}
      research={research}
      codingModels={codingModels}
      authority={authority}
      onOpenGit={onOpenGit}
      runWorkspace={runWorkspace}
    />
  );
}

function useCodingModelSelection(
  state: CodingWorkbenchRuntimeState,
  actions: CodingWorkbenchRuntimeActions,
  models: readonly ModelCapability[],
): void {
  const selected = models.find((model) => model.id === state.selectedModelId);
  useEffect(() => {
    if (state.runtimePreference !== "managed-gateway") return;
    const next = selected?.id ?? models[0]?.id ?? null;
    if (next !== state.selectedModelId) actions.setSelectedModel(next);
  }, [actions, models, selected?.id, state.runtimePreference, state.selectedModelId]);
  useEffect(() => {
    const efforts = selected?.reasoningEfforts ?? [];
    const currentAllowed =
      state.reasoningEffort !== null && efforts.includes(state.reasoningEffort);
    const next = currentAllowed
      ? state.reasoningEffort
      : (efforts.find((effort) => effort === "medium") ?? efforts[0] ?? null);
    if (next !== state.reasoningEffort) actions.setReasoningEffort(next);
  }, [actions, selected, state.reasoningEffort]);
}

interface WorkbenchContentProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
  readonly activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"];
  readonly selectedRoot: string | undefined;
  readonly taskIntent: string;
  readonly onTaskIntentChange: (taskIntent: string) => void;
  readonly focusRef: RefObject<HTMLHeadingElement | null>;
  readonly alert: string | null;
  readonly t: CodingWorkbenchTranslate;
  readonly workbenchLabel: string;
  readonly onDecision: (decision: "approved" | "denied") => void;
  readonly research: UseCodingWorkbenchResearchResult;
  readonly codingModels: readonly ModelCapability[];
  readonly authority: WorkbenchAuthoritySelection;
  readonly onOpenGit: (target: CodingWorkbenchGitTarget) => void;
  /** The run's own workspace attribution, independent of the live pointer (#3381 review). */
  readonly runWorkspace: CodingWorkbenchRunWorkspaceBinding;
}

function WorkbenchAlert({ message }: { readonly message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={styles.alert} role="alert">
      <span aria-hidden="true">!</span> {message}
    </p>
  );
}

/**
 * The one place the LIVE workspace pointer is consulted during a run (#3381 review): it cannot
 * retarget the run — the chips, the Git target and the editor bridge stay on the workspace the run
 * was submitted against — but a pointer that no longer names that workspace is exactly why the
 * changes panel reports a lost binding and why nothing the operator does in the other workspace
 * reaches this run. Stating it is what turns two silent inert panels into one actionable fact.
 */
function RunWorkspaceMismatchNotice({ visible }: { readonly visible: boolean }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (!visible) return null;
  return (
    <output className={styles.alert}>
      <span aria-hidden="true">!</span> {t("codingWorkbench.composer.workspaceMismatch")}
    </output>
  );
}

/**
 * Epic #3384 cascade: a refused edit used to leave the operator with nothing — the model just
 * asked "how would you like to proceed?" while every `keiko_changeset_edit` kept failing
 * NO_ACTIVE_SESSION. `useCodingWorkbenchEditorBridge` now retries the registration on its own
 * (`bridgeUnavailable` reports whether that retry is still in flight); this is the one place the
 * operator sees that anything is happening at all instead of a silent gap that looks identical to
 * a healthy, idle bridge.
 */
function EditorBridgeUnavailableNotice({ visible }: { readonly visible: boolean }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (!visible) return null;
  return (
    <output className={styles.alert}>
      <span aria-hidden="true">!</span> {t("codingWorkbench.editorBridge.reconnecting")}
    </output>
  );
}

// The three props this level owns are named; the rest belong to `WorkbenchColumns` and pass
// through as one rest object, so a new column prop is not restated on this hop at all.
function WorkbenchContent({
  alert,
  t,
  workbenchLabel,
  ...columns
}: WorkbenchContentProps): ReactNode {
  const { research, runWorkspace, state, activeWorkspace } = columns;
  return (
    <section
      className={styles.shell}
      aria-label={workbenchLabel}
      aria-busy={state.mutation.status === "pending"}
      data-state={state.run.value?.state ?? "idle"}
    >
      <h2 className="sr-only">{workbenchLabel}</h2>
      <SessionContextBar
        state={state}
        workspace={sessionWorkspaceProjection(state, runWorkspace)}
      />
      {/* #3390 wave: the same live root the editor bridge and changes panel already key on
          (`liveWorkspaceRootOf`), so a run refused WORKSPACE_TRUST_REQUIRED has one visible, explicit
          exit here instead of requiring the operator to already know the Editor's own command. */}
      <CodingWorkbenchTrustAffordance root={liveWorkspaceRootOf(activeWorkspace)} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {lifecycleAnnouncement(state, t, research.grant)}
      </p>
      <div className={styles.body}>
        <WorkbenchAlert message={alert} />
        <WorkbenchColumns {...columns} />
      </div>
    </section>
  );
}

// Epic #3384 cascade, end-to-end run 2026-09-05: after a stop, this window's activity feed showed
// "Reconnect activity" and stayed disconnected even once a different run started — the operator
// had to click Reconnect (or reload the page) before seeing anything for it. `retry` is a stable,
// pure epoch-bump (`useCodingWorkbenchSafeActivity`); calling it once per newly observed run id is
// therefore always safe, whatever the feed's current status happens to be.
function useReconnectActivityOnNewRun(runId: string | undefined, retry: () => void): void {
  const seenRunIdRef = useRef<string | undefined>(runId);
  useEffect(() => {
    if (runId === undefined || runId === seenRunIdRef.current) return;
    seenRunIdRef.current = runId;
    retry();
  }, [runId, retry]);
}

function WorkbenchColumns({
  state,
  actions,
  activeWorkspace,
  selectedRoot,
  taskIntent,
  onTaskIntentChange,
  focusRef,
  onDecision,
  research,
  codingModels,
  authority,
  onOpenGit,
  runWorkspace,
}: Omit<WorkbenchContentProps, "alert" | "t" | "workbenchLabel">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [issueSetup, setIssueSetup] = useState(false);
  const [acceptedIssue, setAcceptedIssue] = useState<AcceptedWorkbenchIssue | null>(null);
  const activeIssueRepository = activeWorkspace.activeInstance?.repositoryId;
  const activeIssueTask = activeWorkspace.activeBinding?.taskId;
  useEffect(() => {
    if (
      acceptedIssue !== null &&
      !issueSetup &&
      activeIssueTask !== undefined &&
      (activeIssueTask !== codingWorkbenchIssueTaskId(acceptedIssue.binding.issueNumber) ||
        activeIssueRepository !== acceptedIssue.binding.repositoryId)
    )
      setAcceptedIssue(null);
  }, [acceptedIssue, activeIssueTask, activeIssueRepository, issueSetup]);
  const [resumeSelection, setResumeSelection] = useState<ResumeModeSelection | null>(null);
  // The bootstrap Code setup (#2385) renders whenever no active task-workspace binding exists, so a
  // hand-bound repository can be bound → verified → started entirely from the UI (#2476). It no longer
  // hides behind runtime availability: on an unactivated install it stays reachable and honestly
  // explains why a run cannot start yet (#2476 AC4). Once a binding lands it yields to the task-start
  // flow. The honest note shows only once readiness has RESOLVED as unavailable, never during load.
  const showSetup = issueSetup || bootstrapSetupVisible(state, activeWorkspace);
  const runtimePosture = useRuntimeAssurancePosture(state);
  // Monotonic, not a count: the event buffer is capped (CODING_WORKBENCH_EVENT_RETENTION_LIMIT), so
  // its length plateaus on a long run and every change-driven resync — questions and the activity
  // feed's automatic reconnect — would silently stop firing exactly when a run is busiest. The
  // highest observed runtime-event sequence keeps advancing for as long as the run produces events.
  const runtimeEventSignal = state.events.reduce(
    (highest, event) =>
      event.kind === "runtime-event" && event.sequence > highest ? event.sequence : highest,
    0,
  );
  const questions = useCodingWorkbenchQuestions({
    runId: state.run.value?.runId,
    revision: state.run.value?.revision,
    runState: state.run.value?.state,
    runtimeEventSignal,
    refreshSnapshot: actions.refreshRun,
  });
  const activity = useCodingWorkbenchSafeActivity({
    runId: state.run.value?.runId,
    runState: state.run.value?.state,
    runtimeEventSignal,
  });
  // The active workspace's live root, and whether that binding is still resolving — shared by the
  // headless editor bridge and `CodingWorkbenchChanges` below so a workspace switch mid-run is
  // handled identically by both (workbench audit, 2026-09-03). Each also receives the run's
  // SUBMISSION-time root: the server bound the run to the pointer it read when Start arrived, so a
  // Start whose response lands after a switch must still bind this run to the workspace it was
  // submitted against, never to whatever the pointer names by then (#3381 review).
  const liveWorkspaceRoot = liveWorkspaceRootOf(activeWorkspace);
  const workspaceBindingPending = workspaceBindingPendingOf(activeWorkspace);
  const runBoundRoot = runWorkspace.bound?.root ?? null;
  const editorBridge = useCodingWorkbenchEditorBridge({
    root: liveWorkspaceRoot,
    runId: state.run.value?.runId,
    active: activeRunState(state.run.value?.state),
    bindingPending: workspaceBindingPending,
    submittedRoot: runBoundRoot,
  });
  // Epic #3384 cascade: a run this window observes as a NEW run id — a status poll or stream
  // catching up after a stop, or a run started from another paired client — must not leave the
  // activity feed sitting on "Reconnect activity" until the operator clicks it (or reloads the
  // page). `activity`'s own connection effect already reacts to a `runId` change; this reconnects
  // it EVEN WHEN the feed's projected status is currently a failure/terminal one that would
  // otherwise wait for a manual retry (`useCodingWorkbenchSafeActivity`'s own resync only fires
  // for an ALREADY-known run's runtime events, never for the transition onto a brand new one).
  useReconnectActivityOnNewRun(state.run.value?.runId, activity.retry);
  // The session stream is a bounded scroll region below the header; a run's newest activity lands
  // at its end. Follow that growth while the operator is at the bottom, never yank a reader who
  // scrolled up into the history, and start following again for every new run (#3257 Wave 0).
  const sessionStreamRef = useRef<HTMLDivElement>(null);
  const { onScroll: onStreamScroll, resume: followNewest } = useFollowNewest(
    sessionStreamRef,
    `${String(runtimeEventSignal)}:${activity.feed?.updatedAt ?? ""}:${String(questions.questions.length)}`,
  );
  const runId = state.run.value?.runId;
  useEffect(() => {
    if (runId !== undefined) followNewest();
  }, [followNewest, runId]);
  const journey = useCodingWorkbenchJourney(
    state.run.value?.draftDelivery?.pullRequest !== undefined ? runId : undefined,
  );
  const journeyChanges = useCodingWorkbenchChanges({
    root: liveWorkspaceRoot,
    runId: state.run.value?.runId,
    changeSignal: latestChangesSignal(state.events),
    bindingPending: workspaceBindingPending,
    submittedRoot: runBoundRoot,
  });
  const pausedRun = state.run.value?.state === "paused" ? state.run.value : undefined;
  const resumeMode = selectedResumeMode(
    resumeSelection,
    pausedRun?.runId,
    pausedRun?.effectiveMode,
  );
  const resumeModes = pausedRun?.effectiveMode ? resumableModes(pausedRun.effectiveMode) : [];
  const runIsActive = activeRunState(state.run.value?.state);
  // The composer acts on the bound task workspace, not on the folder selected elsewhere in the
  // Workbench: before a run it names the repository that workspace was bound from, during a run
  // the worktree the run edits. Showing the selected folder next to the bound branch misled the
  // operator about where the run would work (workbench end-to-end run, 2026-09-03).
  //
  // During a run those chips — and the Git target they open — name the RUN's workspace, which the
  // server still holds authority over, not the live pointer: labelling a run in A with B's root and
  // branch, and opening B's Git, invited the operator to act on the wrong tree (#3381 review).
  const repositoryRoot = workbenchRepositoryRoot(
    runIsActive,
    runBoundRoot,
    activeWorkspace,
    selectedRoot,
  );
  const onProposeReady = useMarkReadyPropose(journey.outcome, repositoryRoot);
  const taskComposer = (
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={onTaskIntentChange}
      actions={{
        onStart: () => {
          // Capture the workspace identity the Start is submitted against BEFORE the request goes
          // out: the run id only arrives with the response, by which time the pointer may have moved.
          runWorkspace.captureSubmission();
          if (acceptedIssue === null) void actions.start(taskIntent.trim());
          else
            void actions.start(taskIntent.trim(), {
              issueRef: acceptedIssue.issueRef,
              expectedIssueBindingDigest: acceptedIssue.binding.bindingDigest,
            });
        },
        onPause: () => void actions.pause(),
        onResume: () => {
          if (resumeMode !== null) void actions.resume(resumeMode);
        },
        onSend: () => void actions.submitFollowUp(taskIntent.trim()),
      }}
      canStart={state.canStart}
      runState={state.run.value?.state}
      canResume={resumeMode !== null}
      mutationPending={state.mutation.status === "pending"}
      startBusy={state.mutation.kind === "start" && state.mutation.status === "pending"}
      repositoryLabel={repositoryLabel(repositoryRoot)}
      branchLabel={
        runIsActive
          ? (runWorkspace.bound?.taskBranch ?? activeWorkspace.activeInstance?.taskBranch ?? null)
          : (activeWorkspace.activeInstance?.baseBranch ?? null)
      }
      onOpenGit={() =>
        onOpenGit({
          root: repositoryRoot,
          binding: runIsActive ? "task-workspace" : "repository",
        })
      }
      autonomyMode={confirmedMode(state)}
      autonomyLabel={confirmedModeLabel(state, t)}
      requestedMode={state.requestedMode}
      runtimePreference={state.runtimePreference}
      configurationLocked={
        activeRunState(state.run.value?.state) ||
        state.mutation.status === "pending" ||
        authority.pending
      }
      onRequestedModeChange={authority.onChange}
      onRuntimePreferenceChange={actions.setRuntimePreference}
      models={codingModels}
      selectedModelId={state.selectedModelId}
      reasoningEffort={state.reasoningEffort}
      onSelectedModelChange={actions.setSelectedModel}
      onReasoningEffortChange={actions.setReasoningEffort}
    />
  );
  if (showSetup) {
    return (
      <div className={styles.emptySession}>
        <CodingWorkbenchSetup
          selectedRoot={selectedRoot ?? activeWorkspace.activeInstance?.repositoryRoot}
          refreshWorkspace={async (): Promise<boolean> => {
            const refreshed = await activeWorkspace.refresh();
            if (refreshed) setIssueSetup(false);
            return refreshed;
          }}
          runtimePosture={runtimePosture}
          acceptedIssue={acceptedIssue}
          onAcceptedIssue={setAcceptedIssue}
          onOpenGit={() =>
            onOpenGit({ root: null, binding: "repository", repositoryDialog: "clone" })
          }
        />
      </div>
    );
  }
  const showWelcome =
    welcomeEligibleState(state.run.value?.state) &&
    state.run.value?.verifiedCommitResult === undefined &&
    state.run.value?.draftDelivery === undefined &&
    state.events.length === 0 &&
    activity.feed === null &&
    questions.questions.length === 0 &&
    editorBridge.pendingReview === null &&
    research.grant === null;
  return (
    <div className={styles.session}>
      {showWelcome ? (
        <WorkbenchWelcome />
      ) : (
        <div
          ref={sessionStreamRef}
          className={styles.sessionStream}
          role="log"
          aria-label={t("codingWorkbench.readiness.eventStream.label")}
          onScroll={onStreamScroll}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable log region must be keyboard-focusable (axe scrollable-region-focusable)
          tabIndex={0}
        >
          <PermissionPrompt state={state} research={research} onDecision={onDecision} />
          <CodingWorkbenchCiReadiness snapshot={state.run.value ?? undefined} />
          <CodingWorkbenchDraftDelivery
            snapshot={state.run.value ?? undefined}
            onReviewDescription={(descriptionReview): void => {
              if (repositoryRoot === null) return;
              onOpenGit({
                root: repositoryRoot,
                binding: "task-workspace",
                descriptionReview,
              });
            }}
          />
          <CodingWorkbenchJourneyOutcome
            snapshot={state.run.value ?? undefined}
            outcome={journey.outcome}
            onRefresh={journey.onRefresh}
            changedFiles={changedFilesSummary(journeyChanges)}
            markReadyAvailable={onProposeReady !== undefined}
            {...optionalMarkReadyHandler(onProposeReady)}
          />
          <CodingWorkbenchCommitResult
            result={state.run.value?.verifiedCommitResult}
            runId={runId}
          />
          <ChangesetReviewPanel
            review={editorBridge.pendingReview}
            onApprove={editorBridge.approve}
            onDeny={editorBridge.deny}
            onRetry={editorBridge.retry}
          />
          <RecoveryPanel state={state} taskIntent={taskIntent} actions={actions} />
          <ResearchGrantChip
            grant={research.grant ?? undefined}
            busy={state.mutation.status === "pending"}
            onRevoke={() => {
              if (research.grant !== null) void actions.revokeResearchGrant(research.grant);
            }}
          />
          <Timeline
            events={state.events}
            activity={activity}
            questions={questions}
            focusRef={focusRef}
          />
          <CodingWorkbenchChanges
            root={liveWorkspaceRoot}
            runId={state.run.value?.runId}
            changeSignal={latestChangesSignal(state.events)}
            bindingPending={workspaceBindingPending}
            submittedRoot={runBoundRoot}
            pairing={state.pairing}
          />
        </div>
      )}
      <div className={styles.composerDock}>
        <div className={styles.composerContext}>
          <CodingWorkbenchIssueChip
            accepted={acceptedIssue}
            snapshot={state.run.value}
            onRemove={() => setAcceptedIssue(null)}
          />
          {showWelcome && acceptedIssue === null ? (
            <button
              type="button"
              className={styles.button}
              disabled={state.mutation.status === "pending"}
              onClick={() => setIssueSetup(true)}
            >
              {t("codingWorkbench.issue.title")}
            </button>
          ) : null}
        </div>
        <CodexSubscriptionAuthCard state={state} actions={actions} />
        <RunWorkspaceMismatchNotice visible={runIsActive && runWorkspace.mismatched} />
        <EditorBridgeUnavailableNotice visible={editorBridge.bridgeUnavailable} />
        <RuntimeControls
          state={state}
          actions={actions}
          resumeMode={resumeMode}
          resumeModes={resumeModes}
          onResumeModeChange={(mode): void => {
            if (pausedRun?.runId === undefined || pausedRun.effectiveMode === undefined) return;
            setResumeSelection({
              runId: pausedRun.runId,
              currentMode: pausedRun.effectiveMode,
              value: mode,
            });
          }}
        />
        {taskComposer}
      </div>
    </div>
  );
}

function welcomeEligibleState(state: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    state === undefined ||
    state === "idle" ||
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "taken-over"
  );
}

function repositoryLabel(root: string | null): string | null {
  if (root === null) return null;
  const parts = root.split(/[\\/]/u);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts.at(index);
    if (part !== undefined && part.length > 0) return part;
  }
  return root;
}

function confirmedModeLabel(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  const mode = confirmedMode(state);
  return mode === null ? t("codingWorkbench.mode.unconfirmed") : modeLabel(mode, t);
}

function confirmedMode(state: CodingWorkbenchRuntimeState): CodingWorkbenchMode | null {
  const snapshot = state.run.value;
  return (
    (activeRunState(snapshot?.state)
      ? snapshot?.effectiveMode
      : state.runtime.value?.effectiveMode) ?? null
  );
}

// Single source for "the bootstrap Code setup section is on screen". Two copies of this predicate
// would let the live alert and the setup section disagree about who states a condition.
function bootstrapSetupVisible(
  state: CodingWorkbenchRuntimeState,
  activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"],
): boolean {
  return activeWorkspace.activeBinding === null && state.workspace.value === null;
}

function workspaceContextValue(
  workspace: CodingWorkbenchRuntimeState["workspace"]["value"],
  t: CodingWorkbenchTranslate,
): string {
  if (workspace === null) return t("codingWorkbench.readiness.workspace.none");
  return `${workspace.taskId} · ${workspace.taskBranch} · ${workspace.health}`;
}

function sessionSourceValue(
  source: CodingWorkbenchRuntimeState["source"]["value"],
  t: CodingWorkbenchTranslate,
): string {
  if (source === null) return t("codingWorkbench.readiness.modelSource.select");
  const label = modelSourceLabel(source.modelSource, t);
  return source.available ? label : `${label} — ${t("codingWorkbench.resourceStatus.unavailable")}`;
}

function RuntimeAssuranceContextItem({
  state,
  t,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const posture = useRuntimeAssurancePosture(state);
  const value = t(RUNTIME_ASSURANCE_MESSAGE_KEYS[posture]);
  return (
    <span
      className={styles.contextItem}
      title={value}
      {...(NEUTRAL_RUNTIME_ASSURANCE_POSTURES.has(posture) ? {} : { "data-tone": "warning" })}
    >
      <span className={styles.contextLabel}>{t("codingWorkbench.readiness.runtime.label")}</span>
      <span className={styles.contextValue}>{value}</span>
    </span>
  );
}

// Workbench audit, 2026-09-03: every chip's `title` carries the SAME text as its truncatable
// `.contextValue` — never a different, unrelated string (the workspace chip used to show the raw
// filesystem root here) and never absent (the unbound case used to have none at all) — so a
// sighted low-vision reader can always recover what the CSS ellipsis clipped.
function SessionContextBar({
  state,
  workspace,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  /** The workspace this session is about: the RUN's while one is live, else the live binding's. */
  readonly workspace: CodingWorkbenchWorkspaceProjection | null;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const mode = confirmedMode(state);
  const workspaceValue = workspaceContextValue(workspace, t);
  const sourceValue = sessionSourceValue(state.source.value, t);
  const modeValue = confirmedModeLabel(state, t);
  return (
    <div className={styles.contextBar} aria-label={t("codingWorkbench.header.summary")}>
      <span className={styles.contextItem} title={workspaceValue}>
        <span className={styles.contextLabel}>
          {t("codingWorkbench.readiness.workspace.label")}
        </span>
        <span className={styles.contextValue}>{workspaceValue}</span>
      </span>
      <span className={styles.contextItem} title={sourceValue}>
        <span className={styles.contextLabel}>
          {t("codingWorkbench.readiness.modelSource.label")}
        </span>
        <span className={styles.contextValue}>{sourceValue}</span>
      </span>
      <RuntimeAssuranceContextItem state={state} t={t} />
      <span
        className={styles.contextItem}
        title={modeValue}
        {...(mode === null ? {} : { "data-mode": mode })}
      >
        <span className={styles.contextLabel}>{t("codingWorkbench.mode.eyebrow")}</span>
        <span className={styles.contextValue}>{modeValue}</span>
      </span>
    </div>
  );
}

interface LiveSectionProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
}

interface RuntimeControlsProps extends LiveSectionProps {
  readonly resumeMode: CodingWorkbenchMode | null;
  readonly resumeModes: readonly CodingWorkbenchMode[];
  readonly onResumeModeChange: (mode: CodingWorkbenchMode) => void;
}

function RuntimeControls({
  state,
  actions,
  resumeMode,
  resumeModes,
  onResumeModeChange,
}: RuntimeControlsProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const running = activeRunState(state.run.value?.state);
  const busy = state.mutation.status === "pending";
  if (!running) return null;
  return (
    <div className={styles.runtimeControls} aria-label={t("codingWorkbench.controls.title")}>
      <span>{t("codingWorkbench.controls.help")}</span>
      {state.run.value?.state === "paused" && resumeMode !== null ? (
        <div className={styles.resumeModeControl}>
          <label className={styles.resumeModeLabel} htmlFor="coding-workbench-resume-mode">
            {t("codingWorkbench.controls.resumeMode.label")}
          </label>
          <select
            className={styles.resumeModeSelect}
            id="coding-workbench-resume-mode"
            value={resumeMode}
            disabled={busy}
            aria-describedby="coding-workbench-resume-mode-help"
            onChange={(event): void => {
              if (isCodingWorkbenchMode(event.target.value)) {
                onResumeModeChange(event.target.value);
              }
            }}
          >
            {resumeModes.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode, t)}
              </option>
            ))}
          </select>
          <span className="sr-only" id="coding-workbench-resume-mode-help">
            {t("codingWorkbench.controls.resumeMode.help")}
          </span>
        </div>
      ) : null}
      <div className={styles.inlineActions}>
        <button
          className={cx(styles.button, styles.buttonDanger)}
          type="button"
          disabled={!running || busy}
          onClick={() => void actions.stop()}
        >
          {t("codingWorkbench.controls.stop")}
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={!running || busy}
          onClick={() => void actions.takeover()}
        >
          {t("codingWorkbench.controls.takeover")}
        </button>
      </div>
    </div>
  );
}

/**
 * Whether the evidence THIS request is decided on is loaded and belongs to it (#3381 review).
 *
 * A `file-edit` asks the operator to authorize writes to a set of paths, and a `network-egress` ask
 * authorizes one destination; both travel on their own authenticated channel, so a loading, failed,
 * unpaired or superseded read leaves the card carrying vocabulary — kind, class, risk — and nothing
 * about what would actually happen. Approving there is approving blind, which defeats the review
 * channel and the human-control invariant (ADR-0129 D1), so Approve fails closed until the evidence
 * is READY and its `requestId` binds it to the request on screen. Deny and the channel's own retry
 * stay available — the recovery path is to see the evidence or refuse, never to wave it through.
 */
function approvalEvidenceBound(
  request: CodingWorkbenchRuntimePendingPermission,
  approvalReview: UseCodingWorkbenchApprovalReviewResult,
  research: UseCodingWorkbenchResearchResult,
): boolean {
  if (approvalReviewRequestId(request) !== undefined) {
    const review = approvalReview.status === "ready" ? approvalReview.review : null;
    if (review?.requestId !== request.requestId) return false;
  }
  if (request.kind === "network-egress") {
    const ask = research.status === "ready" ? research.ask : null;
    if (ask?.requestId !== request.requestId) return false;
  }
  return true;
}

function PermissionPrompt({
  state,
  research,
  onDecision,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly research: UseCodingWorkbenchResearchResult;
  readonly onDecision: (decision: CodingWorkbenchRuntimeApprovalDecision) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const request = state.run.value?.pendingPermission;
  // Called before the early return so the hook order is stable; an absent request scopes it to idle.
  const rawApprovalReview = useCodingWorkbenchApprovalReview({
    runId: state.run.value?.runId,
    permissionRequestId: approvalReviewRequestId(request),
  });
  if (request === undefined) return null;
  const approvalReview = reviewForPermission(
    rawApprovalReview,
    request,
    state.run.value ?? undefined,
  );
  const evidenceBound = approvalEvidenceBound(request, approvalReview, research);
  return (
    <section className={cx(styles.card, styles.permission)} aria-labelledby="permission-title">
      <PanelTitle eyebrow={t("codingWorkbench.approval.eyebrow")} id="permission-title">
        {t("codingWorkbench.approval.title")}
      </PanelTitle>
      <ApprovalFacts request={request} t={t} />
      <ApprovalReviewContent kind={request.actionKind} review={approvalReview} t={t} />
      {request.kind === "network-egress" ? <ResearchDestination state={research} t={t} /> : null}
      <p className={styles.helpText}>{t(approvalHelpKey(request.actionKind))}</p>
      <ApprovalDecisionControls
        busy={state.mutation.status === "pending"}
        evidenceBound={evidenceBound}
        onDecision={onDecision}
        t={t}
      />
    </section>
  );
}

function ApprovalReviewContent({
  kind,
  review,
  t,
}: {
  readonly kind: CodingWorkbenchRuntimePendingPermission["actionKind"];
  readonly review: UseCodingWorkbenchApprovalReviewResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <StageReviewDiagnostic
        kind={kind}
        status={review.status}
        fileCount={review.review?.fileCount ?? 0}
      />
      {isDeliveryPermission(kind) ? (
        <CodingWorkbenchDeliveryReview state={review} t={t} />
      ) : (
        <ApprovalChangedFiles state={review} commit={kind === "commit"} t={t} />
      )}
      <CodingWorkbenchCommitReview commit={review.review?.verifiedCommit} t={t} />
    </>
  );
}

/** Ties the disabled Approve button to the note that says why, for a screen reader. */
const APPROVAL_EVIDENCE_NOTE_ID = "coding-workbench-approval-evidence-note";

function ApprovalDecisionControls({
  busy,
  evidenceBound,
  onDecision,
  t,
}: {
  readonly busy: boolean;
  readonly evidenceBound: boolean;
  readonly onDecision: (decision: CodingWorkbenchRuntimeApprovalDecision) => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      {evidenceBound ? null : (
        <output className={styles.helpText} id={APPROVAL_EVIDENCE_NOTE_ID}>
          {t("codingWorkbench.approval.evidenceRequired")}
        </output>
      )}
      <div className={styles.controls}>
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="button"
          disabled={busy || !evidenceBound}
          {...(evidenceBound ? {} : { "aria-describedby": APPROVAL_EVIDENCE_NOTE_ID })}
          onClick={() => onDecision("approved")}
        >
          {t("codingWorkbench.approval.approve")}
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => onDecision("denied")}
        >
          {t("codingWorkbench.approval.deny")}
        </button>
      </div>
    </>
  );
}

/**
 * The one place a Code task's edit tool surfaces a specific diff for explicit confirmation before
 * it is written (mirrors the Editor's own agent-changeset review, ADR-0125 D1 "workspace-contained"
 * high risk): the headless bridge (`useCodingWorkbenchEditorBridge`) only reaches this state when
 * the run's mode requires review, so it must never auto-resolve on its own.
 */
function ChangesetReviewPanel({
  review,
  onApprove,
  onDeny,
  onRetry,
}: {
  readonly review: CodingWorkbenchChangesetReview | null;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (review === null) return null;
  const labels = diffLabels(t);
  const failureCode = review.deliveryFailure?.code;
  return (
    <section
      className={cx(styles.card, styles.permission)}
      aria-labelledby="changeset-review-title"
    >
      <PanelTitle
        eyebrow={t("codingWorkbench.changesetReview.eyebrow")}
        id="changeset-review-title"
      >
        {t("codingWorkbench.changesetReview.title")}
      </PanelTitle>
      <p className={styles.helpText}>{t("codingWorkbench.changesetReview.help")}</p>
      {review.deliveryFailed ? (
        <p className={styles.alert} role="alert" data-decision-failure-code={failureCode}>
          <span aria-hidden="true">!</span> {changesetDeliveryAlert(review.deliveryFailure, t)}
        </p>
      ) : null}
      <div className="rv-body">
        {review.diff.files.length === 0 ? (
          <p className={styles.helpText}>{t("codingWorkbench.changesetReview.empty")}</p>
        ) : (
          review.diff.files.map((file, index) => (
            <DiffFileSection
              key={`${file.path}:${String(index)}`}
              file={file}
              index={index}
              idPrefix="coding-workbench-changeset-review-file"
              sectionRef={() => undefined}
              labels={labels}
            />
          ))
        )}
      </div>
      <div className={styles.controls}>
        {review.deliveryFailed ? (
          <button
            className={cx(styles.button, styles.buttonPrimary)}
            type="button"
            disabled={review.deciding}
            onClick={onRetry}
          >
            {t("codingWorkbench.changesetReview.retry")}
          </button>
        ) : (
          <button
            className={cx(styles.button, styles.buttonPrimary)}
            type="button"
            disabled={review.deciding}
            onClick={onApprove}
          >
            {t("codingWorkbench.changesetReview.approve")}
          </button>
        )}
        <button className={styles.button} type="button" disabled={review.deciding} onClick={onDeny}>
          {t("codingWorkbench.changesetReview.deny")}
        </button>
      </div>
    </section>
  );
}

const APPROVAL_CHANGES_MESSAGE_KEYS = {
  loading: "codingWorkbench.approval.changes.loading",
  unavailable: "codingWorkbench.approval.changes.unavailable",
  retry: "codingWorkbench.approval.changes.retry",
} as const;

const RESEARCH_DESTINATION_MESSAGE_KEYS = {
  loading: "codingWorkbench.approval.research.loading",
  unavailable: "codingWorkbench.approval.research.unavailable",
  retry: "codingWorkbench.approval.research.retry",
} as const;

interface DetailMessageKeys {
  readonly loading: CodingWorkbenchMessageKey;
  readonly unavailable: CodingWorkbenchMessageKey;
  readonly retry: CodingWorkbenchMessageKey;
}

// The props of the SHARED `RetryMessage` (CodingWorkbenchChanges) for an approval detail channel.
// A genuinely UNAVAILABLE read — a transient failure while the approval is still open — is the
// operator's dead end without a retry, because nothing else re-triggers a fetch while they are
// still deciding (workbench audit, 2026-09-03); a LOADING read is not a failure and carries none.
// Only these two facts differ per channel, so the markup itself lives in one component (#3381
// review: this file previously held a second copy of it, `RetryableDetailMessage`).
function detailMessageProps(
  state: {
    readonly status: CodingWorkbenchApprovalReviewStatus | CodingWorkbenchResearchStatus;
    readonly retry: () => void;
  },
  t: CodingWorkbenchTranslate,
  keys: DetailMessageKeys,
): RetryMessageProps {
  return {
    text: t(state.status === "loading" ? keys.loading : keys.unavailable),
    className: styles.approvalResearchDetail,
    ...(state.status === "unavailable"
      ? { retry: { label: t(keys.retry), onRetry: state.retry } }
      : {}),
  };
}

// The reviewable facts of a changeset the operator is deciding about: the counts, the file list,
// and the honest note when the list is truncated. Extracted from `ApprovalChangedFiles` so that
// function stays inside the 50-line budget (AGENTS.md §6) — behaviour unchanged, only moved.
function ApprovalReviewBody({
  review,
  t,
}: {
  readonly review: NonNullable<UseCodingWorkbenchApprovalReviewResult["review"]>;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <dl className={styles.approvalFacts}>
        <ApprovalFact
          label={t("codingWorkbench.approval.changes.files")}
          value={String(review.fileCount)}
        />
        <ApprovalFact
          label={t("codingWorkbench.approval.changes.lines")}
          value={t("codingWorkbench.approval.changes.lineCounts", {
            added: review.addedLines,
            deleted: review.deletedLines,
          })}
        />
      </dl>
      <ul className={styles.approvalChangedFiles}>
        {review.paths.map((path) => (
          <li className={styles.approvalChangedFile} key={path}>
            {path}
          </li>
        ))}
      </ul>
      {review.pathsTruncated ? (
        <p className={styles.approvalResearchDetail}>
          {t("codingWorkbench.approval.changes.truncated", {
            shown: review.paths.length,
            total: review.fileCount,
          })}
        </p>
      ) : null}
    </>
  );
}

/**
 * The reviewable body of a `file-edit` approval (#2802): the workspace-relative files the change
 * would write and its magnitude. Without this the card carries only vocabulary — kind, class, risk
 * — and a human cannot exercise control over a change they are not shown (ADR-0129 D1).
 *
 * The paths arrive over the authenticated approval-review channel and are model-selected: they are
 * rendered as plain text, never as markup or a link, and no patch byte reaches this component.
 */
function ApprovalChangedFiles({
  state,
  commit,
  t,
}: {
  readonly state: UseCodingWorkbenchApprovalReviewResult;
  readonly commit: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (state.status === "idle") return null;
  const review = state.review;
  const title = t(
    commit ? "codingWorkbench.approval.commit.files" : "codingWorkbench.approval.changes.title",
  );
  return (
    <fieldset className={styles.approvalResearch} aria-label={title}>
      <p className={styles.approvalResearchTitle}>{title}</p>
      {review === null ? (
        <RetryMessage {...detailMessageProps(state, t, APPROVAL_CHANGES_MESSAGE_KEYS)} />
      ) : (
        <ApprovalReviewBody review={review} t={t} />
      )}
    </fieldset>
  );
}

/**
 * The destination of a pending research fetch (#2387). Both values are model-chosen and therefore
 * untrusted: they are rendered as plain text nodes, never as markup or as a live link, so reviewing
 * an ask can never itself navigate anywhere. While the read is in flight, or when the window is not
 * paired, the panel says so rather than implying there is no destination.
 */
function ResearchDestination({
  state,
  t,
}: {
  readonly state: UseCodingWorkbenchResearchResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (state.status === "idle") return null;
  const ask = state.ask;
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.research.title")}
    >
      <p className={styles.approvalResearchTitle}>{t("codingWorkbench.approval.research.title")}</p>
      {ask === null ? (
        <RetryMessage {...detailMessageProps(state, t, RESEARCH_DESTINATION_MESSAGE_KEYS)} />
      ) : (
        <dl className={styles.approvalFacts}>
          <ApprovalFact label={t("codingWorkbench.approval.research.host")} value={ask.host} />
          <ApprovalFact
            label={t("codingWorkbench.approval.research.requestLine")}
            value={ask.requestLine}
          />
        </dl>
      )}
    </fieldset>
  );
}

function ApprovalFacts({
  request,
  t,
}: {
  readonly request: CodingWorkbenchRuntimePendingPermission;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <dl className={styles.approvalFacts} aria-label={t("codingWorkbench.approval.facts")}>
      {approvalFacts(request, t).map(({ label, value }) => (
        <ApprovalFact key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

// Workbench audit, 2026-09-03: every enum VALUE on the governance-critical approval screen must be
// localized like every LABEL already is — a raw kebab-case slug ("workspace-write") is an
// untranslated leak onto an otherwise fully-translated surface. `Record<Union, ...>` (not a
// function with a fallback) so a new member of any of these three contract unions fails typecheck
// here instead of silently rendering as English regardless of locale.
const PERMISSION_KIND_MESSAGE_KEYS: Record<
  CodingWorkbenchPermissionRequestKind,
  CodingWorkbenchMessageKey
> = {
  "workspace-write": "codingWorkbench.approval.kind.workspace-write",
  "command-execution": "codingWorkbench.approval.kind.command-execution",
  "network-egress": "codingWorkbench.approval.kind.network-egress",
  "connector-access": "codingWorkbench.approval.kind.connector-access",
  "delivery-substrate": "codingWorkbench.approval.kind.delivery-substrate",
};

const ACTION_CLASS_MESSAGE_KEYS: Record<CodingWorkbenchActionClass, CodingWorkbenchMessageKey> = {
  "workspace-read": "codingWorkbench.approval.actionClass.workspace-read",
  "workspace-write": "codingWorkbench.approval.actionClass.workspace-write",
  "command-execution": "codingWorkbench.approval.actionClass.command-execution",
  verification: "codingWorkbench.approval.actionClass.verification",
  "connector-access": "codingWorkbench.approval.actionClass.connector-access",
  "network-egress": "codingWorkbench.approval.actionClass.network-egress",
  "delivery-substrate": "codingWorkbench.approval.actionClass.delivery-substrate",
};

const APPROVAL_RISK_MESSAGE_KEYS: Record<CodingWorkbenchApprovalRisk, CodingWorkbenchMessageKey> = {
  low: "codingWorkbench.approval.risk.low",
  medium: "codingWorkbench.approval.risk.medium",
  high: "codingWorkbench.approval.risk.high",
  critical: "codingWorkbench.approval.risk.critical",
};

const ACTION_KIND_MESSAGE_KEYS: Record<
  CodingWorkbenchSupervisedActionKind,
  CodingWorkbenchMessageKey
> = {
  "file-edit": "codingWorkbench.approval.actionKind.file-edit",
  "git-stage": "codingWorkbench.approval.actionKind.git-stage",
  "verification-command": "codingWorkbench.approval.actionKind.verification-command",
  research: "codingWorkbench.approval.actionKind.research",
  commit: "codingWorkbench.approval.actionKind.commit",
  push: "codingWorkbench.approval.actionKind.push",
  "pull-request": "codingWorkbench.approval.actionKind.pull-request",
  merge: "codingWorkbench.approval.actionKind.merge",
  "connector-write": "codingWorkbench.approval.actionKind.connector-write",
  "external-write": "codingWorkbench.approval.actionKind.external-write",
  "system-mutation": "codingWorkbench.approval.actionKind.system-mutation",
};

const POLICY_REASON_MESSAGE_KEYS: Record<
  CodingWorkbenchSupervisedPolicyReason,
  CodingWorkbenchMessageKey
> = {
  "scoped-file-edit": "codingWorkbench.approval.policyReason.scoped-file-edit",
  "out-of-scope-file-edit": "codingWorkbench.approval.policyReason.out-of-scope-file-edit",
  "allowlisted-verification-command":
    "codingWorkbench.approval.policyReason.allowlisted-verification-command",
  "unknown-command-denied": "codingWorkbench.approval.policyReason.unknown-command-denied",
  "mutating-command-denied": "codingWorkbench.approval.policyReason.mutating-command-denied",
  "approval-required": "codingWorkbench.approval.policyReason.approval-required",
  "approval-proof-missing": "codingWorkbench.approval.policyReason.approval-proof-missing",
  "approval-proof-stale": "codingWorkbench.approval.policyReason.approval-proof-stale",
  "approval-proof-accepted": "codingWorkbench.approval.policyReason.approval-proof-accepted",
  "operator-denied": "codingWorkbench.approval.policyReason.operator-denied",
  "operator-stopped": "codingWorkbench.approval.policyReason.operator-stopped",
  "redacted-failure": "codingWorkbench.approval.policyReason.redacted-failure",
};

const CONNECTOR_SCOPE_MESSAGE_KEYS: Record<
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMessageKey
> = {
  "source-control.read": "codingWorkbench.approval.connectorScope.source-control.read",
  "source-control.write": "codingWorkbench.approval.connectorScope.source-control.write",
  "issue-tracker.read": "codingWorkbench.approval.connectorScope.issue-tracker.read",
  "issue-tracker.write": "codingWorkbench.approval.connectorScope.issue-tracker.write",
  "knowledge-base.read": "codingWorkbench.approval.connectorScope.knowledge-base.read",
  "knowledge-base.write": "codingWorkbench.approval.connectorScope.knowledge-base.write",
};

// An optional closed-union fact, localized when present.
function optionalFact<K extends string>(
  value: K | undefined,
  keys: Readonly<Record<K, CodingWorkbenchMessageKey>>,
  fallback: string,
  t: CodingWorkbenchTranslate,
): string {
  return value === undefined ? fallback : t(keys[value]);
}

function approvalFacts(
  request: CodingWorkbenchRuntimePendingPermission,
  t: CodingWorkbenchTranslate,
): readonly { readonly label: string; readonly value: string }[] {
  const notSpecified = t("codingWorkbench.approval.notSpecified");
  return [
    {
      label: t("codingWorkbench.approval.permissionKind"),
      value: t(PERMISSION_KIND_MESSAGE_KEYS[request.kind]),
    },
    {
      label: t("codingWorkbench.approval.actionClass"),
      value: t(ACTION_CLASS_MESSAGE_KEYS[request.actionClass]),
    },
    {
      label: t("codingWorkbench.approval.action"),
      value: optionalFact(request.actionKind, ACTION_KIND_MESSAGE_KEYS, notSpecified, t),
    },
    { label: t("codingWorkbench.approval.scope"), value: request.scopeLabel ?? notSpecified },
    {
      label: t("codingWorkbench.approval.commandClass"),
      value: request.commandLabel ?? t("codingWorkbench.approval.notApplicable"),
    },
    {
      label: t("codingWorkbench.approval.connectorScopes"),
      value:
        (request.connectorScopes ?? [])
          .map((scope) => t(CONNECTOR_SCOPE_MESSAGE_KEYS[scope]))
          .join(", ") || t("codingWorkbench.approval.noneRequested"),
    },
    {
      label: t("codingWorkbench.approval.risk"),
      value: optionalFact(
        request.risk,
        APPROVAL_RISK_MESSAGE_KEYS,
        t("codingWorkbench.approval.unspecified"),
        t,
      ),
    },
    {
      label: t("codingWorkbench.approval.policyReason"),
      value: optionalFact(request.policyReason, POLICY_REASON_MESSAGE_KEYS, notSpecified, t),
    },
    { label: t("codingWorkbench.approval.reasonCode"), value: request.reasonCode },
    { label: t("codingWorkbench.approval.expires"), value: request.expiresAt },
  ];
}

function ApprovalFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className={styles.approvalFact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RecoveryPanel({
  state,
  taskIntent,
  actions,
}: LiveSectionProps & { readonly taskIntent: string }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const snapshot = state.run.value;
  if (snapshot?.state !== "recovery-required") return null;
  const busy = state.mutation.status === "pending";
  return (
    <section className={cx(styles.card, styles.recovery)} aria-labelledby="recovery-title">
      <PanelTitle eyebrow={t("codingWorkbench.recovery.eyebrow")} id="recovery-title">
        {t("codingWorkbench.recovery.title")}
      </PanelTitle>
      <p className={styles.summary}>{t("codingWorkbench.recovery.summary")}</p>
      {snapshot.recoveryAcknowledged === true ? (
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="button"
          disabled={busy || !state.canRetry || taskIntent.trim().length === 0}
          onClick={() => void actions.retry(taskIntent)}
        >
          {t("codingWorkbench.recovery.retry")}
        </button>
      ) : (
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => void actions.acknowledgeRecovery()}
        >
          {t("codingWorkbench.recovery.acknowledge")}
        </button>
      )}
    </section>
  );
}
