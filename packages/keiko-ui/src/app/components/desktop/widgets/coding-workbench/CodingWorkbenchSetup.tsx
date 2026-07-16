"use client";

// Minimal Code setup for the Coding Workbench (Issue #2385). Rendered only while the coding
// runtime reports available but no active task-workspace binding exists: it binds an EXISTING
// local Git checkout by provisioning a managed task workspace from the entered repository root
// (#445), setting it as the active binding (#446 active pointer), and refreshing the shared
// active-workspace context so the regular task-start flow unlocks. It reuses the same
// task-workspace client calls the TaskWorkspaceSwitcher state machine issues (provision →
// set-active → re-read) and surfaces failures as a content-free alert.

import { useState, type ReactNode } from "react";
import { provisionTaskWorkspace, setActiveTaskWorkspace } from "@/lib/task-workspace-api";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import { cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

// The opaque single-operator actor identity, mirroring useActiveWorkspaceState. The server treats
// it as an opaque id only — never a credential.
const STUDIO_OPERATOR = "studio-operator";

const DEFAULT_TARGET_BRANCH = "main";

type SetupStatus = "idle" | "pending" | "error";

export interface CodingWorkbenchSetupProps {
  // ActiveWorkspaceApi.refresh from the shared context — re-reads the active binding after the
  // workbench-initiated bind so every bound surface flips to the new workspace atomically.
  readonly refreshWorkspace: (root: string) => Promise<void>;
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

// Provision (create or idempotently resume) the managed workspace, set the active pointer, then
// refresh the shared context — the same wire sequence the existing binding UI drives through
// useActiveWorkspaceState, scoped to this one bootstrap flow.
async function bindWorkspace(
  root: string,
  baseBranch: string,
  refreshWorkspace: (root: string) => Promise<void>,
): Promise<void> {
  const provisioned = await provisionTaskWorkspace({
    root,
    taskId: codingWorkbenchSetupTaskId(baseBranch),
    baseBranch,
    requestedBy: STUDIO_OPERATOR,
  });
  await setActiveTaskWorkspace({
    workspaceId: provisioned.instance.workspaceId,
    requestedBy: STUDIO_OPERATOR,
  });
  await refreshWorkspace(root);
}

export function CodingWorkbenchSetup({ refreshWorkspace }: CodingWorkbenchSetupProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [repositoryPath, setRepositoryPath] = useState("");
  const [targetBranch, setTargetBranch] = useState(DEFAULT_TARGET_BRANCH);
  const [status, setStatus] = useState<SetupStatus>("idle");
  const pending = status === "pending";
  const submitDisabled = pending || repositoryPath.trim() === "" || targetBranch.trim() === "";

  const onSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (submitDisabled) return;
    setStatus("pending");
    bindWorkspace(repositoryPath.trim(), targetBranch.trim(), refreshWorkspace).then(
      () => {
        setStatus("idle");
      },
      () => {
        // Server errors stay content-free in the UI: the alert below carries only the fixed,
        // localized guidance; the redacted diagnostic remains server-side.
        setStatus("error");
      },
    );
  };

  return (
    <section className={styles.card} aria-label={t("codingWorkbench.setup.title")}>
      <PanelTitle eyebrow={t("codingWorkbench.setup.eyebrow")} id="coding-workbench-setup-title">
        {t("codingWorkbench.setup.title")}
      </PanelTitle>
      {status === "error" ? (
        <p className={styles.alert} role="alert">
          <span aria-hidden="true">!</span> {t("codingWorkbench.alert.workspaceBindFailed")}
        </p>
      ) : null}
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
          {pending ? t("codingWorkbench.setup.binding") : t("codingWorkbench.setup.submit")}
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
