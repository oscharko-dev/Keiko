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

import { useState, type ReactNode } from "react";
import { bindVerifiedTaskWorkspace } from "@/lib/verified-task-workspace-binding";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import { cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

// The opaque single-operator actor identity, mirroring useActiveWorkspaceState. The server treats
// it as an opaque id only — never a credential.
const STUDIO_OPERATOR = "studio-operator";

const DEFAULT_TARGET_BRANCH = "main";

type SetupPhase = "binding" | "verifying";
type SetupErrorReason = "bind" | "verify";
type SetupStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly phase: SetupPhase }
  | { readonly kind: "error"; readonly reason: SetupErrorReason };

// The outcome of the end-to-end bind sequence. `verify-failed` is kept distinct from `bind-failed` so
// the surface can explain that reconciliation did not confirm the checkout (vs a provisioning or
// activation failure), while both stay content-free.
type BindOutcome = "ok" | "bind-failed" | "verify-failed";

export interface CodingWorkbenchSetupProps {
  // ActiveWorkspaceApi.refresh from the shared context — re-reads the active binding after the
  // workbench-initiated bind so every bound surface flips to the new workspace atomically.
  readonly refreshWorkspace: (root: string) => Promise<void>;
  // True only once runtime readiness has RESOLVED as unavailable — drives the honest pre-activation
  // note. A still-pending readiness check keeps this false so the note never flashes during load.
  readonly runtimeUnavailable: boolean;
}

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

// Drive provision → reconcile → activate as one operator action. `onPhase` advances the surfaced
// pending phase from binding to verifying; every server error maps to a bounded, content-free outcome.
async function executeBind(input: {
  readonly root: string;
  readonly baseBranch: string;
  readonly refreshWorkspace: (root: string) => Promise<void>;
  readonly onPhase: (phase: SetupPhase) => void;
}): Promise<BindOutcome> {
  const result = await bindVerifiedTaskWorkspace({
    root: input.root,
    taskId: codingWorkbenchSetupTaskId(input.baseBranch),
    baseBranch: input.baseBranch,
    requestedBy: STUDIO_OPERATOR,
    onProvisioned: () => input.onPhase("verifying"),
  });
  if (!result.ok) return result.stage === "verify" ? "verify-failed" : "bind-failed";
  try {
    await input.refreshWorkspace(input.root);
    return "ok";
  } catch {
    return "bind-failed";
  }
}

function createBindSubmitHandler(params: {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly submitDisabled: boolean;
  readonly refreshWorkspace: (root: string) => Promise<void>;
  readonly setStatus: (status: SetupStatus) => void;
}): (event: { preventDefault: () => void }) => void {
  return (event) => {
    event.preventDefault();
    if (params.submitDisabled) return;
    params.setStatus({ kind: "pending", phase: "binding" });
    void executeBind({
      root: params.repositoryPath.trim(),
      baseBranch: params.targetBranch.trim(),
      refreshWorkspace: params.refreshWorkspace,
      onPhase: (phase) => params.setStatus({ kind: "pending", phase }),
    }).then((outcome) => {
      params.setStatus(
        outcome === "ok"
          ? { kind: "idle" }
          : { kind: "error", reason: outcome === "verify-failed" ? "verify" : "bind" },
      );
    });
  };
}

function alertMessage(reason: SetupErrorReason, t: CodingWorkbenchTranslate): string {
  // Verify failures point at reconciliation; bind failures reuse the existing provisioning copy.
  return reason === "verify"
    ? t("codingWorkbench.setup.reconcileFailed")
    : t("codingWorkbench.alert.workspaceBindFailed");
}

function submitLabel(status: SetupStatus, t: CodingWorkbenchTranslate): string {
  if (status.kind !== "pending") return t("codingWorkbench.setup.submit");
  return status.phase === "verifying"
    ? t("codingWorkbench.setup.verifying")
    : t("codingWorkbench.setup.binding");
}

function SetupNotices({
  runtimeUnavailable,
  status,
  t,
}: {
  readonly runtimeUnavailable: boolean;
  readonly status: SetupStatus;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      {runtimeUnavailable ? (
        <p className={styles.boundaryNote} data-testid="coding-workbench-setup-runtime-note">
          {t("codingWorkbench.setup.runtimeUnavailable")}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className={styles.alert} role="alert">
          <span aria-hidden="true">!</span> {alertMessage(status.reason, t)}
        </p>
      ) : null}
    </>
  );
}

export function CodingWorkbenchSetup({
  refreshWorkspace,
  runtimeUnavailable,
}: CodingWorkbenchSetupProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [repositoryPath, setRepositoryPath] = useState("");
  const [targetBranch, setTargetBranch] = useState(DEFAULT_TARGET_BRANCH);
  const [status, setStatus] = useState<SetupStatus>({ kind: "idle" });
  const pending = status.kind === "pending";
  const submitDisabled = pending || repositoryPath.trim() === "" || targetBranch.trim() === "";
  const onSubmit = createBindSubmitHandler({
    repositoryPath,
    targetBranch,
    submitDisabled,
    refreshWorkspace,
    setStatus,
  });

  return (
    <section className={styles.card} aria-label={t("codingWorkbench.setup.title")}>
      <PanelTitle eyebrow={t("codingWorkbench.setup.eyebrow")} id="coding-workbench-setup-title">
        {t("codingWorkbench.setup.title")}
      </PanelTitle>
      <SetupNotices runtimeUnavailable={runtimeUnavailable} status={status} t={t} />
      <form onSubmit={onSubmit}>
        <SetupFields
          repositoryPath={repositoryPath}
          targetBranch={targetBranch}
          pending={pending}
          onRepositoryPathChange={setRepositoryPath}
          onTargetBranchChange={setTargetBranch}
        />
        <p id="coding-workbench-setup-help" className={styles.helpText}>
          {t("codingWorkbench.setup.help")}
        </p>
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="submit"
          disabled={submitDisabled}
          aria-describedby="coding-workbench-setup-help"
        >
          {submitLabel(status, t)}
        </button>
      </form>
    </section>
  );
}

function SetupFields({
  repositoryPath,
  targetBranch,
  pending,
  onRepositoryPathChange,
  onTargetBranchChange,
}: {
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly pending: boolean;
  readonly onRepositoryPathChange: (value: string) => void;
  readonly onTargetBranchChange: (value: string) => void;
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
        value={repositoryPath}
        disabled={pending}
        placeholder={t("codingWorkbench.setup.repositoryPathPlaceholder")}
        onChange={(event) => {
          onRepositoryPathChange(event.target.value);
        }}
      />
      <label className={styles.fieldLabel} htmlFor="coding-workbench-setup-branch">
        {t("codingWorkbench.setup.targetBranch")}
      </label>
      <input
        id="coding-workbench-setup-branch"
        className={styles.setupInput}
        type="text"
        value={targetBranch}
        disabled={pending}
        placeholder={t("codingWorkbench.setup.targetBranchPlaceholder")}
        onChange={(event) => {
          onTargetBranchChange(event.target.value);
        }}
      />
    </>
  );
}
