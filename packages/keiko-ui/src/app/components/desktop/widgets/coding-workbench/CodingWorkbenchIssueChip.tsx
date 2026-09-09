"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { AcceptedWorkbenchIssue } from "./useCodingWorkbenchIssueIntake";
import styles from "./CodingWorkbenchIssueIntake.module.css";
import workbenchStyles from "./CodingWorkbenchWindow.module.css";

export function CodingWorkbenchIssueChip({
  accepted,
  snapshot,
  onRemove,
}: {
  readonly accepted: AcceptedWorkbenchIssue | null;
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | null;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const bound = snapshot?.issueBinding;
  if (bound === undefined && accepted === null) return null;
  const binding = bound ?? accepted?.binding;
  if (binding === undefined) return null;
  const label =
    accepted?.binding.bindingDigest === binding.bindingDigest
      ? accepted.label
      : `#${String(binding.issueNumber)}`;
  return (
    <output
      className={styles["cmp-issue-chip"]}
      data-testid="coding-workbench-composer-issue"
      data-binding-digest={binding.bindingDigest}
    >
      <span>
        {t("codingWorkbench.issue.accepted", { issue: label, baseRef: binding.defaultBaseRef })}
      </span>
      {bound === undefined ? (
        <button
          type="button"
          className={workbenchStyles.button}
          aria-label={t("codingWorkbench.composer.issue.remove", { issue: label })}
          onClick={() => {
            reportClientDiagnostic("[keiko] coding workbench issue removed before start");
            onRemove();
          }}
        >
          {t("codingWorkbench.issue.remove")}
        </button>
      ) : null}
    </output>
  );
}
