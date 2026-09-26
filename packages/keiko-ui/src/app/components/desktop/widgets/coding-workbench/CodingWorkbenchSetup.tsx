"use client";

// Task-workspace setup for the Coding Workbench. The repository is selected inside this card
// from Git's registered checkouts. This card provisions a managed workspace,
// runs the #447
// reconciliation pass that stamps the verified head the runtime launch authority requires (#2476:
// provisioning alone leaves `lastVerifiedHead` unstamped, so a hand-bound repo was previously
// unstartable without an out-of-band API call), and only then set it as the active binding (#446) and
// refresh the shared active-workspace context so the task-start flow unlocks. Reconciliation progress
// and failure surface as bounded, content-free states with an in-place retry; a workspace that
// reconciliation cannot verify is NEVER activated, so the run stays unstartable (#2476 AC3).
//
// A refused bind names its actual cause. The server's structured failure codes map to distinct
// operator sentences (a base branch that does not resolve, an unavailable repository, a held lock,
// an installation without managed workspaces), and a refusal of the EXISTING managed workspace for
// this repository and branch (POINTER_DRIFT) surfaces the persisted finding together with the one
// executable exit: an operator-approved repair through the #447 route, followed by the same
// verify-then-activate sequence a fresh bind runs. Before that, every one of these read "review the
// repository path and target branch" — a sentence about the wrong thing — and the refused row had no
// exit in the product (2026-09-03 dev log). The target branch comes from the same setup form.

import {
  useRepositoryBranchState,
  type RepositoryBranchState,
} from "../../hooks/useRepositoryBranchState";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type {
  CodingWorkbenchIssueBindingFailure,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import {
  bindVerifiedTaskWorkspace,
  repairAndBindVerifiedTaskWorkspace,
  type VerifiedTaskWorkspaceBindFailure,
  type VerifiedTaskWorkspaceBindInput,
  type VerifiedTaskWorkspaceRepairOffer,
} from "@/lib/verified-task-workspace-binding";
import { TASK_WORKSPACE_MARKER_MESSAGE_KEYS } from "@/lib/task-workspace-marker-labels";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { repositorySelectable } from "./codingWorkbenchRepositories";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { secureRandomId } from "@/lib/secure-random";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import { cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";
// The opaque single-operator actor identity, mirroring useActiveWorkspaceState. The server treats
// it as an opaque id only — never a credential.
const STUDIO_OPERATOR = "studio-operator";

type SetupPhase = "binding" | "repairing" | "verifying";
type SetupErrorReason =
  | CodingWorkbenchIssueBindingFailure
  | "bind"
  | "refresh"
  | "verify"
  | "branch-conflict"
  | "invalid-base-branch"
  | "invalid-request"
  | "missing-repository"
  | "repository-not-connected"
  | "repository-catalog-unavailable"
  | "unsafe-path"
  | "lock-contention"
  | "provisioning-failed"
  | "unavailable"
  | "repair-required"
  | "operator-required"
  | "repair-failed";
type SetupError = {
  readonly kind: "error";
  readonly reason: SetupErrorReason;
  // The refused workspace and what the server can do about it, when the failure named one.
  readonly repair?: VerifiedTaskWorkspaceRepairOffer | undefined;
};
type SetupStatus =
  { readonly kind: "idle" } | { readonly kind: "pending"; readonly phase: SetupPhase } | SetupError;

export interface CodingWorkbenchSetupProps {
  readonly repositoryControls?: ReactNode;
  // Selected from Git's registered local repositories. It becomes execution authority only after
  // the existing provision → verify → activate flow succeeds.
  readonly selectedRoot: string | undefined;
  // The branch chosen in the adjacent control, or the bound task workspace's base branch.
  readonly selectedBaseBranch?: string | undefined;
  // ActiveWorkspaceApi.refresh from the shared context — re-reads the active binding after the
  // workbench-initiated bind so every bound surface flips to the new workspace atomically.
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly onBoundRepository?: ((root: string) => void) | undefined;
  // The honest pre-activation posture. "unavailable" only once readiness has RESOLVED as
  // unavailable, "evaluation" once it has resolved as available over an unverified evaluation
  // runtime, "verified" once it has resolved as a platform-qualified runtime, and "pending" while
  // nothing has resolved yet — this card shows no note for "pending", so neither note flashes
  // during the initial load. The bootstrap section is the FIRST screen a fresh evaluation install
  // shows, so a clean form here would imply a verified runtime (ADR-0163 D9).
  readonly runtimePosture: CodingWorkbenchSetupRuntimePosture;
}

// "pending" is a real state, not a stand-in for "verified": before the first readiness read
// resolves, nothing has been verified, and a placeholder of "verified" made the header chip claim
// "Platform-verified — signed and notarized runtime" on every open and every remount, indefinitely
// on a hanging read (#3381 review).
export type CodingWorkbenchSetupRuntimePosture =
  "pending" | "unavailable" | "evaluation" | "verified";

// Strips a run of leading and/or trailing "-" characters. Plain index scanning instead of a
// regex (SonarCloud S8786 flagged /^-+|-+$/gu, an alternation of two unbounded quantifiers) —
// this can't backtrack at all and is the clearest way to express "trim this one character".
// Exported only so the ReDoS regression test below can exercise it directly with a raw
// dash-only input; codingWorkbenchSetupTaskId's own pipeline never hands it more than one
// leading/trailing "-" (the preceding replaceAll already collapses any non-alnum run to one).
export function stripLeadingAndTrailingDashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charAt(start) === "-") start += 1;
  let end = value.length;
  while (end > start && value.charAt(end - 1) === "-") end -= 1;
  return value.slice(start, end);
}

