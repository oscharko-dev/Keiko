"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchVerificationPreview } from "@oscharko-dev/keiko-contracts";
import type { UseCodingWorkbenchApprovalReviewResult } from "@/lib/useCodingWorkbenchApprovalReview";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { cx } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

const DEFERRED_KEYS = {
  "targeted-test": "codingWorkbench.approval.verification.deferred.targeted-test",
  "package-selection": "codingWorkbench.approval.verification.deferred.package-selection",
} as const satisfies Record<string, CodingWorkbenchMessageKey>;

function noteKey(
  state: UseCodingWorkbenchApprovalReviewResult,
  preview: CodingWorkbenchVerificationPreview | undefined,
): CodingWorkbenchMessageKey | null {
  if (preview?.status === "deferred") return DEFERRED_KEYS[preview.reason];
  if (preview?.status === "commands") return null;
  return state.status === "loading"
    ? "codingWorkbench.approval.verification.loading"
    : "codingWorkbench.approval.verification.unavailable";
}

/**
 * What Approve runs for a governed verification (ADR-0124 D6): the command lines the runner would
 * run, shown as text on the authenticated review channel's projection. Never empty: a targeted
 * test, an unresolved package or a failed lookup each say so in a plain sentence, and Approve is
 * never blocked by the lookup, because the kind of check is still named on the card.
 */
export function CodingWorkbenchVerificationPreviewReview({
  state,
  t,
}: {
  readonly state: UseCodingWorkbenchApprovalReviewResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const preview = state.review?.verificationPreview;
  const note = noteKey(state, preview);
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.verification.title")}
    >
      {preview?.status === "commands" ? (
        <>
          <ul
            className={cx(styles["cmp-approval-commit-message"], styles.approvalChangedFiles)}
            aria-label={t("codingWorkbench.approval.verification.commands")}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded project text must be keyboard-scrollable
            tabIndex={0}
          >
            {preview.commands.map((command, index) => (
              <li
                className={cx(styles.approvalChangedFile, styles["cmp-approval-native-resource"])}
                key={`${String(index)}:${command}`}
              >
                {command}
              </li>
            ))}
          </ul>
          <p className={styles.approvalResearchDetail}>
            {t("codingWorkbench.approval.verification.help")}
          </p>
          {preview.truncated ? (
            <p className={styles.approvalResearchDetail}>
              {t("codingWorkbench.approval.verification.truncated")}
            </p>
          ) : null}
        </>
      ) : null}
      {note === null ? null : <p className={styles.approvalResearchDetail}>{t(note)}</p>}
    </fieldset>
  );
}
