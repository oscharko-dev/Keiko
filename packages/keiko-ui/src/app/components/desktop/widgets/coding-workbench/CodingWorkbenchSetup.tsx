"use client";

// Minimal Code setup for the Coding Workbench (Issues #2385, #2476). Rendered whenever no active
// task-workspace binding exists — INCLUDING on an installation where the coding runtime is not yet
// activatable, so the surface stays reachable and honestly explains why a run cannot start instead of
// disappearing (#2476 AC4). It binds an EXISTING local Git checkout end to end in one operator action:
// provision a managed task workspace from the entered repository root (#445), run the #447
// reconciliation pass that stamps the verified head the runtime launch authority requires (#2476:
// provisioning alone leaves `lastVerifiedHead` unstamped, so a hand-bound repo was previously
// unstartable without an out-of-band API call), and only then set it as the active binding (#446) and
// refresh the shared active-workspace context so the task-start flow unlocks. Reconciliation progress
// and failure surface as bounded, content-free states with an in-place retry; a workspace that
// reconciliation cannot verify is NEVER activated, so the run stays unstartable (#2476 AC3).
//
// A refused bind names its actual cause. The server's structured failure codes map to distinct
// operator sentences (a base branch that does not resolve, a path outside a repository, a held lock,
// an installation without managed workspaces), and a refusal of the EXISTING managed workspace for
// this repository and branch (POINTER_DRIFT) surfaces the persisted finding together with the one
// executable exit: an operator-approved repair through the #447 route, followed by the same
// verify-then-activate sequence a fresh bind runs. Before that, every one of these read "review the
// repository path and target branch" — a sentence about the wrong thing — and the refused row had no
// exit in the product (2026-09-03 dev log). The target branch defaults to the repository's
// checked-out branch: a checkout whose integration branch is `dev` must not be offered `main`.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  bindVerifiedTaskWorkspace,
  repairAndBindVerifiedTaskWorkspace,
  type VerifiedTaskWorkspaceBindFailure,
  type VerifiedTaskWorkspaceRepairOffer,
} from "@/lib/verified-task-workspace-binding";
import { fetchRepositoryBaseBranch } from "@/lib/task-workspace-api";
import { TASK_WORKSPACE_MARKER_MESSAGE_KEYS } from "@/lib/task-workspace-marker-labels";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
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

// The fallback when the repository's checked-out branch cannot be read (no repository at the path
// yet, a detached HEAD, a transport failure).
const DEFAULT_TARGET_BRANCH = "main";

type SetupPhase = "binding" | "repairing" | "verifying";
type SetupErrorReason =
  | "bind"
  | "verify"
  | "branch-conflict"
  | "invalid-base-branch"
  | "missing-repository"
  | "unsafe-path"
  | "lock-contention"
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
  // The Workbench-wide selected folder/repository is a convenience default only. It does not become
  // execution authority until this explicit provision → verify → activate action succeeds.
  readonly selectedRoot?: string | undefined;
  // ActiveWorkspaceApi.refresh from the shared context — re-reads the active binding after the
  // workbench-initiated bind so every bound surface flips to the new workspace atomically.
  readonly refreshWorkspace: () => Promise<boolean>;
  // The honest pre-activation posture. "unavailable" only once readiness has RESOLVED as
  // unavailable, "evaluation" once it has resolved as available over an unverified evaluation
  // runtime, "verified" otherwise — a still-pending readiness check stays "verified" so neither
  // note flashes during load. The bootstrap section is the FIRST screen a fresh evaluation install
  // shows, so a clean form here would imply a verified runtime (ADR-0163 D9).
  readonly runtimePosture: CodingWorkbenchSetupRuntimePosture;
}

