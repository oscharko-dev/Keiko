"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useGitHubIssueReaderAuthorization } from "../../hooks/useGitHubIssueReaderAuthorization";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { IssueIntakeState } from "./useCodingWorkbenchIssueIntake";
import styles from "./CodingWorkbenchIssueIntake.module.css";
import workbenchStyles from "./CodingWorkbenchWindow.module.css";

const ALERT_ID = "coding-workbench-issue-failure";

export function CodingWorkbenchIssueIntake({
  state,
  onCancel,
  onRetry,
  repositoryPath,
}: {
  readonly state: IssueIntakeState;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly repositoryPath: string;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.kind === "failed") alert.current?.focus();
  }, [state]);
  if (state.kind === "empty") return null;
  if (state.kind === "loading")
    return (
      <div className={styles["cmp-issue-actions"]}>
        <output>{t("codingWorkbench.issue.resolving")}</output>
        <button type="button" className={workbenchStyles.button} onClick={onCancel}>
          {t("codingWorkbench.issue.cancel")}
        </button>
      </div>
    );
  return (
    <div className={styles["cmp-issue-feedback"]}>
      <p
        id={ALERT_ID}
        ref={alert}
        role="alert"
        tabIndex={-1}
        className={styles["cmp-issue-alert"]}
        data-failure={state.failure}
        data-testid="coding-workbench-issue-alert"
      >
        {t(`codingWorkbench.issue.error.${state.failure}`)}
        <IssueSupportId correlationId={state.correlationId} />
      </p>
      <button type="button" className={workbenchStyles.button} onClick={onRetry}>
        {t("codingWorkbench.issue.retry")}
      </button>
      {state.failure === "auth-required" ? (
        <GitHubIssueAccessGrant repositoryPath={repositoryPath} />
      ) : null}
    </div>
  );
}

function IssueSupportId({
  correlationId,
}: {
  readonly correlationId: string | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return correlationId === undefined ? null : (
    <span className={styles["cmp-issue-support"]}>
      {t("codingWorkbench.issue.supportId", { correlationId })}
    </span>
  );
}

function GitHubIssueAccessGrant({
  repositoryPath,
}: {
  readonly repositoryPath: string;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const path = repositoryPath.trim();
  const grant = useGitHubIssueReaderAuthorization(path === "" ? null : path);
  if (path === "" || grant.authorized) return null;
  return (
    <div className={styles["cmp-issue-actions"]} data-testid="coding-workbench-issue-grant">
      <button
        type="button"
        className={workbenchStyles.button}
        disabled={grant.pending}
        aria-describedby={ALERT_ID}
        onClick={() => grant.change(true)}
      >
        {t("codingWorkbench.issue.enableAccess")}
      </button>
      {grant.error === null ? null : (
        <p
          className={styles["cmp-issue-alert"]}
          role="alert"
          data-testid="coding-workbench-issue-grant-error"
        >
          {t(`codingWorkbench.githubAccess.error.${grant.error}`)}
        </p>
      )}
    </div>
  );
}