// Content-free, deterministic task id for a workbench-initiated binding. Derived from the target
// branch so re-binding the same branch idempotently resumes the same managed workspace (#445).
export function codingWorkbenchSetupTaskId(targetBranch: string): string {
  const slug = stripLeadingAndTrailingDashes(
    targetBranch.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"),
  );
  return slug.length === 0 ? "coding-workbench" : `coding-workbench-${slug}`;
}

// The server's structured codes that have a distinct operator remedy on this surface. Anything
// else stays the bounded generic sentence, which is honest for an unclassified failure.
const REASON_BY_CODE: Readonly<Partial<Record<string, SetupErrorReason>>> = {
  "invalid-reference": "invalid-reference",
  "repository-mismatch": "repository-mismatch",
  "auth-required": "auth-required",
  "issue-unavailable": "issue-unavailable",
  "clone-failed": "clone-failed",
  "authority-denied": "authority-denied",
  cancelled: "cancelled",
  INVALID_BASE_BRANCH: "invalid-base-branch",
  // The server refused the request's own shape before touching git, in practice a branch name
  // outside its supported characters. The generic sentence sent the operator to "review" a branch
  // that exists and is spelled correctly (field defect 1.1.1: `feat(GDZ-917)/...`).
  INVALID_REQUEST: "invalid-request",
  MISSING_REPOSITORY: "missing-repository",
  UNSAFE_PATH: "unsafe-path",
  LOCK_CONTENTION: "lock-contention",
  // The server accepted the repository path and target branch and then could not create the managed
  // worktree (or its identity) itself — the generic "review the repository path and target branch"
  // sentence sent the operator after two inputs that were fine (2026-09-10, a trusted repository's
  // bind that failed inside script-trust derivation). The cause lives in the activity log.
  PROVISIONING_FAILED: "provisioning-failed",
  WORKSPACE_PROVISIONING_UNAVAILABLE: "unavailable",
};

// A refused EXISTING workspace: repairable in place when reconciliation recommended an automatic
// strategy, otherwise an operator has to look first. A repair that itself errored (a held lock, a
// state that moved underneath it) is neither.
function repairReason(failure: VerifiedTaskWorkspaceBindFailure): SetupErrorReason {
  if ((failure.repair?.strategy ?? null) !== null) return "repair-required";
  if (failure.repair !== undefined) return "operator-required";
  if (failure.code === "LOCK_CONTENTION") return "lock-contention";
  return failure.stage === "repair" ? "repair-failed" : "operator-required";
}