export type CodingWorkbenchSetupRuntimePosture = "unavailable" | "evaluation" | "verified";

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
  INVALID_BASE_BRANCH: "invalid-base-branch",
  MISSING_REPOSITORY: "missing-repository",
  UNSAFE_PATH: "unsafe-path",
  LOCK_CONTENTION: "lock-contention",
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
async function settleBoundWorkspace(
  refreshWorkspace: () => Promise<boolean>,
): Promise<SetupStatus> {
  try {
    if (await refreshWorkspace()) return { kind: "idle" };
    reportClientDiagnostic("[keiko] coding workbench workspace refresh did not settle");
  } catch (error) {
    reportClientDiagnostic(
      `[keiko] coding workbench workspace refresh failed: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
  }
  return { kind: "error", reason: "bind" };
}

interface BindInput {
  readonly root: string;
  readonly baseBranch: string;
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly onPhase: (phase: SetupPhase) => void;
}

// Drive provision → reconcile → activate as one operator action. `onPhase` advances the surfaced
// pending phase from binding to verifying; every server error maps to a bounded outcome.
async function executeBind(input: BindInput): Promise<SetupStatus> {
  const result = await bindVerifiedTaskWorkspace({
    root: input.root,
    taskId: codingWorkbenchSetupTaskId(input.baseBranch),
    baseBranch: input.baseBranch,
    requestedBy: STUDIO_OPERATOR,
    onProvisioned: () => {
      input.onPhase("verifying");
    },
  });
  if (!result.ok) return failureStatus(result);
  return settleBoundWorkspace(input.refreshWorkspace);
}

interface RepairInput extends Omit<BindInput, "baseBranch"> {
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
  return settleBoundWorkspace(input.refreshWorkspace);
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

function useSetupActions(params: {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly status: SetupStatus;
  readonly setStatus: (status: SetupStatus) => void;
}): SetupActions {
  const { repositoryPath, targetBranch, refreshWorkspace, status, setStatus } = params;
  const root = repositoryPath.trim();
  const baseBranch = targetBranch.trim();
  const pending = status.kind === "pending";
  const onPhase = (phase: SetupPhase): void => {
    setStatus({ kind: "pending", phase });
  };
  const onSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (pending || root === "" || baseBranch === "") return;
    setStatus({ kind: "pending", phase: "binding" });
    settleOutcome(executeBind({ root, baseBranch, refreshWorkspace, onPhase }), setStatus);
  };
  const onRepair = (): void => {
    const offer = status.kind === "error" ? status.repair : undefined;
    const strategy = offer?.strategy ?? null;
    if (pending || root === "" || offer === undefined || strategy === null) return;
    setStatus({ kind: "pending", phase: "repairing" });
    settleOutcome(
      executeRepairAndBind({
        root,
        workspaceId: offer.workspaceId,
        strategy,
        refreshWorkspace,
        onPhase,
      }),
      setStatus,
    );
  };
  return { onSubmit, onRepair };
}

interface TargetBranchState {
  readonly targetBranch: string;
  // The operator's own choice; it wins over every lookup from here on.
  readonly chooseTargetBranch: (value: string) => void;
  // Re-read the checked-out branch of `root` unless the operator already chose a branch.
  readonly lookupFor: (root: string) => void;
}

// The repository's checked-out branch as the default base branch. A value the operator typed wins
// over any lookup, including one that resolves later; a lookup that cannot answer (not a
// repository, detached HEAD) keeps the previous default, and only a transport failure is reported.
function useTargetBranchDefault(selectedRoot: string | undefined): TargetBranchState {
  const [targetBranch, setTargetBranch] = useState(DEFAULT_TARGET_BRANCH);
  const touchedRef = useRef(false);
  const lookupSeqRef = useRef(0);
  const lookupFor = useCallback((root: string): void => {
    const trimmed = root.trim();
    if (trimmed === "" || touchedRef.current) return;
    const seq = (lookupSeqRef.current += 1);
    fetchRepositoryBaseBranch(trimmed).then(
      (branch) => {
        if (seq !== lookupSeqRef.current || touchedRef.current || branch === null) return;
        setTargetBranch(branch);
      },
      (error: unknown) => {
        reportClientDiagnostic(
          `[keiko] coding workbench base branch lookup failed: ${clientErrorSummary(error)}`,
          { correlationId: correlationIdOf(error) },
        );
      },
    );
  }, []);
  // A branch typed for one repository is not a choice for the next: a new workbench-wide selection
  // re-arms the default the way the path field follows it.
  useEffect(() => {
    touchedRef.current = false;
    if (selectedRoot !== undefined) lookupFor(selectedRoot);
  }, [lookupFor, selectedRoot]);
  // A lookup that lands after unmount must not write into a surface that no longer exists.
  useEffect(
    () => (): void => {
      lookupSeqRef.current += 1;
    },
    [],
  );
  const chooseTargetBranch = useCallback((value: string): void => {
    touchedRef.current = true;
    setTargetBranch(value);
  }, []);
  return { targetBranch, chooseTargetBranch, lookupFor };
}

// The failure reasons whose sentence needs no interpolation.
const PLAIN_ALERT_KEYS: Readonly<Partial<Record<SetupErrorReason, CodingWorkbenchMessageKey>>> = {
  verify: "codingWorkbench.setup.reconcileFailed",
  "branch-conflict": "codingWorkbench.setup.branchConflict",
  "invalid-base-branch": "codingWorkbench.setup.invalidBaseBranch",
  "missing-repository": "codingWorkbench.setup.missingRepository",
  "unsafe-path": "codingWorkbench.setup.unsafePath",
  "lock-contention": "codingWorkbench.setup.lockContention",
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

function alertMessage(
  status: SetupError,
  t: CodingWorkbenchTranslate,
  tGlobal: I18nTranslate,
): string {
  const plain = PLAIN_ALERT_KEYS[status.reason];
  if (plain !== undefined) return t(plain);
  if (status.reason === "repair-required" || status.reason === "operator-required") {
    const key =
      status.reason === "repair-required"
        ? "codingWorkbench.setup.repairRequired"
        : "codingWorkbench.setup.operatorRequired";
    return t(key, { finding: findingLabel(status.repair, t, tGlobal) });
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

// The Workbench-wide selected folder is the path field's default: it follows a new selection only
// while the operator has not typed a different path (an empty field, or one still showing the
// previous selection, is not an operator's choice).
function useRepositoryPathDefault(
  selectedRoot: string | undefined,
): readonly [string, (value: string) => void] {
  const [repositoryPath, setRepositoryPath] = useState(selectedRoot ?? "");
  const previousSelectedRootRef = useRef(selectedRoot ?? "");
  useEffect(() => {
    const previousSelectedRoot = previousSelectedRootRef.current;
    const nextSelectedRoot = selectedRoot ?? "";
    previousSelectedRootRef.current = nextSelectedRoot;
    setRepositoryPath((current) =>
      current.trim() === "" || current === previousSelectedRoot ? nextSelectedRoot : current,
    );
  }, [selectedRoot]);
  return [repositoryPath, setRepositoryPath];
}

export function CodingWorkbenchSetup({
  selectedRoot,
  refreshWorkspace,
  runtimePosture,
}: CodingWorkbenchSetupProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [repositoryPath, setRepositoryPath] = useRepositoryPathDefault(selectedRoot);
  const branch = useTargetBranchDefault(selectedRoot);
  const [status, setStatus] = useState<SetupStatus>({ kind: "idle" });
  // A refusal — and the repair offer it may carry — belongs to the path it was answered for. When
  // the path moves on (typed, or following a new workbench-wide selection) the offer must not
  // survive it, or "Repair and bind" would apply the old workspace's repair under the new path.
  useEffect(() => {
    setStatus((current) => (current.kind === "error" ? { kind: "idle" } : current));
  }, [repositoryPath]);
  const pending = status.kind === "pending";
  const submitDisabled =
    pending || repositoryPath.trim() === "" || branch.targetBranch.trim() === "";
  const actions = useSetupActions({
    repositoryPath,
    targetBranch: branch.targetBranch,
    refreshWorkspace,
    status,
    setStatus,
  });

  return (
    <section className={styles.card} aria-label={t("codingWorkbench.setup.title")}>
      <PanelTitle eyebrow={t("codingWorkbench.setup.eyebrow")} id="coding-workbench-setup-title">
        {t("codingWorkbench.setup.title")}
      </PanelTitle>
      <SetupNotices runtimePosture={runtimePosture} status={status} t={t} />
      <form onSubmit={actions.onSubmit}>
        <SetupFields
          repositoryPath={repositoryPath}
          targetBranch={branch.targetBranch}
          pending={pending}
          onRepositoryPathChange={setRepositoryPath}
          onRepositoryPathSettled={branch.lookupFor}
          onTargetBranchChange={branch.chooseTargetBranch}
        />
        <p id="coding-workbench-setup-help" className={styles.helpText}>
          {t("codingWorkbench.setup.help")}
        </p>
        <SetupActionRow
          status={status}
          submitDisabled={submitDisabled}
          onRepair={actions.onRepair}
          t={t}
        />
      </form>
    </section>
  );
}

function SetupFields({
  repositoryPath,
  targetBranch,
  pending,
  onRepositoryPathChange,
  onRepositoryPathSettled,
  onTargetBranchChange,
}: {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly pending: boolean;
  readonly onRepositoryPathChange: (value: string) => void;
  // Fired when the operator leaves the path field, so the branch default follows a typed path
  // without a request per keystroke.
  readonly onRepositoryPathSettled: (value: string) => void;
  readonly onTargetBranchChange: (value: string) => void;
}): ReactNode {
  return (
    <>
      <RepositoryPathField
        value={repositoryPath}
        pending={pending}
        onChange={onRepositoryPathChange}
        onSettled={onRepositoryPathSettled}
      />
      <TargetBranchField value={targetBranch} pending={pending} onChange={onTargetBranchChange} />
    </>
  );
}

function RepositoryPathField({
  value,
  pending,
  onChange,
  onSettled,
}: {
  readonly value: string;
  readonly pending: boolean;
  readonly onChange: (value: string) => void;
  readonly onSettled: (value: string) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      <label className={styles.fieldLabel} htmlFor="coding-workbench-setup-path">
        {t("codingWorkbench.setup.repositoryPath")}
      </label>
      <input
        id="coding-workbench-setup-path"
        className={styles.setupInput}
        type="text"
        value={value}
        disabled={pending}
        placeholder={t("codingWorkbench.setup.repositoryPathPlaceholder")}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onBlur={(event) => {
          onSettled(event.target.value);
        }}
      />
    </>
  );
}

function TargetBranchField({
  value,
  pending,
  onChange,
}: {
  readonly value: string;
  readonly pending: boolean;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      <label className={styles.fieldLabel} htmlFor="coding-workbench-setup-branch">
        {t("codingWorkbench.setup.targetBranch")}
      </label>
      <input
        id="coding-workbench-setup-branch"
        className={styles.setupInput}
        type="text"
        value={value}
        disabled={pending}
        placeholder={t("codingWorkbench.setup.targetBranchPlaceholder")}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </>
  );
}
