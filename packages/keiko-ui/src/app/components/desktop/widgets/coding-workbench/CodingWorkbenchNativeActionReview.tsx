"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchNativeActionReview } from "@oscharko-dev/keiko-contracts";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import styles from "./CodingWorkbenchWindow.module.css";

const PERMISSION_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  shell: "codingWorkbench.approval.native.permission.shell",
  edit: "codingWorkbench.approval.native.permission.edit",
  write: "codingWorkbench.approval.native.permission.write",
  patch: "codingWorkbench.approval.native.permission.patch",
  webfetch: "codingWorkbench.approval.native.permission.webfetch",
  websearch: "codingWorkbench.approval.native.permission.websearch",
  execute: "codingWorkbench.approval.native.permission.execute",
};

const NATIVE_LABEL_MESSAGE_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  "native-shell": "codingWorkbench.approval.native.label.native-shell",
  "native-edit": "codingWorkbench.approval.native.label.native-edit",
  "native-egress": "codingWorkbench.approval.native.label.native-egress",
  "native-execute": "codingWorkbench.approval.native.label.native-execute",
  "native-read": "codingWorkbench.approval.native.label.native-read",
};

/** The localized name of a native policy ask's closed command label, or the label itself. */
export function nativeActionLabel(label: string, t: CodingWorkbenchTranslate): string {
  const key = NATIVE_LABEL_MESSAGE_KEYS[label];
  return key === undefined ? label : t(key);
}

/**
 * The native OpenCode action a pending approval would run (#3897): the agent's own command line,
 * URL or paths, shown so the human decides about the real action. Model-selected text rendered as
 * text, never markup; it rides the authenticated review channel only.
 */
export function CodingWorkbenchNativeActionReview({
  action,
  t,
}: {
  readonly action: CodingWorkbenchNativeActionReview;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const title = t("codingWorkbench.approval.native.title");
  const permission = t(
    PERMISSION_MESSAGE_KEYS[action.permission] ??
      "codingWorkbench.approval.native.permission.other",
  );
  return (
    <fieldset className={styles.approvalResearch} aria-label={title}>
      <p className={styles.approvalResearchTitle}>
        {title}: {permission}
      </p>
      {action.resources.length === 0 ? (
        <p className={styles.approvalResearchDetail}>
          {t("codingWorkbench.approval.native.noResources")}
        </p>
      ) : (
        <ul className={styles.approvalChangedFiles}>
          {action.resources.map((resource, index) => (
            <li className={styles.approvalChangedFile} key={`${String(index)}:${resource}`}>
              {resource}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.approvalResearchDetail}>{t("codingWorkbench.approval.native.help")}</p>
    </fieldset>
  );
}