function setupErrorReason(failure: VerifiedTaskWorkspaceBindFailure): SetupErrorReason {
  if (failure.issueBindingFailure !== undefined) return failure.issueBindingFailure;
  if (failure.stage === "verify") return "verify";
  if (failure.reason === "branch-conflict" && failure.failureClass === "blocked") {
    return "branch-conflict";
  }
  if (failure.code === "POINTER_DRIFT" || failure.stage === "repair") return repairReason(failure);
  const mapped = failure.code === undefined ? undefined : REASON_BY_CODE[failure.code];
  return mapped ?? "bind";
}

function failureStatus(failure: VerifiedTaskWorkspaceBindFailure): SetupError {
  return { kind: "error", reason: setupErrorReason(failure), repair: failure.repair };
}

// The bound workspace becomes the surfaces' truth only through the shared context refresh; a
// refresh that does not settle (a newer operation superseded it) or fails leaves the setup surface
// in place with a bounded retry, diagnosable in the console.
//
// Its own reason, never `bind`: everything the server owns — provision, repair, reconcile, activate
// — has COMPLETED by the time this runs, so "The workspace could not be bound. Review the
// repository path and target branch." is the exact sentence this change exists to stop showing
// (#3381 review). A rapid folder switch or an overlapping bind is how an operator reaches it.
async function settleBoundWorkspace(
  refreshWorkspace: () => Promise<boolean>,
  root: string,
  onBoundRepository?: (root: string) => void,
): Promise<SetupStatus> {
  try {
    if (await refreshWorkspace()) {
      onBoundRepository?.(root);
      return { kind: "idle" };
    }
    reportClientDiagnostic("[keiko] coding workbench workspace refresh did not settle");
  } catch (error) {
    reportClientDiagnostic(
      `[keiko] coding workbench workspace refresh failed: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
  }
  return { kind: "error", reason: "refresh" };
}

interface BindInput {
  readonly root: string;
  readonly baseBranch: string;
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly onBoundRepository?: ((root: string) => void) | undefined;
  readonly onPhase: (phase: SetupPhase) => void;
  readonly collisionSuffix: string;
}

// Drive provision → reconcile → activate as one operator action. `onPhase` advances the surfaced
// pending phase from binding to verifying; every server error maps to a bounded outcome.
async function executeBind(input: BindInput): Promise<SetupStatus> {
  try {
    if (!(await repositorySelectable(input.root))) {
      return { kind: "error", reason: "repository-not-connected" };
    }
  } catch (error) {
    reportClientDiagnostic(
      `[keiko] coding workbench repository validation failed: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
    return { kind: "error", reason: "repository-catalog-unavailable" };
  }
  const request = setupBindRequest(input);
  let result = await bindVerifiedTaskWorkspace(request);
  if (!result.ok && result.stage === "provision" && result.code === "BRANCH_CONFLICT") {
    reportClientDiagnostic(
      "[keiko] coding workbench task branch collision; creating separate task",
    );
    result = await bindVerifiedTaskWorkspace({
      ...request,
      taskId: `${request.taskId.slice(0, 80)}-${input.collisionSuffix}`,
    });
  }
  if (!result.ok) return failureStatus(result);
  return settleBoundWorkspace(input.refreshWorkspace, input.root, input.onBoundRepository);
}

function setupBindRequest(input: BindInput): VerifiedTaskWorkspaceBindInput {
  return {
    root: input.root,
    taskId: codingWorkbenchSetupTaskId(input.baseBranch),
    baseBranch: input.baseBranch,
    requestedBy: STUDIO_OPERATOR,
    onProvisioned: (): void => {
      input.onPhase("verifying");
    },
  };
}

interface RepairInput extends Omit<BindInput, "baseBranch" | "collisionSuffix"> {
  readonly workspaceId: string;
  readonly strategy: NonNullable<VerifiedTaskWorkspaceRepairOffer["strategy"]>;
}

// The operator's click on the named repair IS the approval the #447 route requires; the sequence
// then verifies and activates exactly as a fresh bind does.
async function executeRepairAndBind(input: RepairInput): Promise<SetupStatus> {
  const result = await repairAndBindVerifiedTaskWorkspace({
    root: input.root,
    workspaceId: input.workspaceId,
    strategy: input.strategy,
    requestedBy: STUDIO_OPERATOR,
    onRepaired: () => {
      input.onPhase("verifying");
    },
  });
  if (!result.ok) return failureStatus(result);
  return settleBoundWorkspace(input.refreshWorkspace, input.root, input.onBoundRepository);
}

// A sequence that rejects outside its own bounded outcomes is a defect, not an operator state; it
// still settles the surface (never a stuck "Binding…") and leaves a diagnosable line.
function settleOutcome(
  outcome: Promise<SetupStatus>,
  setStatus: (status: SetupStatus) => void,
): void {
  outcome.then(setStatus, (error: unknown) => {
    reportClientDiagnostic(
      `[keiko] coding workbench bind sequence rejected: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
    setStatus({ kind: "error", reason: "bind" });
  });
}

interface SetupActions {
  readonly onSubmit: (event: { preventDefault: () => void }) => void;
  readonly onRepair: () => void;
}

// One operator action, together with the exact selection it was started for. A sequence may
// only write to the card while its own attempt is still the current one.
interface SetupAttempt {
  readonly id: number;
  readonly repositoryPath: string;
  readonly targetBranch: string;
}

// Publishes a status only while `attempt` is still the card's current attempt.
type SetupPublish = (status: SetupStatus) => void;

// A refusal and its repair offer belong to both the repository and branch. Selection may change
// while a bind is pending, so an old result must not publish into the new context.
//
// So every attempt carries an id plus the inputs it was started for; a change to either abandons
// it — nothing it publishes afterwards is applied — and returns the card to idle. The abandoned
// sequence still runs to completion on the server, and `settleBoundWorkspace` still refreshes the
// shared context: a workspace the server DID activate must reach the bound surfaces, whatever the
// card now shows.
function useSetupAttempt(params: {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly setStatus: Dispatch<SetStateAction<SetupStatus>>;
}): { readonly start: () => SetupPublish } {
  const { repositoryPath, targetBranch, setStatus } = params;
  const attemptRef = useRef<SetupAttempt | null>(null);
  const attemptSeqRef = useRef(0);
  useEffect(() => {
    const attempt = attemptRef.current;
    if (attempt === null) return;
    if (attempt.repositoryPath === repositoryPath && attempt.targetBranch === targetBranch) return;
    attemptRef.current = null;
    setStatus((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, [repositoryPath, targetBranch, setStatus]);
  const start = useCallback((): SetupPublish => {
    const id = (attemptSeqRef.current += 1);
    attemptRef.current = { id, repositoryPath, targetBranch };
    return (status: SetupStatus): void => {
      if (attemptRef.current?.id !== id) return;
      setStatus(status);
    };
  }, [repositoryPath, targetBranch, setStatus]);
  return { start };
}

interface SetupActionsInput {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly onBoundRepository?: ((root: string) => void) | undefined;
  readonly status: SetupStatus;
  readonly setStatus: Dispatch<SetStateAction<SetupStatus>>;
  readonly branchAvailable: boolean;
}

function useSetupActions(params: SetupActionsInput): SetupActions {
  const { repositoryPath, targetBranch, refreshWorkspace, onBoundRepository, status, setStatus } =
    params;
  const root = repositoryPath.trim();
  const pending = status.kind === "pending";
  const [collisionSuffix] = useState(() => secureRandomId("task"));
  const attempt = useSetupAttempt({ repositoryPath, targetBranch, setStatus });
  const onSubmit = setupSubmitAction(params, attempt.start, collisionSuffix);
  const onRepair = (): void => {
    const offer = status.kind === "error" ? status.repair : undefined;
    const strategy = offer?.strategy ?? null;
    if (pending || root === "" || offer === undefined || strategy === null) return;
    const publish = attempt.start();
    publish({ kind: "pending", phase: "repairing" });
    settleOutcome(
      executeRepairAndBind({
        root,
        workspaceId: offer.workspaceId,
        strategy,
        refreshWorkspace,
        onBoundRepository,
        onPhase: phaseReporter(publish),
      }),
      publish,
    );
  };
  return { onSubmit, onRepair };
}

function setupSubmitAction(
  params: SetupActionsInput,
  start: () => SetupPublish,
  collisionSuffix: string,
): SetupActions["onSubmit"] {
  const { repositoryPath, targetBranch, refreshWorkspace, onBoundRepository, status } = params;
  const root = repositoryPath.trim();
  const baseBranch = targetBranch.trim();
  const pending = status.kind === "pending";
  return (event): void => {
    event.preventDefault();
    if (pending || root === "" || baseBranch === "") return;
    // The same branch inventory drives the visible selector and this bind gate.
    if (!params.branchAvailable) return;
    const publish = start();
    publish({ kind: "pending", phase: "binding" });
    settleOutcome(
      executeBind({
        root,
        baseBranch,
        refreshWorkspace,
        onBoundRepository,
        collisionSuffix,
        onPhase: phaseReporter(publish),
      }),
      publish,
    );
  };
}

// The phase of an abandoned attempt is as stale as its outcome: it would re-disable the fields and
// claim "Verifying…" for inputs the card has already moved off.
function phaseReporter(publish: SetupPublish): (phase: SetupPhase) => void {
  return (phase: SetupPhase): void => {
    publish({ kind: "pending", phase });
  };
}

// The failure reasons whose sentence needs no interpolation.
const PLAIN_ALERT_KEYS: Readonly<Partial<Record<SetupErrorReason, CodingWorkbenchMessageKey>>> = {
  "invalid-reference": "codingWorkbench.issue.error.invalid-reference",
  "repository-mismatch": "codingWorkbench.issue.error.repository-mismatch",
  "auth-required": "codingWorkbench.issue.error.auth-required",
  "issue-unavailable": "codingWorkbench.issue.error.issue-unavailable",
  "clone-failed": "codingWorkbench.issue.error.clone-failed",
  "authority-denied": "codingWorkbench.issue.error.authority-denied",
  cancelled: "codingWorkbench.issue.error.cancelled",
  refresh: "codingWorkbench.setup.boundRefreshFailed",
  verify: "codingWorkbench.setup.reconcileFailed",
  "branch-conflict": "codingWorkbench.setup.branchConflict",
  "invalid-base-branch": "codingWorkbench.setup.invalidBaseBranch",
  "invalid-request": "codingWorkbench.setup.invalidRequest",
  "missing-repository": "codingWorkbench.setup.missingRepository",
  "repository-not-connected": "codingWorkbench.setup.repositoryNotConnected",
  "repository-catalog-unavailable": "codingWorkbench.setup.repositoryCatalogUnavailable",
  "unsafe-path": "codingWorkbench.setup.unsafePath",
  "lock-contention": "codingWorkbench.setup.lockContention",
  "provisioning-failed": "codingWorkbench.setup.provisioningFailed",
  unavailable: "codingWorkbench.setup.provisioningUnavailable",
  "repair-failed": "codingWorkbench.setup.repairFailed",
};

// The primary persisted finding of a refused workspace, in the same words the Task Workspace
// manager uses for the same marker.
function findingLabel(
  repair: VerifiedTaskWorkspaceRepairOffer | undefined,
  t: CodingWorkbenchTranslate,
  tGlobal: I18nTranslate,
): string {
  const marker = repair?.driftMarkers[0];
  return marker === undefined
    ? t("codingWorkbench.setup.findingUnknown")
    : tGlobal(TASK_WORKSPACE_MARKER_MESSAGE_KEYS[marker]);
}

const GENERIC_REPAIR_EFFECT_KEY = "codingWorkbench.setup.repairEffect.generic";

// What Repair will actually DO, keyed on the strategy the server recommended. A single sentence
// could not be honest here: `automaticStrategyOf` returns `recreate-worktree` first for a missing
// worktree, and the server's repair then prunes the stale registration and rebuilds it, so the
// original "nothing is deleted" promise was true only on the `reconcile-pointer` path (#3381
// review). TOTAL over the contract union, not partial with a fallback: a new recovery strategy then
// fails typecheck here instead of silently rendering the neutral sentence. The four strategies a
// repair offer never carries (they all require an operator first, so `repairReason` classifies them
// as `operator-required` and this table is never consulted for them) map to that neutral sentence.
const REPAIR_EFFECT_KEYS: Readonly<Record<WorkspaceRecoveryStrategy, CodingWorkbenchMessageKey>> = {
  "reconcile-pointer": "codingWorkbench.setup.repairEffect.reconcilePointer",
  "recreate-worktree": "codingWorkbench.setup.repairEffect.recreateWorktree",
  "release-stale-lock": "codingWorkbench.setup.repairEffect.releaseStaleLock",
  "accept-moved-head": "codingWorkbench.setup.repairEffect.acceptMovedHead",
  "reattach-branch": GENERIC_REPAIR_EFFECT_KEY,
  "commit-or-stash-required": GENERIC_REPAIR_EFFECT_KEY,
  "operator-repair": GENERIC_REPAIR_EFFECT_KEY,
  "abandon-and-cleanup": GENERIC_REPAIR_EFFECT_KEY,
};

function repairEffectLabel(
  repair: VerifiedTaskWorkspaceRepairOffer | undefined,
  t: CodingWorkbenchTranslate,
): string {
  const strategy = repair?.strategy ?? null;
  return t(strategy === null ? GENERIC_REPAIR_EFFECT_KEY : REPAIR_EFFECT_KEYS[strategy]);
}

function alertMessage(
  status: SetupError,
  t: CodingWorkbenchTranslate,
  tGlobal: I18nTranslate,
): string {
  const plain = PLAIN_ALERT_KEYS[status.reason];
  if (plain !== undefined) return t(plain);
  const finding = findingLabel(status.repair, t, tGlobal);
  if (status.reason === "repair-required") {
    return t("codingWorkbench.setup.repairRequired", {
      finding,
      effect: repairEffectLabel(status.repair, t),
    });
  }
  if (status.reason === "operator-required") {
    return t("codingWorkbench.setup.operatorRequired", { finding });
  }
  return t("codingWorkbench.alert.workspaceBindFailed");
}

const PHASE_LABEL_KEYS: Readonly<Record<SetupPhase, CodingWorkbenchMessageKey>> = {
  binding: "codingWorkbench.setup.binding",
  repairing: "codingWorkbench.setup.repairing",
  verifying: "codingWorkbench.setup.verifying",
};

function submitLabel(status: SetupStatus, t: CodingWorkbenchTranslate): string {
  return status.kind === "pending"
    ? t(PHASE_LABEL_KEYS[status.phase])
    : t("codingWorkbench.setup.submit");
}

function SetupNotices({
  runtimePosture,
  status,
  t,
}: {
  readonly runtimePosture: CodingWorkbenchSetupRuntimePosture;
  readonly status: SetupStatus;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const tGlobal = useTranslate();
  return (
    <>
      {runtimePosture === "unavailable" ? (
        <p className={styles.boundaryNote} data-testid="coding-workbench-setup-runtime-note">
          {t("codingWorkbench.setup.runtimeUnavailable")}
        </p>
      ) : null}
      {runtimePosture === "evaluation" ? (
        <p
          className={styles.boundaryNote}
          data-testid="coding-workbench-setup-runtime-evaluation-note"
        >
          {t("codingWorkbench.setup.runtimeEvaluation")}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className={styles.alert} role="alert" id="coding-workbench-setup-alert">
          <span aria-hidden="true">!</span> {alertMessage(status, t, tGlobal)}
        </p>
      ) : null}
    </>
  );
}

function repairOffered(status: SetupStatus): boolean {
  return status.kind === "error" && (status.repair?.strategy ?? null) !== null;
}

function SetupActionRow({
  status,
  submitDisabled,
  onRepair,
  t,
}: {
  readonly status: SetupStatus;
  readonly submitDisabled: boolean;
  readonly onRepair: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles.setupActions}>
      <button
        className={cx(styles.button, styles.buttonPrimary)}
        type="submit"
        disabled={submitDisabled}
        aria-describedby="coding-workbench-setup-help"
      >
        {submitLabel(status, t)}
      </button>
      {repairOffered(status) ? (
        <button
          className={styles.button}
          type="button"
          onClick={onRepair}
          aria-describedby="coding-workbench-setup-alert"
        >
          {t("codingWorkbench.setup.repairAndBind")}
        </button>
      ) : null}
    </div>
  );
}

function useSetupStatus(): readonly [SetupStatus, Dispatch<SetStateAction<SetupStatus>>, boolean] {
  const [status, setStatus] = useState<SetupStatus>({ kind: "idle" });
  return [status, setStatus, status.kind === "pending"];
}

function targetBranchAvailable(branches: RepositoryBranchState, value: string): boolean {
  return (
    !branches.loading &&
    branches.error === null &&
    branches.branches.some((branch) => branch.name === value)
  );
}

export function CodingWorkbenchSetup({
  repositoryControls,
  selectedRoot,
  selectedBaseBranch,
  refreshWorkspace,
  onBoundRepository,
  runtimePosture,
}: CodingWorkbenchSetupProps): ReactNode {
  const repositoryPath = selectedRoot ?? "";
  const branches = useRepositoryBranchState(repositoryPath.trim() || null);
  const targetBranch = selectedBaseBranch ?? branches.currentBranch ?? "";
  const branchAvailable = targetBranchAvailable(branches, targetBranch);
  const [status, setStatus, pending] = useSetupStatus();
  const actions = useSetupActions({
    repositoryPath,
    targetBranch,
    refreshWorkspace,
    onBoundRepository,
    status,
    setStatus,
    branchAvailable,
  });

  return (
    <SetupCard
      repositoryControls={repositoryControls}
      repositoryPath={repositoryPath}
      targetBranch={targetBranch}
      branches={branches}
      pending={pending}
      runtimePosture={runtimePosture}
      status={status}
      actions={actions}
    />
  );
}

interface SetupCardProps {
  readonly repositoryControls: ReactNode;
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly branches: RepositoryBranchState;
  readonly pending: boolean;
  readonly runtimePosture: CodingWorkbenchSetupRuntimePosture;
  readonly status: SetupStatus;
  readonly actions: SetupActions;
}

function SetupCard(props: SetupCardProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <section className={styles.card} aria-label={t("codingWorkbench.setup.title")}>
      <PanelTitle eyebrow={t("codingWorkbench.setup.eyebrow")} id="coding-workbench-setup-title">
        {t("codingWorkbench.setup.title")}
      </PanelTitle>
      <SetupNotices runtimePosture={props.runtimePosture} status={props.status} t={t} />
      <form onSubmit={props.actions.onSubmit}>
        {props.repositoryControls}
        <p id="coding-workbench-setup-help" className={styles.helpText}>
          {t("codingWorkbench.setup.help")}
        </p>
        <SetupActionRow
          status={props.status}
          submitDisabled={setupCardSubmitBlocked(props)}
          onRepair={props.actions.onRepair}
          t={t}
        />
      </form>
    </section>
  );
}

function setupCardSubmitBlocked(props: SetupCardProps): boolean {
  return (
    props.pending ||
    props.repositoryPath.trim() === "" ||
    !targetBranchAvailable(props.branches, props.targetBranch)
  );
}
