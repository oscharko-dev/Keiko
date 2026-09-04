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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { WorkspaceRecoveryStrategy } from "@oscharko-dev/keiko-contracts";
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
  | "refresh"
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
//
// Its own reason, never `bind`: everything the server owns — provision, repair, reconcile, activate
// — has COMPLETED by the time this runs, so "The workspace could not be bound. Review the
// repository path and target branch." is the exact sentence this change exists to stop showing
// (#3381 review). A rapid folder switch or an overlapping bind is how an operator reaches it.
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
  return { kind: "error", reason: "refresh" };
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

// One operator action, together with the exact field values it was started for. A sequence may
// only write to the card while its own attempt is still the current one.
interface SetupAttempt {
  readonly id: number;
  readonly repositoryPath: string;
  readonly targetBranch: string;
}

// Publishes a status only while `attempt` is still the card's current attempt.
type SetupPublish = (status: SetupStatus) => void;

// A refusal — and the repair offer it may carry — belongs to BOTH inputs it was answered for: the
// path, and the target branch the refused task id is derived from (`codingWorkbenchSetupTaskId`).
// A PENDING attempt belongs to them just as much. Clearing only an existing error left the
// in-flight case open (#3381 review): the fields are disabled while pending, but the branch is not
// only typed — clicking Bind BLURS the path field, which arms the asynchronous base-branch lookup,
// and that lookup can replace the branch while provisioning is still running. The sequence would
// then publish its phase, its success, or a repair offer computed for the previous inputs, and a
// stale `main` repair offer would sit beside a `dev` field, one click away from repairing and
// activating the wrong workspace.
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

function useSetupActions(params: {
  readonly repositoryPath: string;
  readonly branch: TargetBranchState;
  readonly refreshWorkspace: () => Promise<boolean>;
  readonly status: SetupStatus;
  readonly setStatus: Dispatch<SetStateAction<SetupStatus>>;
}): SetupActions {
  const { repositoryPath, branch, refreshWorkspace, status, setStatus } = params;
  const targetBranch = branch.targetBranch;
  const root = repositoryPath.trim();
  const baseBranch = targetBranch.trim();
  const pending = status.kind === "pending";
  const attempt = useSetupAttempt({ repositoryPath, targetBranch, setStatus });
  const onSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (pending || root === "" || baseBranch === "") return;
    // The task id is derived from the target branch, so a branch that is not authoritative for
    // THIS path would provision and activate the previous repository's workspace (CodeRabbit
    // review of #3381). `lookupFor` runs on blur, and Enter submits without ever blurring the
    // field, so this is also the only place that can arm the missing lookup: the bind is refused
    // and re-armed until the answer for the path in the field has settled.
    if (!branch.settled) {
      if (!branch.resolving) branch.lookupFor(root);
      return;
    }
    const publish = attempt.start();
    publish({ kind: "pending", phase: "binding" });
    settleOutcome(
      executeBind({ root, baseBranch, refreshWorkspace, onPhase: phaseReporter(publish) }),
      publish,
    );
  };
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
        onPhase: phaseReporter(publish),
      }),
      publish,
    );
  };
  return { onSubmit, onRepair };
}

// The phase of an abandoned attempt is as stale as its outcome: it would re-disable the fields and
// claim "Verifying…" for inputs the card has already moved off.
function phaseReporter(publish: SetupPublish): (phase: SetupPhase) => void {
  return (phase: SetupPhase): void => {
    publish({ kind: "pending", phase });
  };
}

// Which repository path the target branch in the field is authoritative for. A branch the operator
// typed is their choice for whatever path they bind; a derived one belongs to the exact path whose
// lookup produced it; the initial fallback belongs to no path at all.
type BranchAuthority =
  | { readonly kind: "none" }
  | { readonly kind: "path"; readonly root: string }
  | { readonly kind: "operator" };

interface TargetBranchState {
  readonly targetBranch: string;
  // True once the field's branch is authoritative for the path being bound. Binding is refused
  // until then: the task id is derived from this branch, so an untouched default carried over from
  // the previous repository would provision and activate the wrong managed workspace.
  readonly settled: boolean;
  // A lookup is in flight for the path in the field.
  readonly resolving: boolean;
  // The operator's own choice; it wins over every lookup from here on.
  readonly chooseTargetBranch: (value: string) => void;
  // Re-read the checked-out branch of `root` unless the operator already chose a branch.
  readonly lookupFor: (root: string) => void;
}

// The repository's checked-out branch as the default base branch. A value the operator typed wins
// over any lookup, including one that resolves later; a lookup that cannot answer (not a
// repository, detached HEAD) keeps the previous default, and only a transport failure is reported.
//
// The default belongs to the repository in the PATH FIELD — the one a bind would actually
// provision — not to the workbench-wide selection. Re-arming on every selection change read the
// branch of a repository that is not being bound and overwrote a branch the operator had typed for
// the one that is (#3381 review): with a typed path the field does not follow the switcher, so the
// bind still targeted the typed path while the branch had silently become the other checkout's.
function useTargetBranchDefault(
  selectedRoot: string | undefined,
  repositoryPath: string,
): TargetBranchState {
  const lookup = useBranchLookup();
  const { lookupFor, releaseOperatorChoice } = lookup;
  // A branch typed for one repository is not a choice for the next, and "the next" is decided by
  // the path field: re-arm only once it has FOLLOWED the new selection. A selection the field does
  // not follow (the operator typed a different path) leaves both the branch and the touched state
  // alone, and a path being typed is not settled — its own blur handler drives that lookup, so
  // this never fires a request per keystroke.
  const armedRootRef = useRef<string | null>(null);
  useEffect(() => {
    const selected = selectedRoot ?? "";
    if (selected.trim() === "" || repositoryPath !== selected) return;
    if (armedRootRef.current === selected) return;
    armedRootRef.current = selected;
    releaseOperatorChoice();
    lookupFor(selected);
  }, [lookupFor, releaseOperatorChoice, repositoryPath, selectedRoot]);
  return {
    targetBranch: lookup.targetBranch,
    settled: !lookup.resolving && authoritativeFor(lookup.authority, repositoryPath.trim()),
    resolving: lookup.resolving,
    chooseTargetBranch: lookup.chooseTargetBranch,
    lookupFor,
  };
}

interface BranchLookup {
  readonly targetBranch: string;
  readonly authority: BranchAuthority;
  readonly resolving: boolean;
  readonly lookupFor: (root: string) => void;
  readonly chooseTargetBranch: (value: string) => void;
  // Drops the operator's claim so the next selection may derive its own default again.
  readonly releaseOperatorChoice: () => void;
}

// The branch value together with the evidence of where it came from. Nothing here knows about the
// workbench-wide selection: it answers only "what is in the field, and for which path is it true".
function useBranchLookup(): BranchLookup {
  const [targetBranch, setTargetBranch] = useState(DEFAULT_TARGET_BRANCH);
  const [authority, setAuthority] = useState<BranchAuthority>({ kind: "none" });
  const [resolving, setResolving] = useState(false);
  const touchedRef = useRef(false);
  const lookupSeqRef = useRef(0);
  // Every SETTLED lookup — a branch, a path that cannot answer one (no repository, detached HEAD),
  // or a transport failure — makes the field authoritative for the path it was issued for: the
  // fallback then belongs to this path instead of being the previous repository's branch, and the
  // card is never locked out of binding by a lookup that could not answer. A superseded lookup
  // settles nothing, and an operator who typed a branch meanwhile keeps it.
  const settleLookup = useCallback((seq: number, root: string, branch: string | null): void => {
    if (seq !== lookupSeqRef.current) return;
    setResolving(false);
    if (touchedRef.current) return;
    setAuthority({ kind: "path", root });
    // A path that cannot name a branch falls back to the DEFAULT — never to the branch the previous
    // repository answered, which would bind this path with that repository's base and derive the
    // task id from it (CodeRabbit, PR #3381).
    setTargetBranch(branch ?? DEFAULT_TARGET_BRANCH);
  }, []);
  const lookupFor = useCallback(
    (root: string): void => {
      const trimmed = root.trim();
      if (trimmed === "" || touchedRef.current) return;
      const seq = (lookupSeqRef.current += 1);
      setAuthority({ kind: "none" });
      setResolving(true);
      void readBaseBranch(trimmed).then((branch) => {
        settleLookup(seq, trimmed, branch);
      });
    },
    [settleLookup],
  );
  // A lookup that lands after unmount must not write into a surface that no longer exists.
  useEffect(
    () => (): void => {
      lookupSeqRef.current += 1;
    },
    [],
  );
  const chooseTargetBranch = useCallback((value: string): void => {
    touchedRef.current = true;
    setAuthority({ kind: "operator" });
    setResolving(false);
    setTargetBranch(value);
  }, []);
  const releaseOperatorChoice = useCallback((): void => {
    touchedRef.current = false;
  }, []);
  return {
    targetBranch,
    authority,
    resolving,
    lookupFor,
    chooseTargetBranch,
    releaseOperatorChoice,
  };
}

// The lookup reduced to its one settled answer: the repository's checked-out branch, or null for
// every path that cannot name one — no repository, a detached HEAD, or a transport failure, which
// is the only one of the three that leaves a diagnostic.
function readBaseBranch(root: string): Promise<string | null> {
  return fetchRepositoryBaseBranch(root).catch((error: unknown) => {
    reportClientDiagnostic(
      `[keiko] coding workbench base branch lookup failed: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
    return null;
  });
}

function authoritativeFor(authority: BranchAuthority, root: string): boolean {
  if (authority.kind === "operator") return true;
  return authority.kind === "path" && authority.root === root;
}

// The failure reasons whose sentence needs no interpolation.
const PLAIN_ALERT_KEYS: Readonly<Partial<Record<SetupErrorReason, CodingWorkbenchMessageKey>>> = {
  refresh: "codingWorkbench.setup.boundRefreshFailed",
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
  const branch = useTargetBranchDefault(selectedRoot, repositoryPath);
  const [status, setStatus] = useState<SetupStatus>({ kind: "idle" });
  const pending = status.kind === "pending";
  // A branch lookup in flight is the one wait this card imposes on the operator: until it settles,
  // the field's branch belongs to another path (or to nothing), and binding it would derive the
  // task id from the wrong repository's default.
  const submitDisabled =
    pending ||
    branch.resolving ||
    repositoryPath.trim() === "" ||
    branch.targetBranch.trim() === "";
  const actions = useSetupActions({
    repositoryPath,
    branch,
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
